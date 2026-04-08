// WebSocket Connection
let ws = null;
let conflicts = [];
let currentFDR = null;
let useMockData = false;

// Conflict Worker
let conflictWorker = null;
let fdrCache = new Map(); // Cache FDRs received from plugin

// Window dragging state
let dragState = {
    isDragging: false,
    currentWindow: null,
    offsetX: 0,
    offsetY: 0
};

// Initialize window management
document.addEventListener('DOMContentLoaded', () => {
    initWindowDragging();
    initWindowActivation();
    initButtonHandlers();
    initConflictWorker();
    initSectorQueueClock();
    connectWebSocket();
    
    // Initial render of empty conflict table
    renderConflictTable();
    
    console.log('🚀 ATOP Webapp Initialized');
});

// Window Dragging
function initWindowDragging() {
    document.querySelectorAll('.motif-titlebar').forEach(titlebar => {
        titlebar.addEventListener('mousedown', startDrag);
    });
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDrag);
}

function startDrag(e) {
    const win = e.target.closest('.motif-window');
    if (!win) return;
    
    dragState.isDragging = true;
    dragState.currentWindow = win;
    dragState.offsetX = e.clientX - win.offsetLeft;
    dragState.offsetY = e.clientY - win.offsetTop;
    
    // Bring window to front and activate it
    activateWindow(win);
    
    e.preventDefault();
}

function drag(e) {
    if (!dragState.isDragging || !dragState.currentWindow) return;
    
    const newX = e.clientX - dragState.offsetX;
    const newY = e.clientY - dragState.offsetY;
    
    dragState.currentWindow.style.left = Math.max(0, newX) + 'px';
    dragState.currentWindow.style.top = Math.max(0, newY) + 'px';
}

function stopDrag() {
    dragState.isDragging = false;
    dragState.currentWindow = null;
}

// Window Activation (focus management)
function initWindowActivation() {
    document.querySelectorAll('.motif-window').forEach(win => {
        win.addEventListener('mousedown', () => activateWindow(win));
    });
}

function activateWindow(win) {
    // Deactivate all windows
    document.querySelectorAll('.motif-window').forEach(w => {
        w.classList.remove('active');
        w.style.zIndex = '1';
    });
    
    // Activate clicked window
    win.classList.add('active');
    win.style.zIndex = '100';
}

// Button Handlers
function initButtonHandlers() {
    // Close button - hide the window
    document.getElementById('btn-close')?.addEventListener('click', () => {
        const win = document.getElementById('flightplan-window');
        if (win) win.style.display = 'none';
    });
    
    // Modify button
    document.getElementById('btn-modify')?.addEventListener('click', () => {
        setFieldsEditable(true);
        showResponse('Fields are now editable');
    });
    
    // Update button
    document.getElementById('btn-update')?.addEventListener('click', () => {
        updateFDR('Update');
    });
    
    // Delete button
    document.getElementById('btn-delete')?.addEventListener('click', () => {
        updateFDR('Delete');
    });
    
    // VFR button - Open new FPEA with VFR defaults
    document.getElementById('btn-vfr')?.addEventListener('click', () => {
        clearFlightPlanForm();
        setInputValue('fp-fltrule', 'V');
        showResponse('New VFR flight plan');
    });
    
    // IFR button - Open new FPEA with IFR defaults
    document.getElementById('btn-ifr')?.addEventListener('click', () => {
        clearFlightPlanForm();
        setInputValue('fp-fltrule', 'I');
        showResponse('New IFR flight plan');
    });
    
    // New menu item
    document.querySelectorAll('.fp-menu-item').forEach(item => {
        if (item.textContent.includes('New')) {
            item.addEventListener('click', () => {
                clearFlightPlanForm();
                // Populate TIME with current time
                const now = new Date();
                const timeStr = now.toISOString().replace(/[-:T]/g, ' ').substring(0, 16);
                setInputValue('fp-time', timeStr);
                showResponse('New flight plan - TIME populated with current time');
            });
        }
    });
    
    // ACID field - Enter key to search
    document.getElementById('fp-acid')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const callsign = e.target.value.trim().toUpperCase();
            if (callsign) {
                requestFDR(callsign);
            } else {
                // Empty ACID - list all flight plans
                requestFlightPlanList();
            }
        }
    });
}

