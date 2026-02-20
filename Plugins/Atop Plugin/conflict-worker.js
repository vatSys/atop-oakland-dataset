/**
 * Conflict Calculation Web Worker
 * Offloads heavy O(n²) conflict detection from vatSys plugin
 * 
 * Per FAA ATOP spec Algorithm Specifications
 */

// Store FDRs indexed by callsign
const fdrs = new Map();
let conflictCheckInterval = null;

// Configuration per spec Section 6.2 and Appendix A.3.82
const CONFIG = {
    checkIntervalMs: 5000, // Check conflicts every 5 seconds
    advisoryThresholdHours: 2,      // Advisory: > 30 min, <= 2 hours
    imminentThresholdMinutes: 30,   // Imminent: > 1 min, <= 30 min
    actualThresholdMinutes: 1,      // Actual: <= 1 min
    
    // Track angle thresholds per spec Appendix A.3.82 DIR_TYPE
    // Same: |θ| < 45° (strictly less than)
    // Reciprocal: |θ| > 135° (strictly greater than)  
    // Crossing: 45° ≤ |θ| ≤ 135°
    sameTrackMaxAngle: 45,          // Exclusive: angle must be < 45 for Same
    reciprocalMinAngle: 135         // Exclusive: angle must be > 135 for Reciprocal
};

// Message handler
self.onmessage = function(e) {
    const { type, data } = e.data;
    
    switch (type) {
        case 'updateFDR':
            updateFDR(data);
            break;
        case 'removeFDR':
            fdrs.delete(data.callsign);
            break;
        case 'bulkUpdateFDRs':
            bulkUpdateFDRs(data);
            break;
        case 'requestProbe':
            const conflicts = probeAllConflicts();
            self.postMessage({ type: 'conflictResults', data: conflicts });
            break;
        case 'setConfig':
            Object.assign(CONFIG, data);
            break;
        case 'start':
            startConflictChecking();
            break;
        case 'stop':
            stopConflictChecking();
            break;
    }
};

function startConflictChecking() {
    if (conflictCheckInterval) return;
    conflictCheckInterval = setInterval(() => {
        const conflicts = probeAllConflicts();
        self.postMessage({ type: 'conflictResults', data: conflicts });
    }, CONFIG.checkIntervalMs);
}

function stopConflictChecking() {
    if (conflictCheckInterval) {
        clearInterval(conflictCheckInterval);
        conflictCheckInterval = null;
    }
}

function updateFDR(fdrData) {
    fdrs.set(fdrData.callsign, {
        ...fdrData,
        parsedRoute: parseRoute(fdrData.route, fdrData.routeWaypoints),
        updatedAt: Date.now()
    });
}

function bulkUpdateFDRs(fdrList) {
    // Clear stale FDRs
    const currentCallsigns = new Set(fdrList.map(f => f.callsign));
    for (const callsign of fdrs.keys()) {
        if (!currentCallsigns.has(callsign)) {
            fdrs.delete(callsign);
        }
    }
    // Update all
    fdrList.forEach(fdr => updateFDR(fdr));
}

function parseRoute(routeString, waypoints) {
    // If waypoints already provided as lat/lon array, use them
    if (waypoints && waypoints.length > 0) {
        return waypoints.map(wp => ({
            name: wp.name,
            lat: wp.lat,
            lon: wp.lon,
            eto: wp.eto ? new Date(wp.eto) : null
        }));
    }
    return [];
}

// ============================================
// CONFLICT DETECTION ALGORITHMS
// ============================================

function probeAllConflicts() {
    const allConflicts = [];
    const fdrArray = Array.from(fdrs.values());
    
    // Filter to only active FDRs
    const activeFdrs = fdrArray.filter(fdr => 
        fdr.state !== 'INACTIVE' && 
        fdr.state !== 'PREACTIVE' && 
        fdr.state !== 'FINISHED' &&
        fdr.parsedRoute.length >= 2
    );
    
    // O(n²) comparison but in worker thread
    for (let i = 0; i < activeFdrs.length; i++) {
        for (let j = i + 1; j < activeFdrs.length; j++) {
            const conflict = checkConflict(activeFdrs[i], activeFdrs[j]);
            if (conflict) {
                allConflicts.push(conflict);
            }
        }
    }
    
    return groupConflicts(allConflicts);
}

