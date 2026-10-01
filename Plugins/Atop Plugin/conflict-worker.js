/**
 * Conflict Calculation Web Worker
 * Offloads heavy O(n²) conflict detection from vatSys plugin
 * 
 * Per FAA ATOP NAS-MD-4714 Algorithm Specifications
 * 
 * Probing is event-driven per ATOP spec Section 12.1.1:
 * - Triggered by C# plugin on FDR updates
 * - No interval-based probing
 */

// Store FDRs indexed by callsign
const fdrs = new Map();

// Configuration per NAS-MD-4714 Section 6.2 and Appendix A.3.82
const CONFIG = {
    advisoryThresholdHours: 2,      // Advisory: > 30 min, <= 2 hours
    imminentThresholdMinutes: 30,   // Imminent: > 1 min, <= 30 min
    actualThresholdMinutes: 1,      // Actual: <= 1 min
    
    // Track angle thresholds per NAS-MD-4714 Appendix A.3.82 DIR_TYPE
    // Same: |θ| < 45° (strictly less than)
    // Reciprocal: |θ| > 135° (strictly greater than)  
    // Crossing: 45° ≤ |θ| ≤ 135°
    sameTrackMaxAngle: 45,          // Exclusive: angle must be < 45 for Same
    reciprocalMinAngle: 135         // Exclusive: angle must be > 135 for Reciprocal
};

// Store STCA inhibition areas from AlertParameters.xml
// Each area: { name, lowerLevel, upperLevel, boundary: [{lat, lon}] }
let inhibitionAreas = [];

// Message handler
self.onmessage = function(e) {
    const { type, data } = e.data;
    
    console.log(`[ConflictWorker] Received message: ${type}`);
    
    switch (type) {
        case 'updateFDR':
            updateFDR(data);
            break;
        case 'removeFDR':
            fdrs.delete(data.callsign);
            console.log(`[ConflictWorker] Removed FDR: ${data.callsign}, total FDRs: ${fdrs.size}`);
            break;
        case 'bulkUpdateFDRs':
            bulkUpdateFDRs(data);
            break;
        case 'requestProbe':
            // Event-driven probe request from C# plugin
            console.log(`[ConflictWorker] Probe requested, FDRs in store: ${fdrs.size}, inhibition areas: ${inhibitionAreas.length}`);
            const conflicts = probeAllConflicts();
            self.postMessage({ type: 'conflictResults', data: conflicts });
            break;
        case 'probeVirtualFDR':
            // Probe with a temporary modified FDR without persisting it.
            // 'data' has { originalCallsign, virtualFDR } where virtualFDR
            // is the same shape as a normal FDR but with proposed changes (e.g. CFL).
            probeVirtualFDR(data);
            break;
        case 'setConfig':
            Object.assign(CONFIG, data);
            console.log('[ConflictWorker] Config updated:', CONFIG);
            break;
        case 'setInhibitionAreas':
            inhibitionAreas = data || [];
            console.log(`[ConflictWorker] Loaded ${inhibitionAreas.length} inhibition area(s)`);
            break;
        case 'start':
            // No longer starts interval - just log ready
            console.log('[ConflictWorker] Ready for event-driven probe requests');
            break;
        case 'stop':
            // No interval to stop - just log
            console.log('[ConflictWorker] Stopped');
            break;
    }
};

function updateFDR(fdrData) {
    const parsed = parseRoute(fdrData.route, fdrData.routeWaypoints);
    console.log(`[ConflictWorker] updateFDR: ${fdrData.callsign} | state=${fdrData.state} | CFL=${fdrData.cfl} RFL=${fdrData.rfl} | waypoints=${parsed.length} | rnp4=${fdrData.rnp4} rnp10=${fdrData.rnp10}`);
    fdrs.set(fdrData.callsign, {
        ...fdrData,
        parsedRoute: parsed,
        updatedAt: Date.now()
    });
}