function clearFlightPlanForm() {
    document.querySelectorAll('.fp-input, .fp-textarea').forEach(el => {
        if (el.type === 'checkbox') {
            el.checked = false;
        } else {
            el.value = '';
        }
    });
    currentFDR = null;
}

function showResponse(message, isError = false) {
    const responseArea = document.getElementById('fp-response-content');
    if (responseArea) {
        const prefix = isError ? '(E) ' : '(I) ';
        responseArea.innerHTML = `<div class="${isError ? 'fp-message-error' : 'fp-message-info'}">${prefix}${message}</div>`;
    }
}

function requestFlightPlanList() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            Type: 'RequestFlightPlanList'
        }));
    }
}

// Try to connect to WebSocket
function connectWebSocket() {
    try {
        ws = new WebSocket('ws://localhost:8181');
        
        ws.onopen = () => {
            console.log('Connected to ATOP WebSocket');
            updateConnectionStatus('Connected', 'connected');
        };

        ws.onclose = () => {
            console.log('Disconnected from ATOP');
            updateConnectionStatus('Disconnected', 'disconnected');
            setTimeout(connectWebSocket, 5000);
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            updateConnectionStatus('Error', 'disconnected');
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            // Debug logging for all messages
            console.log('📨 WebSocket Message:', data.Type, data);
            
            switch (data.Type) {
                case 'FlightPlanUpdate':
                    handleFlightPlanUpdate(data);
                    break;
                case 'FlightPlanList':
                    handleFlightPlanList(data);
                    break;
                case 'AltitudeUpdate':
                    handleAltitudeUpdate(data);
                    break;
                case 'ConflictUpdate':
                    handleConflictUpdate(data);
                    break;
                case 'FDRBulkUpdate':
                    handleFDRBulkUpdate(data);
                    break;
                case 'FDRUpdate':
                    handleFDRUpdate(data);
                    break;
                case 'FDRRemove':
                    handleFDRRemove(data);
                    break;
                case 'ProbeRequest':
                    // C# plugin requests a conflict probe
                    handleProbeRequest(data);
                    break;
                case 'Error':
                    showError(data.Message);
                    showResponse(data.Message, true);
                    break;
            }
        };
    } catch (e) {
        console.error('Failed to create WebSocket:', e);
        updateConnectionStatus('Failed', 'disconnected');
    }
}