function checkConflict(fdr1, fdr2) {
    // 1. Temporal Test
    if (!passesTemporalTest(fdr1, fdr2)) {
        return null;
    }
    
    // 2. Vertical Test
    const verticalSep = getVerticalMinima(fdr1, fdr2);
    const verticalAct = getAltitudeDifference(fdr1, fdr2);
    if (verticalAct >= verticalSep) {
        return null;
    }
    
    // 3. Lateral Bounding Box Test (quick filter)
    if (!rectanglesOverlap(fdr1, fdr2)) {
        return null;
    }
    
    // 4. Detailed Lateral Conflict Check
    const latSep = getLateralMinima(fdr1, fdr2);
    const conflictSegments = calculateAreaOfConflict(fdr1, fdr2, latSep);
    
    if (conflictSegments.length === 0) {
        return null;
    }
    
    // Sort by start time
    conflictSegments.sort((a, b) => a.startTime - b.startTime);
    const firstConflict = conflictSegments[0];
    
    // 5. Longitudinal Separation Check
    const longTimeSep = getLongitudinalTimeMinima(fdr1, fdr2);
    const longTimeAct = Math.abs(firstConflict.endTime - firstConflict.startTime);
    const longDistSep = getLongitudinalDistanceMinima(fdr1, fdr2);
    const longDistAct = calculateDistance(firstConflict.startLatLon, firstConflict.endLatLon);
    
    const lossOfSep = longTimeAct < longTimeSep || longDistAct < longDistSep;
    if (!lossOfSep) {
        return null;
    }
    
    // 6. Determine Conflict Status
    const now = Date.now();
    const timeUntilLOS = Math.abs(firstConflict.startTime - now);
    
    let status;
    if (timeUntilLOS < CONFIG.actualThresholdMinutes * 60000) {
        status = 'Actual';
    } else if (timeUntilLOS <= CONFIG.imminentThresholdMinutes * 60000) {
        status = 'Imminent';
    } else if (timeUntilLOS <= CONFIG.advisoryThresholdHours * 3600000) {
        status = 'Advisory';
    } else {
        return null; // Too far in future
    }
    
    // Calculate track angle using proper method
    const trkAngle = calculateTrackAngle(fdr1, fdr2);
    
    return {
        intruderCallsign: fdr1.callsign,
        activeCallsign: fdr2.callsign,
        status: status,
        conflictType: determineConflictType(trkAngle),
        earliestLos: new Date(firstConflict.startTime).toISOString(),
        latestLos: new Date(firstConflict.endTime).toISOString(),
        latSep: latSep,
        verticalSep: verticalSep,
        verticalAct: verticalAct,
        trkAngle: trkAngle,
        longTimeAct: longTimeAct,
        longDistAct: longDistAct
    };
}

// ============================================
// GEOMETRIC CALCULATIONS
// ============================================

function passesTemporalTest(fdr1, fdr2) {
    const start1 = fdr1.atd ? new Date(fdr1.atd).getTime() : 0;
    const end1 = fdr1.parsedRoute.length > 0 && fdr1.parsedRoute[fdr1.parsedRoute.length - 1].eto
        ? new Date(fdr1.parsedRoute[fdr1.parsedRoute.length - 1].eto).getTime()
        : Date.now() + 24 * 3600000;
    
    const start2 = fdr2.atd ? new Date(fdr2.atd).getTime() : 0;
    const end2 = fdr2.parsedRoute.length > 0 && fdr2.parsedRoute[fdr2.parsedRoute.length - 1].eto
        ? new Date(fdr2.parsedRoute[fdr2.parsedRoute.length - 1].eto).getTime()
        : Date.now() + 24 * 3600000;
    
    return !(start1 > end2 || start2 > end1);
}

function getAltitudeDifference(fdr1, fdr2) {
    const alt1 = fdr1.cfl || fdr1.rfl || 0;
    const alt2 = fdr2.cfl || fdr2.rfl || 0;
    return Math.abs(alt1 - alt2);
}