function bulkUpdateFDRs(fdrList) {
    console.log(`[ConflictWorker] bulkUpdateFDRs: received ${fdrList.length} FDRs`);
    // Clear stale FDRs
    const currentCallsigns = new Set(fdrList.map(f => f.callsign));
    for (const callsign of fdrs.keys()) {
        if (!currentCallsigns.has(callsign)) {
            fdrs.delete(callsign);
        }
    }
    // Update all
    fdrList.forEach(fdr => updateFDR(fdr));
    console.log(`[ConflictWorker] bulkUpdateFDRs complete, total FDRs in store: ${fdrs.size}`);
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
    
    console.log(`[ConflictWorker] === PROBE START === Total FDRs: ${fdrArray.length}`);
    
    // Log all FDRs in the store
    fdrArray.forEach(fdr => {
        console.log(`[ConflictWorker]   FDR: ${fdr.callsign} | state=${fdr.state} | CFL=${fdr.cfl} RFL=${fdr.rfl} | route_pts=${fdr.parsedRoute?.length || 0}`);
    });
    
    // Filter to only active FDRs
    const activeFdrs = fdrArray.filter(fdr => 
        fdr.state !== 'INACTIVE' && 
        fdr.state !== 'PREACTIVE' && 
        fdr.state !== 'COORDINATED' &&
        fdr.state !== 'FINISHED' &&
        fdr.parsedRoute.length >= 2
    );
    
    console.log(`[ConflictWorker] Active FDRs after filter (state != INACTIVE/PREACTIVE/COORDINATED/FINISHED, route >= 2 pts): ${activeFdrs.length}`);
    
    // Log which FDRs were filtered out and why
    const filteredOut = fdrArray.filter(fdr => !activeFdrs.includes(fdr));
    filteredOut.forEach(fdr => {
        const reasons = [];
        if (fdr.state === 'INACTIVE' || fdr.state === 'PREACTIVE' || fdr.state === 'FINISHED') reasons.push(`state=${fdr.state}`);
        if (!fdr.parsedRoute || fdr.parsedRoute.length < 2) reasons.push(`route_pts=${fdr.parsedRoute?.length || 0}`);
        console.log(`[ConflictWorker]   FILTERED OUT: ${fdr.callsign} (${reasons.join(', ')})`);
    });
    
    if (activeFdrs.length < 2) {
        console.log('[ConflictWorker] === PROBE END === Not enough active FDRs for conflict check (need >= 2)');
        return groupConflicts([]);
    }
    
    // O(n²) comparison but in worker thread
    let pairsChecked = 0;
    for (let i = 0; i < activeFdrs.length; i++) {
        for (let j = i + 1; j < activeFdrs.length; j++) {
            pairsChecked++;
            const conflict = checkConflict(activeFdrs[i], activeFdrs[j]);
            if (conflict) {
                allConflicts.push(conflict);
            }
        }
    }
    
    console.log(`[ConflictWorker] === PROBE END === Pairs checked: ${pairsChecked}, Conflicts found: ${allConflicts.length}`);
    allConflicts.forEach(c => {
        console.log(`[ConflictWorker]   CONFLICT: ${c.intruderCallsign} vs ${c.activeCallsign} | status=${c.status} | type=${c.conflictType} | vertAct=${c.verticalAct}ft vertSep=${c.verticalSep}ft | latSep=${c.latSep}nm | angle=${c.trkAngle?.toFixed(1)}° | LOS=${c.earliestLos}`);
    });
    
    return groupConflicts(allConflicts);
}