// Handle flight plan list response
function handleFlightPlanList(data) {
    const listContent = document.getElementById('fp-list-content');
    if (!listContent) return;
    
    listContent.innerHTML = '';
    
    if (data.FlightPlans && data.FlightPlans.length > 0) {
        data.FlightPlans.forEach(fp => {
            const item = document.createElement('div');
            item.className = 'fp-list-item';
            item.textContent = `${fp.Callsign.padEnd(8)} ${fp.SSRCode || '----'} ${fp.DepAirport || '----'} ${fp.ETD || ''} ${fp.DesAirport || '----'}`;
            item.addEventListener('click', () => {
                // Select this flight plan
                document.querySelectorAll('.fp-list-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                requestFDR(fp.Callsign);
            });
            listContent.appendChild(item);
        });
        
        showResponse(`'${data.FlightPlans.length}' flight plan(s) returned : ${Math.round(data.FlightPlans.length / 20)}% of 2000`);
    } else {
        showResponse('No flight plans found');
    }
}

function handleConflictUpdate(data) {
    const existingIndex = conflicts.findIndex(c => 
        c.ActiveCallsign === data.ActiveCallsign && 
        c.IntruderCallsign === data.IntruderCallsign
    );
    
    if (existingIndex >= 0) {
        conflicts[existingIndex] = data;
    } else {
        conflicts.push(data);
    }
    
    renderConflictTable();
}

function handleAltitudeUpdate(data) {
    const callsignEl = document.getElementById('callsign');
    const currentLevelEl = document.getElementById('current-level');
    const responseField = document.getElementById('response-field');
    
    if (callsignEl) callsignEl.value = data.Callsign || '';
    if (currentLevelEl) currentLevelEl.value = data.CurrentLevel || '';
    
    if (responseField) {
        responseField.textContent = data.ResponseStatus || '-';
        responseField.className = 'motif-response';
        
        if (data.ResponseStatus === 'OK') responseField.classList.add('ok');
        else if (data.ResponseStatus === 'ALERT') responseField.classList.add('alert');
        else if (data.ResponseStatus === 'WARN') responseField.classList.add('warning');
        else if (data.ResponseStatus === 'LOGIC') responseField.classList.add('logic');
    }
}

function handleFlightPlanUpdate(data) {
    currentFDR = data;
    console.log(`[FlightPlanUpdate] Received for ${data.Callsign} (state=${data.State}) - NOTE: this only updates the form UI, NOT the conflict worker`);
    
    // Update status header
    setTextContent('fp-callsign-display', data.Callsign || '-------');
    setTextContent('fp-dep-display', data.DepAirport || '----');
    setTextContent('fp-time-display', data.ETD || '---- --- -- ----');
    setTextContent('fp-dest-display', data.DesAirport || '----');
    
    // Update form fields
    setInputValue('fp-acid', data.Callsign);
    setInputValue('fp-fltrule', data.FlightRules);
    setInputValue('fp-flttype', '');
    setInputValue('fp-number', data.AircraftCount || '1');
    setInputValue('fp-actype', data.AircraftType);
    setInputValue('fp-wtc', data.AircraftWake);
    setInputValue('fp-radio', data.AircraftEquip);
    setInputValue('fp-survequip', data.AircraftSurvEquip);
    setInputValue('fp-dep', data.DepAirport);
    setInputValue('fp-time', data.ETD);
    setInputValue('fp-arr', data.DesAirport);
    setInputValue('fp-cx', '');
    setInputValue('fp-speed', data.TAS ? `N${data.TAS.toString().padStart(4, '0')}` : '');
    setInputValue('fp-level', data.RFL ? `F${data.RFL.toString().padStart(3, '0')}` : '');
    setInputValue('fp-route', data.Route);
    setInputValue('fp-dest', data.DesAirport);
    setInputValue('fp-ssrcode', data.SSRCode);
    setInputValue('fp-addr', '');
    setInputValue('fp-tail', '');
    setInputValue('fp-ssrmode', '');
    setInputValue('fp-altndest', data.AltAirport);
    setInputValue('fp-altndest2', '');
    setInputValue('fp-other', data.Remarks);
    
    const fpActive = document.getElementById('fp-active');
    if (fpActive) fpActive.checked = data.State !== 'STATE_INACTIVE';
    
    setFieldsEditable(data.HavePermission || !data.IsTrackedByMe);
}

function setTextContent(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
}

function setFieldsEditable(editable) {
    // Use the new fp-input and fp-textarea classes
    const inputs = document.querySelectorAll('.fp-input, .fp-textarea');
    inputs.forEach(input => {
        if (input.id !== 'fp-time') {
            input.disabled = !editable;
        }
    });
    
    const btnModify = document.getElementById('btn-modify');
    const btnUpdate = document.getElementById('btn-update');
    const btnDelete = document.getElementById('btn-delete');
    
    if (btnModify) btnModify.disabled = !editable;
    if (btnUpdate) btnUpdate.disabled = !editable;
    if (btnDelete) btnDelete.disabled = !editable;
}

function requestFDR(callsign) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            Type: 'RequestFDR',
            Callsign: callsign.toUpperCase()
        }));
    }
}