function getVerticalMinima(fdr1, fdr2) {
    // Per spec Section 6.2.4.1 - Vertical Separation Standards
    const alt1 = fdr1.cfl || fdr1.rfl || 0;
    const alt2 = fdr2.cfl || fdr2.rfl || 0;
    const maxAlt = Math.max(alt1, alt2);
    
    // Above FL600 - 5000ft (military operations)
    if (maxAlt > 600) {
        return 5000;
    }
    
    // Above FL450 - 4000ft (supersonic separation)
    if (maxAlt > 450) {
        return 4000;
    }
    
    // RVSM airspace (FL290 - FL410) - 1000ft
    if (maxAlt >= 290 && maxAlt <= 410) {
        // Check if both aircraft are RVSM approved
        const rvsm1 = fdr1.rvsmApproved !== false;
        const rvsm2 = fdr2.rvsmApproved !== false;
        
        if (rvsm1 && rvsm2) {
            return 1000; // RVSM
        }
    }
    
    // Non-RVSM or above FL410 - 2000ft
    return 2000;
}

function getLateralMinima(fdr1, fdr2) {
    // Per spec Section 6.2.4.2 - Lateral Separation Standards
    // Check RNP capabilities from aircraft data
    const rnp4_1 = fdr1.rnp4 === true;
    const rnp4_2 = fdr2.rnp4 === true;
    const rnp10_1 = fdr1.rnp10 === true;
    const rnp10_2 = fdr2.rnp10 === true;
    
    // RNP4 both aircraft - 23nm
    if (rnp4_1 && rnp4_2) {
        return 23;
    }
    
    // RNP10 both aircraft - 50nm
    if (rnp10_1 && rnp10_2) {
        return 50;
    }
    
    // Mixed RNP4/RNP10 - 50nm
    if ((rnp4_1 && rnp10_2) || (rnp10_1 && rnp4_2)) {
        return 50;
    }
    
    // One RNP equipped, one not - 75nm (Pacific) or varies
    if ((rnp10_1 || rnp4_1) && !rnp10_2 && !rnp4_2) {
        return 75;
    }
    if ((rnp10_2 || rnp4_2) && !rnp10_1 && !rnp4_1) {
        return 75;
    }
    
    // Check region-specific default
    const region = fdr1.region || fdr2.region || 'pacific';
    
    // Pacific: 100nm, North Atlantic: 60nm (SLOP) or 120nm (non-SLOP)
    if (region === 'northatlantic') {
        return 60; // Assume SLOP capable for NAT
    }
    
    return 100; // Pacific default
}

function getLongitudinalTimeMinima(fdr1, fdr2) {
    // Per spec Section 6.2.4.3 - Longitudinal Time Separation
    // Per 6.2.4.3.2 - MNT minimum is 5 minutes, basic is 10 min
    const trackType = determineConflictType(calculateTrackAngle(fdr1, fdr2));
    
    // Check if both are jets (turbojets qualify for MNT)
    const isJet1 = fdr1.isJet === true;
    const isJet2 = fdr2.isJet === true;
    
    // Check if MNT (Mach Number Technique) can be applied
    // Per spec: both must be turbojets, same/continuously diverging tracks
    const canApplyMnt = isJet1 && isJet2 && (trackType === 'Same');
    
    switch (trackType) {
        case 'Same':
            // Same direction with MNT - minimum 5 minutes (basic MNT)
            // Can be 10 minutes with JET_10_LONG or turbojet flag
            if (canApplyMnt) {
                // Check for Rule of 11 reduced separation (5 + speed differential)
                // For now use basic MNT minimum
                return 5 * 60 * 1000; // 5 minutes minimum MNT
            }
            // Same direction without MNT - 15 minutes default
            return 15 * 60 * 1000;
            
        case 'Reciprocal':
            // Reciprocal (opposite) direction 
            // After both reported passing, same direction minima applies
            // Before passing: 10 minutes for climb/descent procedures
            return 10 * 60 * 1000;
            
        case 'Crossing':
        default:
            // Crossing tracks - 15 minutes
            return 15 * 60 * 1000;
    }
}

function calculateTrackAngle(fdr1, fdr2) {
    if (!fdr1.parsedRoute || fdr1.parsedRoute.length < 2 ||
        !fdr2.parsedRoute || fdr2.parsedRoute.length < 2) {
        return 90; // Default to crossing if no route data
    }
    
    const track1 = calculateTrack(fdr1.parsedRoute[0], fdr1.parsedRoute[fdr1.parsedRoute.length - 1]);
    const track2 = calculateTrack(fdr2.parsedRoute[0], fdr2.parsedRoute[fdr2.parsedRoute.length - 1]);
    
    let angle = Math.abs(track1 - track2);
    if (angle > 180) angle = 360 - angle;
    
    return angle;
}