function checkConflict(fdr1, fdr2) {
    const pair = `${fdr1.callsign} vs ${fdr2.callsign}`;
    
    // 1. Temporal Test
    if (!passesTemporalTest(fdr1, fdr2)) {
        console.log(`[ConflictWorker]   ${pair}: PASS - no temporal overlap`);
        return null;
    }
    
    // 2. Vertical Test
    const verticalSep = getVerticalMinima(fdr1, fdr2);
    const verticalAct = getAltitudeDifference(fdr1, fdr2);
    if (verticalAct >= verticalSep) {
        console.log(`[ConflictWorker]   ${pair}: PASS - vertical sep OK (act=${verticalAct}ft >= req=${verticalSep}ft)`);
        return null;
    }
    
    console.log(`[ConflictWorker]   ${pair}: FAIL vertical (act=${verticalAct}ft < req=${verticalSep}ft), checking lateral...`);
    
    // 3. Lateral Bounding Box Test (quick filter)
    if (!rectanglesOverlap(fdr1, fdr2)) {
        console.log(`[ConflictWorker]   ${pair}: PASS - bounding boxes don't overlap`);
        return null;
    }
    
    // 4. Detailed Lateral Conflict Check
    const latSep = getLateralMinima(fdr1, fdr2);
    const conflictSegments = calculateAreaOfConflict(fdr1, fdr2, latSep);
    
    console.log(`[ConflictWorker]   ${pair}: lateral minima=${latSep}nm, conflict segments=${conflictSegments.length}`);
    
    if (conflictSegments.length === 0) {
        console.log(`[ConflictWorker]   ${pair}: PASS - no lateral conflict segments`);
        return null;
    }
    
    // Filter and clip conflict segments against inhibition (radar) areas.
    // - Segments entirely inside a radar area are suppressed (STCA handles them).
    // - Segments that cross a radar boundary are clipped so only the
    //   non-radar (oceanic) portion remains, and times are interpolated.
    // - Segments entirely outside radar areas are kept as-is.
    const alt1 = fdr1.cfl || fdr1.rfl || 0;
    const alt2 = fdr2.cfl || fdr2.rfl || 0;
    const uninhibitedSegments = [];
    for (const seg of conflictSegments) {
        const clipped = clipSegmentToNonInhibited(seg, alt1, alt2);
        if (clipped) {
            uninhibitedSegments.push(clipped);
        } else {
            console.log(`[ConflictWorker]   ${pair}: segment suppressed (entirely in radar area) ${seg.startLatLon.lat.toFixed(2)},${seg.startLatLon.lon.toFixed(2)} -> ${seg.endLatLon.lat.toFixed(2)},${seg.endLatLon.lon.toFixed(2)}`);
        }
    }
    
    if (uninhibitedSegments.length === 0) {
        console.log(`[ConflictWorker]   ${pair}: PASS - all conflict segments within radar inhibition areas`);
        return null;
    }
    
    // Sort by start time
    uninhibitedSegments.sort((a, b) => a.startTime - b.startTime);
    const firstConflict = uninhibitedSegments[0];

    // Classify the SPECIFIC leg pair that produced this conflict segment (not the
    // whole-route bearing) per NAS-MD-4714 6.2.5.7.1.3 — this determines both the
    // reported conflict type and which separation standard applies.
    const leg1 = firstConflict.route1Leg;
    const leg2 = firstConflict.route2Leg;
    const legAngle = leg1 && leg2
        ? (() => {
            let a = Math.abs(calculateTrack(leg1.start, leg1.end) - calculateTrack(leg2.start, leg2.end));
            return a > 180 ? 360 - a : a;
        })()
        : calculateTrackAngle(fdr1, fdr2);
    const legClass = leg1 && leg2
        ? classifyLegPairStandard(leg1.start, leg1.end, leg2.start, leg2.end, legAngle)
        : { reportType: determineConflictType(legAngle), standard: determineConflictType(legAngle) };

    // 5. Longitudinal Separation Check
    const longTimeSep = getLongitudinalTimeMinima(fdr1, fdr2, legAngle, legClass.standard);
    const longDistSep = getLongitudinalDistanceMinima(fdr1, fdr2);
    const longDistAct = calculateDistance(firstConflict.startLatLon, firstConflict.endLatLon);

    let longTimeAct;
    let crossingResult = null;
    let lossOfSep;

    if (legClass.reportType === 'Crossing' && leg1 && leg2) {
        // Per 6.2.5.7.1.3: for crossing tracks, longitudinal separation is determined by
        // the time differential between each aircraft's ETA at the geometric crossing
        // point of the two legs — NOT by how long one aircraft's route spends inside the
        // other's static lateral-protection corridor. A conflict is declared purely on
        // this differential, even if the corridor-transit windows below are disjoint,
        // since ETA estimates carry ~±3min uncertainty (the aircraft can still cross in
        // close proximity despite the windows not overlapping).
        crossingResult = crossingTrackTimeDifferential(leg1.start, leg1.end, leg2.start, leg2.end);
        if (crossingResult) {
            longTimeAct = crossingResult.timeDiff;
            lossOfSep = longTimeAct < longTimeSep;
            console.log(`[ConflictWorker]   ${pair}: CROSSING TRACK TEST (6.2.5.7.1.3) — leg angle=${legAngle.toFixed(1)}° standard=${legClass.standard} | ETA diff at crossing point=${(longTimeAct/60000).toFixed(1)}min sep=${(longTimeSep/60000).toFixed(1)}min | LOS=${lossOfSep}`);
        } else {
            // Legs nearly parallel or missing ETO data — no single crossing point to
            // test against. Fall back to the corridor-transit method as a safety net
            // rather than silently skipping the longitudinal check.
            longTimeAct = Math.abs(firstConflict.endTime - firstConflict.startTime);
            lossOfSep = longTimeAct < longTimeSep || longDistAct < longDistSep;
            console.log(`[ConflictWorker]   ${pair}: crossing point could not be computed (parallel legs / missing ETO) — falling back to corridor-transit test`);
        }
    } else {
        // Same-direction / reciprocal (including the Continuously Diverging Tracks
        // exception) — unchanged corridor-transit + distance method.
        longTimeAct = Math.abs(firstConflict.endTime - firstConflict.startTime);
        lossOfSep = longTimeAct < longTimeSep || longDistAct < longDistSep;
    }

    console.log(`[ConflictWorker]   ${pair}: longTime act=${(longTimeAct/60000).toFixed(1)}min sep=${(longTimeSep/60000).toFixed(1)}min | longDist act=${longDistAct.toFixed(1)}nm sep=${longDistSep}nm | LOS=${lossOfSep}`);
    
    if (!lossOfSep) {
        console.log(`[ConflictWorker]   ${pair}: PASS - longitudinal separation maintained`);
        return null;
    }
    
    // 6. Determine Conflict Status — future conflicts only
    const now = Date.now();
    
    // Skip conflicts that are entirely in the past
    if (firstConflict.endTime < now) {
        console.log(`[ConflictWorker]   ${pair}: PASS - conflict entirely in the past (ended ${((now - firstConflict.endTime)/60000).toFixed(1)}min ago)`);
        return null;
    }
    
    const timeUntilLOS = firstConflict.startTime - now;
    
    let status;
    if (timeUntilLOS <= 0) {
        // Conflict is happening now (startTime in past, endTime in future)
        status = 'Actual';
    } else if (timeUntilLOS < CONFIG.actualThresholdMinutes * 60000) {
        status = 'Actual';
    } else if (timeUntilLOS <= CONFIG.imminentThresholdMinutes * 60000) {
        status = 'Imminent';
    } else if (timeUntilLOS <= CONFIG.advisoryThresholdHours * 3600000) {
        status = 'Advisory';
    } else {
        console.log(`[ConflictWorker]   ${pair}: PASS - LOS too far in future (${(timeUntilLOS/3600000).toFixed(1)}hrs)`);
        return null; // Too far in future
    }
    
    // Report the leg-pair-specific classification (per 6.2.5.9), not the coarser
    // whole-route bearing — this is what actually governed the separation test above.
    console.log(`[ConflictWorker]   ${pair}: ** CONFLICT DETECTED ** status=${status} type=${legClass.reportType} legAngle=${legAngle.toFixed(1)}°`);
    
    return {
        intruderCallsign: fdr1.callsign,
        activeCallsign: fdr2.callsign,
        status: status,
        conflictType: legClass.reportType,
        earliestLos: new Date(firstConflict.startTime).toISOString(),
        latestLos: new Date(firstConflict.endTime).toISOString(),
        latSep: latSep,
        verticalSep: verticalSep,
        verticalAct: verticalAct,
        trkAngle: legAngle,
        longTimeAct: longTimeAct,
        longDistAct: longDistAct,
        startLat: firstConflict.startLatLon.lat,
        startLon: firstConflict.startLatLon.lon,
        endLat: firstConflict.endLatLon.lat,
        endLon: firstConflict.endLatLon.lon
    };
}