function updateFDR(action) {
    if (!currentFDR || !ws || ws.readyState !== WebSocket.OPEN) return;
    
    const request = {
        Type: 'UpdateFDR',
        Action: action,
        Callsign: document.getElementById('fp-acid')?.value || '',
        FlightRules: document.getElementById('fp-fltrule')?.value || '',
        AircraftCount: parseInt(document.getElementById('fp-number')?.value) || 1,
        AircraftType: document.getElementById('fp-actype')?.value || '',
        AircraftWake: document.getElementById('fp-wtc')?.value || '',
        AircraftEquip: document.getElementById('fp-radio')?.value || '',
        AircraftSurvEquip: document.getElementById('fp-survequip')?.value || '',
        DepAirport: document.getElementById('fp-dep')?.value || '',
        DesAirport: document.getElementById('fp-arr')?.value || '',
        AltAirport: document.getElementById('fp-altndest')?.value || '',
        TAS: parseInt(document.getElementById('fp-speed')?.value.replace(/\D/g, '')) || null,
        RFL: parseInt(document.getElementById('fp-level')?.value.replace(/\D/g, '')) || null,
        Route: document.getElementById('fp-route')?.value || '',
        Remarks: document.getElementById('fp-other')?.value || '',
        SSRCode: parseInt(document.getElementById('fp-ssrcode')?.value, 8) || null
    };
    
    ws.send(JSON.stringify(request));
}

function renderConflictTable() {
    const listContainer = document.getElementById('conflict-list');
    if (!listContainer) return;
    
    listContainer.innerHTML = '';
    
    if (conflicts.length === 0) {
        listContainer.innerHTML = '<div class="conflict-empty">No conflicts detected</div>';
    } else {
        conflicts.forEach((conflict, index) => {
            const row = document.createElement('div');
            row.className = `conflict-row status-${(conflict.status || conflict.Status || '').toLowerCase()}`;
            
            // Determine type symbol (>>X = crossing, >> = same, X = opposite)
            const typeSymbol = getTypeSymbol(conflict.conflictType || conflict.ConflictType);
            
            // Format times as HHMM
            const startTime = formatTimeHHMM(conflict.earliestLos || conflict.EarliestLos);
            const endTime = formatTimeHHMM(conflict.latestLos || conflict.LatestLos);
            
            row.innerHTML = `
                <span class="col-intruder">${conflict.intruderCallsign || conflict.IntruderCallsign || '-'}</span>
                <span class="col-att">-</span>
                <span class="col-active">${conflict.activeCallsign || conflict.ActiveCallsign || '-'}</span>
                <span class="col-att">-</span>
                <span class="col-ovrd">-</span>
                <span class="col-type">${typeSymbol}</span>
                <span class="col-time">${startTime}</span>
                <span class="col-time">${endTime}</span>
            `;
            
            row.onclick = () => {
                // Deselect all rows
                document.querySelectorAll('.conflict-row').forEach(r => r.classList.remove('selected'));
                row.classList.add('selected');
                showConflictReport(conflict);
            };
            
            listContainer.appendChild(row);
        });
    }
    
    const conflictCount = document.getElementById('conflict-count');
    if (conflictCount) conflictCount.textContent = `${conflicts.length} conflict(s)`;
}

function getTypeSymbol(type) {
    if (!type) return '-';
    const t = type.toLowerCase();
    if (t === 'crossing') return '>>X';
    if (t === 'same') return '>>';
    if (t === 'opposite') return 'X';
    return type;
}

function formatTimeHHMM(dateString) {
    if (!dateString) return '----';
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '----';
        const hours = date.getUTCHours().toString().padStart(2, '0');
        const mins = date.getUTCMinutes().toString().padStart(2, '0');
        return hours + mins;
    } catch {
        return '----';
    }
}