function getLongitudinalDistanceMinima(fdr1, fdr2) {
    // Per spec Section 6.2.4.4/6.2.4.5 - Longitudinal Distance Separation
    const rnp4_1 = fdr1.rnp4 === true;
    const rnp4_2 = fdr2.rnp4 === true;
    const rnp10_1 = fdr1.rnp10 === true;
    const rnp10_2 = fdr2.rnp10 === true;
    const hasDatalink1 = fdr1.hasDatalink === true;
    const hasDatalink2 = fdr2.hasDatalink === true;
    const hasDme1 = fdr1.hasDme === true;
    const hasDme2 = fdr2.hasDme === true;
    
    // RNP4 both aircraft with ADS-C - 30nm
    if (rnp4_1 && rnp4_2) {
        return 30;
    }
    
    // ADS-C/CPDLC equipped with RNP10 - 50nm
    if (hasDatalink1 && hasDatalink2 && rnp10_1 && rnp10_2) {
        return 50;
    }
    
    // DME-based separation - 20nm
    if (hasDme1 && hasDme2) {
        return 20;
    }
    
    // Default MNT separation for same track
    return 50;
}

function rectanglesOverlap(fdr1, fdr2) {
    const rect1 = createBoundingBox(fdr1.parsedRoute);
    const rect2 = createBoundingBox(fdr2.parsedRoute);
    
    if (!rect1 || !rect2) return false;
    
    return !(rect1.maxLon < rect2.minLon ||
             rect1.minLon > rect2.maxLon ||
             rect1.maxLat < rect2.minLat ||
             rect1.minLat > rect2.maxLat);
}

function createBoundingBox(route) {
    if (!route || route.length === 0) return null;
    
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    
    for (const wp of route) {
        minLat = Math.min(minLat, wp.lat);
        maxLat = Math.max(maxLat, wp.lat);
        minLon = Math.min(minLon, wp.lon);
        maxLon = Math.max(maxLon, wp.lon);
    }
    
    // Add padding for separation minima
    const padding = 0.5; // degrees ~30nm
    return {
        minLat: minLat - padding,
        maxLat: maxLat + padding,
        minLon: minLon - padding,
        maxLon: maxLon + padding
    };
}

function calculateAreaOfConflict(fdr1, fdr2, lateralSep) {
    const conflictSegments = [];
    const route1 = fdr1.parsedRoute;
    const route2 = fdr2.parsedRoute;
    
    for (let i = 1; i < route1.length; i++) {
        const polygon = createProtectedAirspace(
            route1[i - 1],
            route1[i],
            lateralSep
        );
        
        for (let j = 1; j < route2.length; j++) {
            const intersections = findPolygonLineIntersections(
                polygon,
                route2[j - 1],
                route2[j]
            );
            
            if (intersections.length >= 2) {
                // There's a conflict segment
                const startTime = interpolateTime(route2[j - 1], route2[j], intersections[0]);
                const endTime = interpolateTime(route2[j - 1], route2[j], intersections[1]);
                
                conflictSegments.push({
                    startLatLon: intersections[0],
                    endLatLon: intersections[1],
                    startTime: startTime,
                    endTime: endTime
                });
            }
        }
    }
    
    return conflictSegments;
}

function createProtectedAirspace(point1, point2, radius) {
    const polygon = [];
    const track = calculateTrack(point1, point2);
    
    // Create semicircle around point1
    for (let angle = 0; angle <= 180; angle += 15) {
        const heading = track - 90 - angle;
        polygon.push(calculatePointFromBearingDistance(point1, radius, heading));
    }
    
    // Create semicircle around point2
    for (let angle = 0; angle <= 180; angle += 15) {
        const heading = track + 90 - angle;
        polygon.push(calculatePointFromBearingDistance(point2, radius, heading));
    }
    
    polygon.push(polygon[0]); // Close polygon
    return polygon;
}