// ============================================
// INHIBITION AREA CHECKS
// ============================================

/**
 * Check if a point is inhibited by any inhibition area.
 * Mirrors vatSys RDP.cs STCA logic: skip if either aircraft's altitude
 * is within the area's vertical bounds and the point is inside the polygon.
 */
function isPointInhibited(lat, lon, altFL1, altFL2) {
    for (const area of inhibitionAreas) {
        if (!area.boundary || area.boundary.length < 3) continue;
        // Check if either aircraft altitude is within the inhibition band
        // vatSys uses: lowerLevel <= alt && upperLevel > alt (FL values)
        const alt1InBand = area.lowerLevel <= altFL1 && area.upperLevel > altFL1;
        const alt2InBand = area.lowerLevel <= altFL2 && area.upperLevel > altFL2;
        if ((alt1InBand || alt2InBand) && isPointInPolygon(lat, lon, area.boundary)) {
            return true;
        }
    }
    return false;
}

/**
 * Ray-casting point-in-polygon test.
 * polygon: array of {lat, lon}
 */
function isPointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const yi = polygon[i].lat, xi = polygon[i].lon;
        const yj = polygon[j].lat, xj = polygon[j].lon;
        if (((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Same ray-cast test, but accepting a raw polygon array directly (no inhibition
 * area wrapper). Used by the time-correlation check in calculateAreaOfConflict.
 */
function isPointInPolygonDirect(lat, lon, polygon) {
    return isPointInPolygon(lat, lon, polygon);
}

/**
 * Clip a conflict segment so only the portion outside inhibition areas remains.
 * Returns the clipped segment, or null if the entire segment is inhibited.
 *
 * Cases:
 *  - Both ends outside all areas → return as-is.
 *  - Both ends inside the same area → fully suppressed, return null.
 *  - Start inside, end outside → clip start to the boundary crossing.
 *  - Start outside, end inside → clip end to the boundary crossing.
 */
function clipSegmentToNonInhibited(seg, altFL1, altFL2) {
    const startIn = isPointInhibited(seg.startLatLon.lat, seg.startLatLon.lon, altFL1, altFL2);
    const endIn = isPointInhibited(seg.endLatLon.lat, seg.endLatLon.lon, altFL1, altFL2);

    // Entirely outside — keep whole segment
    if (!startIn && !endIn) return seg;

    // Entirely inside — suppress
    if (startIn && endIn) return null;

    // Find the intersection point with the inhibition area boundary
    const crossing = findInhibitionBoundaryCrossing(seg.startLatLon, seg.endLatLon, altFL1, altFL2);
    if (!crossing) {
        // Couldn't find crossing (shouldn't happen) — keep segment as-is to be safe
        return seg;
    }

    // Interpolate the time at the crossing point
    const totalDist = calculateDistance(seg.startLatLon, seg.endLatLon);
    const crossingDist = calculateDistance(seg.startLatLon, crossing);
    const ratio = totalDist > 0 ? crossingDist / totalDist : 0;
    const crossingTime = seg.startTime + ratio * (seg.endTime - seg.startTime);

    if (startIn) {
        // Start is in radar area — clip start to the boundary crossing
        return {
            startLatLon: crossing,
            endLatLon: seg.endLatLon,
            startTime: crossingTime,
            endTime: seg.endTime,
            route1Leg: seg.route1Leg,
            route2Leg: seg.route2Leg
        };
    } else {
        // End is in radar area — clip end to the boundary crossing
        return {
            startLatLon: seg.startLatLon,
            endLatLon: crossing,
            startTime: seg.startTime,
            endTime: crossingTime,
            route1Leg: seg.route1Leg,
            route2Leg: seg.route2Leg
        };
    }
}

/**
 * Find the point where a line segment crosses an inhibition area boundary.
 * Walks the polygon edges and returns the intersection closest to the start.
 */
function findInhibitionBoundaryCrossing(from, to, altFL1, altFL2) {
    let bestCrossing = null;
    let bestDist = Infinity;

    for (const area of inhibitionAreas) {
        if (!area.boundary || area.boundary.length < 3) continue;
        const alt1InBand = area.lowerLevel <= altFL1 && area.upperLevel > altFL1;
        const alt2InBand = area.lowerLevel <= altFL2 && area.upperLevel > altFL2;
        if (!alt1InBand && !alt2InBand) continue;

        const poly = area.boundary;
        for (let i = 0; i < poly.length; i++) {
            const j = (i + 1) % poly.length;
            const ix = lineIntersection(poly[i], poly[j], from, to);
            if (ix) {
                const d = calculateDistance(from, ix);
                if (d < bestDist) {
                    bestDist = d;
                    bestCrossing = ix;
                }
            }
        }
    }
    return bestCrossing;
}

// ============================================
// GEOMETRIC CALCULATIONS
// ============================================

function passesTemporalTest(fdr1, fdr2) {
    // Use ATD as start, falling back to first waypoint ETO, then to now.
    const firstEto1 = fdr1.parsedRoute.find(wp => wp.eto)?.eto;
    const firstEto2 = fdr2.parsedRoute.find(wp => wp.eto)?.eto;
    const lastEto1  = [...fdr1.parsedRoute].reverse().find(wp => wp.eto)?.eto;
    const lastEto2  = [...fdr2.parsedRoute].reverse().find(wp => wp.eto)?.eto;

    const start1 = fdr1.atd
        ? new Date(fdr1.atd).getTime()
        : firstEto1 ? new Date(firstEto1).getTime() : Date.now();
    const end1 = lastEto1
        ? new Date(lastEto1).getTime()
        : Date.now() + 24 * 3600000;

    const start2 = fdr2.atd
        ? new Date(fdr2.atd).getTime()
        : firstEto2 ? new Date(firstEto2).getTime() : Date.now();
    const end2 = lastEto2
        ? new Date(lastEto2).getTime()
        : Date.now() + 24 * 3600000;

    return !(start1 > end2 || start2 > end1);
}

function getAltitudeDifference(fdr1, fdr2) {
    // CFL/RFL are in flight levels (hundreds of feet), convert to feet
    const alt1 = (fdr1.cfl || fdr1.rfl || 0) * 100;
    const alt2 = (fdr2.cfl || fdr2.rfl || 0) * 100;
    return Math.abs(alt1 - alt2);
}

function getVerticalMinima(fdr1, fdr2) {
    // Per NAS-MD-4714 Section 6.2.4.1 - Vertical Separation Standards
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

function isPbcs(fdr) {
    // PBCS requires: RNP4 capability, RSP180 filed (SUR/), P2 filed (PBN/),
    // and CPDLC actively logged on (CDA) — equipment alone is not sufficient.
    return fdr.rnp4 === true &&
           fdr.rsp180 === true &&
           fdr.p2Filed === true &&
           fdr.cpdlcLoggedOn === true;
}

function getLateralMinima(fdr1, fdr2) {
    // Per NAS-MD-4714 / ICAO Doc 9869 PBCS lateral separation standards
    const rnp4_1 = fdr1.rnp4 === true;
    const rnp4_2 = fdr2.rnp4 === true;
    const rnp10_1 = fdr1.rnp10 === true;
    const rnp10_2 = fdr2.rnp10 === true;

    // PBCS (RNP4 + RSP180 + P2 + CPDLC logged on) both aircraft — 23nm
    if (isPbcs(fdr1) && isPbcs(fdr2)) {
        return 23;
    }

    // RNP4 or RNP10 both aircraft (non-PBCS) — 50nm
    // RNP4 alone does not reduce lateral from 50nm; only PBCS achieves 23nm
    if ((rnp4_1 || rnp10_1) && (rnp4_2 || rnp10_2)) {
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

function getLongitudinalTimeMinima(fdr1, fdr2, angleOverride, standardOverride) {
    // Per NAS-MD-4714 Section 6.2.4.3 - Longitudinal Time Separation
    // Per 6.2.4.3.2 - MNT minimum is 5 minutes, basic is 10 min
    const angle = angleOverride !== undefined ? angleOverride : calculateTrackAngle(fdr1, fdr2);
    // standardOverride lets the crossing-track test (6.2.5.7.1.3) pick which
    // separation *standard* applies for a 45°-135° leg pair, since crossing
    // tracks 45°-<90° use the same-direction standard while 90°-135° use the
    // opposite-direction standard — they are NOT both just "15 minutes".
    const trackType = standardOverride || determineConflictType(angle);
    
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
            // Fallback only — real crossing-track handling picks the same/opposite
            // standard explicitly via standardOverride (see classifyLegPairStandard).
            return 15 * 60 * 1000;
    }
}

// ============================================
// CROSSING TRACK LONGITUDINAL TEST
// Per NAS-MD-4714 6.2.5.7.1.3 "Crossing Track" / 6.2.8.4.11 "Crossing Track
// Longitudinal Test": for crossing tracks (45°-135° between the SPECIFIC
// conflicting leg pair, not the whole-route bearing), longitudinal separation
// is determined by finding the geometric crossing point of the two legs and
// comparing each aircraft's independently-estimated time of arrival there —
// NOT by how long one aircraft's route spends inside the other's lateral
// protection corridor (which is what the rest of this file's polygon method
// measures, and is only valid for Same/Reciprocal geometry).
// ============================================

/**
 * Geometric intersection of two infinite lines through (p1,p2) and (p3,p4).
 * Unlike lineIntersection(), this is NOT clipped to the segment bounds —
 * 6.2.8.4.11.1.4/.1.6 ("Find Crossing Point ETAs" / "Extrapolated Crossing
 * Point ETA Adjustment") explicitly allow the crossing point to lie beyond
 * the reported route legs.
 */
function lineIntersectionExtrapolated(p1, p2, p3, p4) {
    const denom = (p4.lon - p3.lon) * (p2.lat - p1.lat) - (p4.lat - p3.lat) * (p2.lon - p1.lon);
    if (Math.abs(denom) < 1e-7) return null; // parallel/near-parallel legs — no single crossing point

    const ua = ((p4.lat - p3.lat) * (p1.lon - p3.lon) - (p4.lon - p3.lon) * (p1.lat - p3.lat)) / denom;
    return {
        lat: p1.lat + ua * (p2.lat - p1.lat),
        lon: p1.lon + ua * (p2.lon - p1.lon)
    };
}

/**
 * Estimates an aircraft's ETA at an arbitrary point along a specific route
 * leg, extrapolating linearly from the leg's own endpoint ETOs if the point
 * lies outside the leg. Mirrors 6.2.8.4.11.1.4 "Find Crossing Point ETAs".
 */
function estimateEtaAtPoint(legStart, legEnd, point) {
    if (!legStart.eto || !legEnd.eto) return null;

    const legDist = calculateDistance(legStart, legEnd);
    const pointDist = calculateDistance(legStart, point);
    const ratio = legDist > 0 ? pointDist / legDist : 0;

    const t0 = new Date(legStart.eto).getTime();
    const t1 = new Date(legEnd.eto).getTime();
    return t0 + ratio * (t1 - t0);
}

/**
 * Signed along-track distance of `point` relative to `legStart`, positive in
 * the direction of `legEnd`. Used to tell whether a geometric crossing point
 * lies ahead of or behind an aircraft's current leg.
 */
function signedProgressAlongLeg(legStart, legEnd, point) {
    const legTrack = calculateTrack(legStart, legEnd);
    const bearingToPoint = calculateTrack(legStart, point);
    const distToPoint = calculateDistance(legStart, point);
    const angleDiff = Math.abs(((bearingToPoint - legTrack + 540) % 360) - 180);
    return angleDiff > 90 ? -distToPoint : distToPoint;
}

/**
 * NAS-MD-4714 6.2.5.7.1.3 — classifies a specific leg pair by crossing angle
 * and picks which longitudinal separation *standard* applies (distinct from
 * the reporting "conflict type"): angles 45°-<90° use the same-direction
 * standard, 90°-135° use the opposite-direction standard. Tracks in the
 * 45°-<90° range that continuously diverge are instead treated as same-
 * direction tracks entirely (both classification and standard), per the
 * "Continuously Diverging Tracks" exception.
 *
 * NOTE: the formal geometric definition of "Continuously Diverging Tracks" is
 * given in Paragraph 6.2.5.9 (Reporting Aircraft to Aircraft Conflicts), which
 * wasn't available when this was written. This uses a practical proxy: the
 * legs are treated as diverging if their (possibly extrapolated) crossing
 * point lies behind BOTH aircraft's current position on their own leg — i.e.
 * they've already passed the point they'd otherwise converge at, so they're
 * moving apart rather than towards each other. If this proxy doesn't match
 * the spec's intent, supply Paragraph 6.2.5.9 and this can be corrected.
 */
function classifyLegPairStandard(leg1Start, leg1End, leg2Start, leg2End, angle) {
    if (angle < CONFIG.sameTrackMaxAngle) return { reportType: 'Same', standard: 'Same' };
    if (angle > CONFIG.reciprocalMinAngle) return { reportType: 'Reciprocal', standard: 'Reciprocal' };

    if (angle < 90) {
        const crossPoint = lineIntersectionExtrapolated(leg1Start, leg1End, leg2Start, leg2End);
        if (crossPoint) {
            const progress1 = signedProgressAlongLeg(leg1Start, leg1End, crossPoint);
            const progress2 = signedProgressAlongLeg(leg2Start, leg2End, crossPoint);
            if (progress1 < 0 && progress2 < 0) {
                // Continuously Diverging Tracks exception — treat as same-direction.
                return { reportType: 'Same', standard: 'Same' };
            }
        }
        return { reportType: 'Crossing', standard: 'Same' };
    }

    // 90°-135° — opposite (reciprocal) direction separation standard applies.
    return { reportType: 'Crossing', standard: 'Reciprocal' };
}

/**
 * NAS-MD-4714 6.2.5.7.1.3: for a crossing leg pair, finds the geometric
 * crossing point and each aircraft's independently-estimated ETA there, and
 * returns their time differential. A conflict is declared purely on this
 * differential — even when the two aircraft's individual lateral-buffer
 * transit intervals (as computed by calculateAreaOfConflict) are disjoint,
 * since ETA estimates carry ~±3min uncertainty and the aircraft may still
 * cross in close proximity despite the buffer-transit windows not overlapping.
 */
function crossingTrackTimeDifferential(leg1Start, leg1End, leg2Start, leg2End) {
    const crossPoint = lineIntersectionExtrapolated(leg1Start, leg1End, leg2Start, leg2End);
    if (!crossPoint) return null;

    const eta1 = estimateEtaAtPoint(leg1Start, leg1End, crossPoint);
    const eta2 = estimateEtaAtPoint(leg2Start, leg2End, crossPoint);
    if (eta1 === null || eta2 === null) return null;

    return { crossPoint, eta1, eta2, timeDiff: Math.abs(eta1 - eta2) };
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
    // Per NAS-MD-4714 / ICAO Doc 9869 PBCS longitudinal separation standards
    const rnp4_1 = fdr1.rnp4 === true;
    const rnp4_2 = fdr2.rnp4 === true;
    const rnp10_1 = fdr1.rnp10 === true;
    const rnp10_2 = fdr2.rnp10 === true;
    const hasDatalink1 = fdr1.hasDatalink === true;
    const hasDatalink2 = fdr2.hasDatalink === true;
    const hasDme1 = fdr1.hasDme === true;
    const hasDme2 = fdr2.hasDme === true;

    // PBCS (RNP4 + RSP180 + P2 + CPDLC logged on) both aircraft — 20nm
    if (isPbcs(fdr1) && isPbcs(fdr2)) {
        return 20;
    }

    // RNP4 both aircraft (non-PBCS) — 30nm
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

/**
 * Interpolate an FDR's position along its route at a given UTC timestamp.
 * Returns {lat, lon} or null if the time is outside the route's ETO window.
 */
function interpolateFdrPositionAtTime(fdr, timeMs) {
    const route = fdr.parsedRoute;
    if (!route || route.length < 2) return null;

    for (let i = 1; i < route.length; i++) {
        const t0 = route[i - 1].eto ? new Date(route[i - 1].eto).getTime() : null;
        const t1 = route[i].eto ? new Date(route[i].eto).getTime() : null;
        if (t0 === null || t1 === null) continue;
        if (timeMs >= t0 && timeMs <= t1) {
            const ratio = (t1 > t0) ? (timeMs - t0) / (t1 - t0) : 0;
            return {
                lat: route[i - 1].lat + ratio * (route[i].lat - route[i - 1].lat),
                lon: route[i - 1].lon + ratio * (route[i].lon - route[i - 1].lon)
            };
        }
    }
    return null;
}

function calculateAreaOfConflict(fdr1, fdr2, lateralSep) {
    const conflictSegments = [];
    const route1 = fdr1.parsedRoute;
    const route2 = fdr2.parsedRoute;
    const bufferRadii = getLegBufferRadii(fdr1, lateralSep);
    
    for (let i = 1; i < route1.length; i++) {
        const polygon = createProtectedAirspace(
            route1[i - 1],
            route1[i],
            bufferRadii.left,
            bufferRadii.right
        );
        
        for (let j = 1; j < route2.length; j++) {
            const intersections = findPolygonLineIntersections(
                polygon,
                route2[j - 1],
                route2[j]
            );
            
            if (intersections.length >= 2) {
                // There's a conflict segment
                const t0 = interpolateTime(route2[j - 1], route2[j], intersections[0]);
                const t1 = interpolateTime(route2[j - 1], route2[j], intersections[1]);
                
                // Skip this segment if either endpoint has no ETO — we cannot place it in time.
                if (t0 === null || t1 === null) {
                    console.log(`[ConflictWorker]   ${fdr1.callsign} vs ${fdr2.callsign}: segment skipped — missing ETO on route2 waypoints (cannot determine conflict time)`);
                    continue;
                }
                
                // Ensure chronological order (intersection order != time order)
                const earlier = t0 <= t1 ? 0 : 1;
                const later = 1 - earlier;
                const segStartTime = Math.min(t0, t1);
                const segEndTime = Math.max(t0, t1);
                const segMidTime = (segStartTime + segEndTime) / 2;

                // Time-correlation check: verify fdr1 will actually be near the
                // conflict zone at the same time fdr2 will be there.
                // Find fdr1's position at fdr2's entry, mid, and exit times and
                // check whether fdr1 is inside the protection polygon. If fdr1 is
                // nowhere near the zone at those times the geographic overlap is a
                // false positive caused by the static-corridor approach.
                const checkTimes = [segStartTime, segMidTime, segEndTime];
                const fdr1PresentInZone = checkTimes.some(t => {
                    const pos = interpolateFdrPositionAtTime(fdr1, t);
                    if (!pos) return false;
                    return isPointInPolygonDirect(pos.lat, pos.lon, polygon);
                });

                if (!fdr1PresentInZone) {
                    // fdr1 is not in its own protection corridor at the time
                    // fdr2 passes through it — not a real-time conflict.
                    console.log(`[ConflictWorker]   ${fdr1.callsign} vs ${fdr2.callsign}: segment skipped — ${fdr1.callsign} not in zone at fdr2 entry/mid/exit times (time-correlation filter)`);
                    continue;
                }

                conflictSegments.push({
                    startLatLon: intersections[earlier],
                    endLatLon: intersections[later],
                    startTime: segStartTime,
                    endTime: segEndTime,
                    // Tag with the specific leg pair that produced this segment so the
                    // crossing-track longitudinal test (6.2.5.7.1.3) can compute the
                    // actual geometric crossing point for these two legs specifically,
                    // rather than the whole-route bearing.
                    route1Leg: { start: route1[i - 1], end: route1[i] },
                    route2Leg: { start: route2[j - 1], end: route2[j] }
                });
            }
        }
    }
    
    return conflictSegments;
}

/**
 * NAS-MD-4714 6.2.8.3.2.3 "Leg Deviation Buffer" (Figure 6-45): while an aircraft has an active
 * lateral deviation clearance, it could be anywhere within the deviation, so its protected-
 * airspace buffer widens by the deviation distance on the cleared side (left/right of track)
 * while the opposite side stays at the normal lateral separation minima.
 */
function getLegBufferRadii(fdr, baseRadius) {
    if (!fdr.hasDeviation || !(fdr.deviationNm > 0)) {
        return { left: baseRadius, right: baseRadius };
    }
    if (fdr.deviationDir === 'L') {
        return { left: baseRadius + fdr.deviationNm, right: baseRadius };
    }
    if (fdr.deviationDir === 'R') {
        return { left: baseRadius, right: baseRadius + fdr.deviationNm };
    }
    return { left: baseRadius, right: baseRadius };
}

/**
 * Builds the protected-airspace "stadium" polygon around a route leg. When radiusLeft and
 * radiusRight differ (an active deviation — see getLegBufferRadii), the end-cap semicircles
 * interpolate smoothly between the two so the buffer is exactly radiusLeft along the pure-left
 * offset line and radiusRight along the pure-right offset line, per Figure 6-45.
 */
function createProtectedAirspace(point1, point2, radiusLeft, radiusRight) {
    if (radiusRight === undefined) radiusRight = radiusLeft;
    const polygon = [];
    const track = calculateTrack(point1, point2);
    
    // Semicircle behind point1: sweeps from pure-left (angle=0) to pure-right (angle=180).
    for (let angle = 0; angle <= 180; angle += 15) {
        const heading = track - 90 - angle;
        const r = radiusLeft + (radiusRight - radiusLeft) * (angle / 180);
        polygon.push(calculatePointFromBearingDistance(point1, r, heading));
    }
    
    // Semicircle ahead of point2: sweeps from pure-right (angle=0) to pure-left (angle=180).
    for (let angle = 0; angle <= 180; angle += 15) {
        const heading = track + 90 - angle;
        const r = radiusRight + (radiusLeft - radiusRight) * (angle / 180);
        polygon.push(calculatePointFromBearingDistance(point2, r, heading));
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
    // If either endpoint has no ETO we cannot place this segment in time — skip it.
    if (!wp1.eto || !wp2.eto) return null;
    
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
    // Per NAS-MD-4714 Appendix A.3.82 DIR_TYPE
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

/**
 * Probe with a temporary virtual FDR. Temporarily replaces the original
 * callsign's data in the store, runs the full conflict probe, then
 * restores the original data. Returns results tagged as 'probeVirtualResults'.
 */
function probeVirtualFDR(data) {
    const { originalCallsign, virtualFDR } = data;
    console.log(`[ConflictWorker] probeVirtualFDR for ${originalCallsign} | proposed CFL=${virtualFDR.cfl}`);

    // Save the original FDR so we can restore it
    const originalFdr = fdrs.get(originalCallsign);

    // Temporarily inject the virtual FDR under the same callsign
    const parsed = parseRoute(virtualFDR.route, virtualFDR.routeWaypoints);
    fdrs.set(originalCallsign, {
        ...virtualFDR,
        callsign: originalCallsign,
        parsedRoute: parsed,
        updatedAt: Date.now()
    });

    // Run full conflict detection
    const results = probeAllConflicts();

    // Filter to only conflicts involving this callsign
    const relevant = (results.all || []).filter(
        c => c.intruderCallsign === originalCallsign || c.activeCallsign === originalCallsign
    );

    // Restore the original FDR (or remove if it didn't exist)
    if (originalFdr) {
        fdrs.set(originalCallsign, originalFdr);
    } else {
        fdrs.delete(originalCallsign);
    }

    console.log(`[ConflictWorker] probeVirtualFDR done: ${relevant.length} conflict(s) for ${originalCallsign}`);

    self.postMessage({
        type: 'probeVirtualResults',
        data: {
            callsign: originalCallsign,
            conflicts: groupConflicts(relevant),
            proposedProfile: {
                routeWaypoints: parsed.map(wp => ({
                    name: wp.name,
                    lat: wp.lat,
                    lon: wp.lon,
                    eto: wp.eto instanceof Date ? wp.eto.toISOString() : null
                }))
            }
        }
    });
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