function showConflictReport(conflict) {
    const conflictType = conflict.conflictType || conflict.ConflictType;
    const trkAngle = conflict.trkAngle || conflict.TrkAngle;
    const latestLos = conflict.latestLos || conflict.LatestLos;
    const lateralSep = conflict.latSep || conflict.LateralSep;
    const verticalSep = conflict.verticalSep || conflict.VerticalSep;
    const verticalAct = conflict.verticalAct || conflict.VerticalAct;
    const intruderCallsign = conflict.intruderCallsign || conflict.IntruderCallsign;
    const activeCallsign = conflict.activeCallsign || conflict.ActiveCallsign;
    
    setTextContent('report-type', conflictType || '-');
    setTextContent('report-angle', trkAngle ? `${trkAngle.toFixed(1)}°` : '-');
    setTextContent('report-los', formatTime(latestLos));
    setTextContent('report-req-sep', `${lateralSep || '-'} nm / ${verticalSep || '-'} ft`);
    setTextContent('report-act-sep', `- nm / ${verticalAct || '-'} ft`);
    
    const intruderDetails = document.getElementById('intruder-details');
    if (intruderDetails) {
        intruderDetails.innerHTML = `<div><strong>Callsign:</strong> ${intruderCallsign || '-'}</div>`;
    }
    
    const activeDetails = document.getElementById('active-details');
    if (activeDetails) {
        activeDetails.innerHTML = `<div><strong>Callsign:</strong> ${activeCallsign || '-'}</div>`;
    }
    
    const conflictReport = document.getElementById('conflict-report');
    if (conflictReport) conflictReport.style.display = 'block';
}

function formatTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toTimeString().substring(0, 5);
}

function showError(message) {
    console.error('Server error:', message);
}

// ============================================
// SECTOR QUEUE WINDOW - Clock Update
// ============================================

function initSectorQueueClock() {
    updateSectorQueueClock();
    setInterval(updateSectorQueueClock, 1000);
}

function updateSectorQueueClock() {
    const now = new Date();
    
    // Format time as HH:MM:SS
    const timeStr = now.toTimeString().substring(0, 8);
    const timeEl = document.getElementById('sq-time');
    if (timeEl) timeEl.textContent = timeStr;
    
    // Format date as DD Mon YY
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = now.getDate().toString().padStart(2, '0');
    const month = months[now.getMonth()];
    const year = now.getFullYear().toString().slice(-2);
    const dateStr = `${day} ${month} ${year}`;
    
    const dateEl = document.getElementById('sq-date');
    if (dateEl) dateEl.textContent = dateStr;
}

// ============================================
// CONFLICT WORKER INTEGRATION
// ============================================

function initConflictWorker() {
    try {
        conflictWorker = new Worker('conflict-worker.js');
        
        conflictWorker.onmessage = function(e) {
            const { type, data } = e.data;
            
            switch (type) {
                case 'ready':
                    console.log('Conflict worker ready');
                    // Start automatic conflict checking
                    conflictWorker.postMessage({ type: 'start' });
                    break;
                    
                case 'conflictResults':
                    handleWorkerConflictResults(data);
                    break;
            }
        };
        
        conflictWorker.onerror = function(error) {
            console.error('Conflict worker error:', error);
        };
        
    } catch (e) {
        console.error('Failed to initialize conflict worker:', e);
    }
}

function handleWorkerConflictResults(results) {
    // Debug logging
    console.log('=== Conflict Results from Worker ===');
    console.log('Total conflicts:', results.all?.length || 0);
    console.log('Actual:', results.actual?.length || 0);
    console.log('Imminent:', results.imminent?.length || 0);
    console.log('Advisory:', results.advisory?.length || 0);
    if (results.all?.length > 0) {
        console.table(results.all.map(c => ({
            intruder: c.intruderCallsign,
            active: c.activeCallsign,
            status: c.status,
            type: c.conflictType,
            latSep: c.latSep + ' nm',
            vertSep: c.verticalAct + '/' + c.verticalSep + ' ft',
            trkAngle: (c.trkAngle ?? 0).toFixed(1) + '°',
            longTime: c.longTimeAct,
            longDist: c.longDistAct,
            earliestLos: c.earliestLos,
            latestLos: c.latestLos
        })));
    }
    
    // Update local conflicts array
    conflicts = results.all || [];
    
    // Render the conflict table
    renderConflictTable();
    
    // Send results back to plugin if connected
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            Type: 'ConflictResults',
            Conflicts: conflicts.map(c => ({
                IntruderCallsign: c.intruderCallsign,
                ActiveCallsign: c.activeCallsign,
                Status: c.status,
                ConflictType: c.conflictType,
                EarliestLos: c.earliestLos,
                LatestLos: c.latestLos,
                LateralSep: c.latSep,
                VerticalSep: c.verticalSep,
                VerticalAct: c.verticalAct,
                TrkAngle: c.trkAngle,
                StartLat: c.startLat,
                StartLon: c.startLon,
                EndLat: c.endLat,
                EndLon: c.endLon
            })),
            ActualCount: results.actual?.length || 0,
            ImminentCount: results.imminent?.length || 0,
            AdvisoryCount: results.advisory?.length || 0
        }));
    }
    
    // Update conflict count display
    updateConflictSummary(results);
}