function findPolygonLineIntersections(polygon, lineStart, lineEnd) {
    const intersections = [];
    
    for (let i = 1; i < polygon.length; i++) {
        const intersection = lineIntersection(
            polygon[i - 1], polygon[i],
            lineStart, lineEnd
        );
        if (intersection) {
            intersections.push(intersection);
        }
    }
    
    // Remove duplicates
    return intersections.filter((point, index, self) =>
        index === self.findIndex(p => 
            calculateDistance(p, point) < 0.01
        )
    );
}

function lineIntersection(p1, p2, p3, p4) {
    const denom = (p4.lon - p3.lon) * (p2.lat - p1.lat) - (p4.lat - p3.lat) * (p2.lon - p1.lon);
    if (Math.abs(denom) < 0.0001) return null;
    
    const ua = ((p4.lat - p3.lat) * (p1.lon - p3.lon) - (p4.lon - p3.lon) * (p1.lat - p3.lat)) / denom;
    const ub = ((p2.lat - p1.lat) * (p1.lon - p3.lon) - (p2.lon - p1.lon) * (p1.lat - p3.lat)) / denom;
    
    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
        return {
            lat: p1.lat + ua * (p2.lat - p1.lat),
            lon: p1.lon + ua * (p2.lon - p1.lon)
        };
    }
    return null;
}

function interpolateTime(wp1, wp2, point) {
    if (!wp1.eto || !wp2.eto) return Date.now();
    
    const totalDist = calculateDistance(wp1, wp2);
    const partialDist = calculateDistance(wp1, point);
    const ratio = totalDist > 0 ? partialDist / totalDist : 0;
    
    const time1 = new Date(wp1.eto).getTime();
    const time2 = new Date(wp2.eto).getTime();
    
    return time1 + ratio * (time2 - time1);
}

// ============================================
// NAVIGATION CALCULATIONS
// ============================================

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS_NM = 3440.065; // nautical miles

function calculateTrack(from, to) {
    const lat1 = from.lat * DEG_TO_RAD;
    const lat2 = to.lat * DEG_TO_RAD;
    const dLon = (to.lon - from.lon) * DEG_TO_RAD;
    
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    
    let track = Math.atan2(y, x) * RAD_TO_DEG;
    return (track + 360) % 360;
}

function calculateDistance(from, to) {
    const lat1 = from.lat * DEG_TO_RAD;
    const lat2 = to.lat * DEG_TO_RAD;
    const dLat = (to.lat - from.lat) * DEG_TO_RAD;
    const dLon = (to.lon - from.lon) * DEG_TO_RAD;
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return EARTH_RADIUS_NM * c;
}

function calculatePointFromBearingDistance(from, distanceNm, bearingDeg) {
    const lat1 = from.lat * DEG_TO_RAD;
    const lon1 = from.lon * DEG_TO_RAD;
    const bearing = bearingDeg * DEG_TO_RAD;
    const angularDist = distanceNm / EARTH_RADIUS_NM;
    
    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDist) +
        Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearing)
    );
    
    const lon2 = lon1 + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDist) * Math.cos(lat1),
        Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2)
    );
    
    return {
        lat: lat2 * RAD_TO_DEG,
        lon: lon2 * RAD_TO_DEG
    };
}

function determineConflictType(trackAngle) {
    // Per spec Appendix A.3.82 DIR_TYPE
    // Given the angle θ between planes containing 2 flight legs:
    //   if |θ| < 45°, then return same direction
    //   if |θ| > 135°, then return reciprocal direction
    //   else return crossing direction
    
    // Normalize angle to 0-180 range
    let normalized = Math.abs(trackAngle % 360);
    if (normalized > 180) normalized = 360 - normalized;
    
    // Same direction: |θ| < 45° (strictly less than)
    if (normalized < CONFIG.sameTrackMaxAngle) {
        return 'Same';
    }
    
    // Reciprocal direction: |θ| > 135° (strictly greater than)
    if (normalized > CONFIG.reciprocalMinAngle) {
        return 'Reciprocal';
    }
    
    // Crossing direction: 45° ≤ |θ| ≤ 135°
    return 'Crossing';
}

function groupConflicts(conflicts) {
    return {
        actual: conflicts.filter(c => c.status === 'Actual'),
        imminent: conflicts.filter(c => c.status === 'Imminent'),
        advisory: conflicts.filter(c => c.status === 'Advisory'),
        all: conflicts
    };
}

// Signal worker is ready
self.postMessage({ type: 'ready' });