function updateConflictSummary(results) {
    const summaryEl = document.getElementById('conflict-summary');
    if (summaryEl) {
        const actual = results.actual?.length || 0;
        const imminent = results.imminent?.length || 0;
        const advisory = results.advisory?.length || 0;
        
        summaryEl.innerHTML = `
            <span class="status-actual">ACT: ${actual}</span>
            <span class="status-imminent">IMM: ${imminent}</span>
            <span class="status-advisory">ADV: ${advisory}</span>
        `;
    }
}

function handleFDRBulkUpdate(data) {
    // Receive FDRs from plugin and send to worker
    if (!conflictWorker) {
        console.warn('[FDRBulkUpdate] No conflict worker available!');
        return;
    }
    
    const fdrs = data.FDRs || [];
    
    // Debug logging
    console.log('=== FDR Bulk Update Received ===');
    console.log('Total FDRs:', fdrs.length);
    if (fdrs.length > 0) {
        console.table(fdrs.map(f => ({
            callsign: f.Callsign,
            state: f.State,
            cfl: f.CFL,
            rfl: f.RFL,
            waypoints: f.RouteWaypoints?.length || 0
        })));
    } else {
        console.warn('[FDRBulkUpdate] WARNING: Received bulk update with 0 FDRs');
    }
    
    // Update cache
    fdrCache.clear();
    fdrs.forEach(fdr => fdrCache.set(fdr.Callsign, fdr));
    
    // Transform to worker format and send
    const workerFdrs = fdrs.map(fdr => ({
        callsign: fdr.Callsign,
        state: fdr.State,
        cfl: fdr.CFL,
        rfl: fdr.RFL,
        route: fdr.Route,
        routeWaypoints: fdr.RouteWaypoints || [],
        atd: fdr.ATD,
        depAirport: fdr.DepAirport,
        desAirport: fdr.DesAirport,
        aircraftType: fdr.AircraftType,
        groundSpeed: fdr.GroundSpeed,
        mach: fdr.Mach
    }));
    
    conflictWorker.postMessage({
        type: 'bulkUpdateFDRs',
        data: workerFdrs
    });
}

// Handle probe request from C# plugin (event-driven per ATOP spec 12.1.1)
function handleProbeRequest(data) {
    if (!conflictWorker) {
        console.warn('[ProbeRequest] No conflict worker available!');
        return;
    }
    
    console.log('=== Probe Request from C# ===');
    console.log('Callsign:', data.Callsign || 'ALL');
    console.log('FDRs in browser cache:', fdrCache.size);
    if (fdrCache.size === 0) {
        console.warn('[ProbeRequest] WARNING: No FDRs cached in browser - worker has nothing to probe!');
        console.warn('[ProbeRequest] The C# plugin sends FlightPlanUpdate messages but those only update the UI form.');
        console.warn('[ProbeRequest] FDRBulkUpdate or FDRUpdate messages are needed to feed the conflict worker.');
    }
    
    // Request probe from worker
    conflictWorker.postMessage({ type: 'requestProbe' });
}

function handleFDRUpdate(data) {
    // Single FDR update from plugin
    if (!conflictWorker) {
        console.warn('[FDRUpdate] No conflict worker available!');
        return;
    }
    
    const fdr = data.FDR;
    if (!fdr) {
        console.warn('[FDRUpdate] Received FDRUpdate but data.FDR is null/undefined:', data);
        return;
    }
    
    console.log(`[FDRUpdate] Feeding worker: ${fdr.Callsign} | state=${fdr.State} | CFL=${fdr.CFL} RFL=${fdr.RFL} | waypoints=${fdr.RouteWaypoints?.length || 0}`);
    
    fdrCache.set(fdr.Callsign, fdr);
    
    conflictWorker.postMessage({
        type: 'updateFDR',
        data: {
            callsign: fdr.Callsign,
            state: fdr.State,
            cfl: fdr.CFL,
            rfl: fdr.RFL,
            route: fdr.Route,
            routeWaypoints: fdr.RouteWaypoints || [],
            atd: fdr.ATD,
            depAirport: fdr.DepAirport,
            desAirport: fdr.DesAirport,
            aircraftType: fdr.AircraftType,
            groundSpeed: fdr.GroundSpeed,
            mach: fdr.Mach
        }
    });
}

function handleFDRRemove(data) {
    if (!conflictWorker) return;
    
    fdrCache.delete(data.Callsign);
    
    conflictWorker.postMessage({
        type: 'removeFDR',
        data: { callsign: data.Callsign }
    });
}

function requestConflictProbe() {
    if (conflictWorker) {
        conflictWorker.postMessage({ type: 'requestProbe' });
    }
}

function updateConnectionStatus(status, cssClass) {
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
        statusEl.textContent = status;
        statusEl.className = 'status ' + cssClass;
    }
}

// ============================================
// DEBUG FUNCTIONS - Call from browser console
// ============================================

// View all cached FDRs
window.debugFDRs = function() {
    console.log('=== Cached FDRs ===');
    console.log('Total:', fdrCache.size);
    console.table(Array.from(fdrCache.values()).map(f => ({
        callsign: f.Callsign,
        state: f.State,
        cfl: f.CFL,
        rfl: f.RFL,
        route: f.Route?.substring(0, 30) + '...',
        waypoints: f.RouteWaypoints?.length || 0
    })));
    return fdrCache;
};

// View all current conflicts
window.debugConflicts = function() {
    console.log('=== Current Conflicts ===');
    console.log('Total:', conflicts.length);
    if (conflicts.length > 0) {
        console.table(conflicts.map(c => ({
            intruder: c.intruderCallsign,
            active: c.activeCallsign,
            status: c.status,
            type: c.conflictType,
            latSep: c.latSep + 'nm',
            vertSep: c.verticalSep + 'ft',
            vertAct: c.verticalAct + 'ft',
            earliestLOS: c.earliestLos
        })));
    }
    return conflicts;
};

// Manually trigger a conflict probe
window.debugProbe = function() {
    console.log('Requesting manual conflict probe...');
    requestConflictProbe();
};

// Check WebSocket status
window.debugWS = function() {
    console.log('=== WebSocket Status ===');
    console.log('State:', ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'null');
    console.log('URL:', ws?.url);
    return ws;
};

// Check worker status
window.debugWorker = function() {
    console.log('=== Conflict Worker ===');
    console.log('Worker:', conflictWorker ? 'Active' : 'Not initialized');
    return conflictWorker;
};

// Send test FDR data to worker (for testing without vatSys)
window.debugTestConflict = function() {
    if (!conflictWorker) {
        console.error('Worker not initialized');
        return;
    }
    
    console.log('Sending test FDR data...');
    const testFdrs = [
        {
            callsign: 'TEST001',
            state: 'STATE_ACTIVE',
            cfl: 350,
            rfl: 350,
            route: 'TESTFIX TESTFIX2',
            routeWaypoints: [
                { name: 'TESTFIX', lat: 30.0, lon: -150.0, eto: new Date(Date.now() + 3600000).toISOString() },
                { name: 'TESTFIX2', lat: 35.0, lon: -145.0, eto: new Date(Date.now() + 7200000).toISOString() }
            ],
            atd: new Date().toISOString()
        },
        {
            callsign: 'TEST002',
            state: 'STATE_ACTIVE',
            cfl: 350,
            rfl: 350,
            route: 'TESTFIX TESTFIX2',
            routeWaypoints: [
                { name: 'TESTFIX', lat: 30.1, lon: -150.0, eto: new Date(Date.now() + 3600000).toISOString() },
                { name: 'TESTFIX2', lat: 35.1, lon: -145.0, eto: new Date(Date.now() + 7200000).toISOString() }
            ],
            atd: new Date().toISOString()
        }
    ];
    
    conflictWorker.postMessage({
        type: 'bulkUpdateFDRs',
        data: testFdrs
    });
    
    setTimeout(() => {
        conflictWorker.postMessage({ type: 'requestProbe' });
    }, 100);
    
    console.log('Test data sent. Check for conflict results...');
};

console.log('ATOP Conflict Debug Functions Loaded:');
console.log('  debugFDRs()      - View cached FDRs');
console.log('  debugConflicts() - View current conflicts');
console.log('  debugProbe()     - Trigger manual probe');
console.log('  debugWS()        - Check WebSocket status');
console.log('  debugWorker()    - Check worker status');
console.log('  debugTestConflict() - Test with fake data');
console.log('  debugMockConflicts() - Add mock conflicts for UI testing');

// Add mock conflicts directly for UI testing (no worker needed)
window.debugMockConflicts = function() {
    console.log('Adding mock conflicts for UI testing...');
    
    conflicts = [
        {
            intruderCallsign: 'SIA5',
            activeCallsign: 'MAS95',
            status: 'Actual',
            conflictType: 'Crossing',
            latSep: 50,
            verticalSep: 1000,
            verticalAct: 0,
            earliestLos: new Date(Date.now() + 1000 * 60 * 30).toISOString(),
            latestLos: new Date(Date.now() + 1000 * 60 * 90).toISOString(),
            trkAngle: 45
        },
        {
            intruderCallsign: 'QFA100',
            activeCallsign: 'ANZ17',
            status: 'Imminent',
            conflictType: 'Crossing',
            latSep: 50,
            verticalSep: 1000,
            verticalAct: 500,
            earliestLos: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
            latestLos: new Date(Date.now() + 1000 * 60 * 120).toISOString(),
            trkAngle: 90
        },
        {
            intruderCallsign: '*NWA96',
            activeCallsign: 'CAL032',
            status: 'Advisory',
            conflictType: 'Same',
            latSep: 50,
            verticalSep: 1000,
            verticalAct: 0,
            earliestLos: new Date(Date.now() + 1000 * 60 * 120).toISOString(),
            latestLos: new Date(Date.now() + 1000 * 60 * 180).toISOString(),
            trkAngle: 5
        },
        {
            intruderCallsign: '*NWA96',
            activeCallsign: 'HOA280',
            status: 'Advisory',
            conflictType: 'Same',
            latSep: 50,
            verticalSep: 1000,
            verticalAct: 0,
            earliestLos: new Date(Date.now() + 1000 * 60 * 120).toISOString(),
            latestLos: new Date(Date.now() + 1000 * 60 * 200).toISOString(),
            trkAngle: 8
        },
        {
            intruderCallsign: 'ACA004',
            activeCallsign: 'NWA28',
            status: 'Advisory',
            conflictType: 'Opposite',
            latSep: 50,
            verticalSep: 2000,
            verticalAct: 1000,
            earliestLos: new Date(Date.now() + 1000 * 60 * 150).toISOString(),
            latestLos: new Date(Date.now() + 1000 * 60 * 160).toISOString(),
            trkAngle: 175
        },
        {
            intruderCallsign: 'PAL101',
            activeCallsign: 'PAL102',
            status: 'Advisory',
            conflictType: 'Opposite',
            latSep: 50,
            verticalSep: 1000,
            verticalAct: 0,
            earliestLos: new Date(Date.now() + 1000 * 60 * 180).toISOString(),
            latestLos: new Date(Date.now() + 1000 * 60 * 190).toISOString(),
            trkAngle: 180
        }
    ];
    
    renderConflictTable();
    console.log('Added', conflicts.length, 'mock conflicts');
    return conflicts;
};