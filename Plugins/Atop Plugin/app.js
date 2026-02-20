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
    connectWebSocket();
    
    // Initial render of empty conflict table
    renderConflictTable();
    
    console.log('🚀 ATOP Webapp Initialized');
});

// Window Dragging
function initWindowDragging() {
    // Handle .motif-titlebar for motif-window class windows
    document.querySelectorAll('.motif-titlebar').forEach(titlebar => {
        titlebar.addEventListener('mousedown', startDrag);
    });
    
    // Handle sector-queue-window and conflict-report windows (by title bar with cursor:move)
    ['sector-queue-window', 'conflict-report'].forEach(id => {
        const win = document.getElementById(id);
        if (win) {
            const titlebar = win.querySelector('div[style*="cursor: move"]');
            if (titlebar) {
                titlebar.addEventListener('mousedown', (e) => startDragById(e, id));
            }
        }
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

// Start drag for windows identified by ID (sector-queue, conflict-report)
function startDragById(e, windowId) {
    const win = document.getElementById(windowId);
    if (!win) return;
    
    dragState.isDragging = true;
    dragState.currentWindow = win;
    dragState.offsetX = e.clientX - win.offsetLeft;
    dragState.offsetY = e.clientY - win.offsetTop;
    
    // Bring to front
    win.style.zIndex = '100';
    
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
    
    // Modify button - enables fields for editing existing FDR (like C# MODButton_Click)
    document.getElementById('btn-modify')?.addEventListener('click', () => {
        if (!currentFDR) {
            showResponse('No flight plan loaded. Enter ACID and press Enter first.', true);
            return;
        }
        // Save current state so we can revert on cancel/escape
        savedFDRState = JSON.parse(JSON.stringify(currentFDR));
        setFieldsEditable(true);
        setBtnState('btn-modify', false);
        setBtnState('btn-update', true);
        setBtnState('btn-delete', true);
        showResponse('Modify mode - edit fields then press Update to save, or Delete to remove');
    });
    
    // Update button - sends modifications to server (like C# EnterButton_Click in MOD mode)
    document.getElementById('btn-update')?.addEventListener('click', () => {
        if (!currentFDR) {
            showResponse('No flight plan loaded', true);
            return;
        }
        updateFDR('Modify');
        setFieldsEditable(false);
        setBtnState('btn-modify', true);
        setBtnState('btn-update', false);
        setBtnState('btn-delete', false);
        showResponse('Flight plan update sent');
    });
    
    // Delete button - sends delete/cancel request (like C# CancelButton_Click)
    document.getElementById('btn-delete')?.addEventListener('click', () => {
        if (!currentFDR) {
            showResponse('No flight plan loaded', true);
            return;
        }
        if (confirm(`Delete flight plan for ${currentFDR.Callsign}?`)) {
            updateFDR('Delete');
            showResponse(`Delete request sent for ${currentFDR.Callsign}`);
            clearFlightPlanForm();
            resetButtonStates();
        }
    });
    
    // VFR button - Clear and set up new VFR flight plan (like C# CreateButton in VFR mode)
    document.getElementById('btn-vfr')?.addEventListener('click', () => {
        clearFlightPlanForm();
        setInputValue('fp-fltrule', 'V');
        setInputValue('fp-number', '1');
        const now = new Date();
        setInputValue('fp-time', now.getUTCHours().toString().padStart(2,'0') + now.getUTCMinutes().toString().padStart(2,'0'));
        setFieldsEditable(true);
        setBtnState('btn-update', true);
        setBtnState('btn-modify', false);
        showResponse('New VFR flight plan - fill fields and press Update');
    });
    
    // IFR button - Clear and set up new IFR flight plan (like C# CreateButton in IFR mode)
    document.getElementById('btn-ifr')?.addEventListener('click', () => {
        clearFlightPlanForm();
        setInputValue('fp-fltrule', 'I');
        setInputValue('fp-number', '1');
        const now = new Date();
        setInputValue('fp-time', now.getUTCHours().toString().padStart(2,'0') + now.getUTCMinutes().toString().padStart(2,'0'));
        setFieldsEditable(true);
        setBtnState('btn-update', true);
        setBtnState('btn-modify', false);
        showResponse('New IFR flight plan - fill fields and press Update');
    });
    
    // New menu item
    document.querySelectorAll('.fp-menu-item').forEach(item => {
        if (item.textContent.includes('New')) {
            item.addEventListener('click', () => {
                clearFlightPlanForm();
                const now = new Date();
                setInputValue('fp-time', now.getUTCHours().toString().padStart(2,'0') + now.getUTCMinutes().toString().padStart(2,'0'));
                setFieldsEditable(true);
                setBtnState('btn-update', true);
                setBtnState('btn-modify', false);
                showResponse('New flight plan - fill fields and press Update');
            });
        }
    });
    
    // ACID field - Enter key to search (like C# ACIDField KeyDown handler)
    document.getElementById('fp-acid')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const callsign = e.target.value.trim().toUpperCase();
            if (callsign) {
                showResponse(`Searching for ${callsign}...`);
                requestFDR(callsign);
            } else {
                // Empty ACID - list all flight plans (like C# empty field behavior)
                requestFlightPlanList();
            }
        }
    });
    
    // Conflict Report - Close button (matching C# CloseButton_Click)
    document.getElementById('report-close-btn')?.addEventListener('click', () => {
        const reportWindow = document.getElementById('conflict-report');
        if (reportWindow) {
            reportWindow.style.display = 'none';
        }
        window.selectedConflict = null;
    });
}

// Saved FDR state for revert on escape/cancel
let savedFDRState = null;

function clearFlightPlanForm() {
    document.querySelectorAll('.fp-input, .fp-textarea').forEach(el => {
        if (el.type === 'checkbox') {
            el.checked = false;
        } else {
            el.value = '';
        }
    });
    currentFDR = null;
    savedFDRState = null;
}

// Enable/disable a button by ID
function setBtnState(id, enabled) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
}

// Reset all FP buttons to initial state (nothing loaded)
function resetButtonStates() {
    setBtnState('btn-modify', false);
    setBtnState('btn-update', false);
    setBtnState('btn-delete', false);
    setBtnState('btn-vfr', true);
    setBtnState('btn-ifr', true);
    setBtnState('btn-close', true);
    setFieldsEditable(false);
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
                case 'Error':
                    showError(data.Message);
                    showResponse(data.Message, true);
                    // If it's a search error, reset buttons
                    if (data.Message && data.Message.includes('not found')) {
                        resetButtonStates();
                    }
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
    
    // Populate form fields from FDR (like C# LoadFieldData)
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
    setInputValue('fp-teet', data.EET || '');
    setInputValue('fp-ssrcode', data.SSRCode);
    setInputValue('fp-addr', '');
    setInputValue('fp-ssrmode', '');
    setInputValue('fp-altndest', data.AltAirport);
    setInputValue('fp-altndest2', '');
    setInputValue('fp-other', data.Remarks);
    
    const fpActive = document.getElementById('fp-active');
    if (fpActive) fpActive.checked = data.State !== 'STATE_INACTIVE';
    
    // Set button states based on FDR state and permissions (like C# LoadFDR switch)
    const canModify = data.HavePermission || !data.IsTrackedByMe;
    const state = data.State || '';
    
    // Fields start read-only; user must click Modify to edit
    setFieldsEditable(false);
    
    // Enable Modify if we have permission to edit this FDR
    setBtnState('btn-modify', canModify);
    // Update/Delete only enabled after clicking Modify
    setBtnState('btn-update', false);
    setBtnState('btn-delete', canModify);
    
    // Build status info for response area
    const stateLabel = state.replace('STATE_', '').toLowerCase();
    const sectorInfo = data.ControllingSector ? ` [${data.ControllingSector}]` : '';
    const trackInfo = data.IsTrackedByMe ? ' (tracked by you)' : '';
    const permInfo = canModify ? '' : ' (read-only)';
    
    showResponse(`${data.Callsign} loaded — ${stateLabel}${sectorInfo}${trackInfo}${permInfo}`);
    console.log('📋 FDR Loaded:', data.Callsign, 'State:', state, 'Permission:', canModify);
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
    const inputs = document.querySelectorAll('.fp-input, .fp-textarea');
    inputs.forEach(input => {
        // ACID field always stays enabled (used for searching)
        // TIME field is read-only (populated from server)
        if (input.id === 'fp-acid') return;
        input.disabled = !editable;
    });
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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        showResponse('Not connected to server', true);
        return;
    }
    
    const callsign = document.getElementById('fp-acid')?.value?.trim().toUpperCase();
    if (!callsign) {
        showResponse('ACID is required', true);
        return;
    }
    
    // For Delete, we only need callsign and action
    if (action === 'Delete') {
        ws.send(JSON.stringify({
            Type: 'UpdateFDR',
            Action: 'Delete',
            Callsign: callsign
        }));
        return;
    }
    
    // For Modify/Create, gather all field data (like C# EnterButton_Click)
    const request = {
        Type: 'UpdateFDR',
        Action: action,
        Callsign: callsign,
        FlightRules: document.getElementById('fp-fltrule')?.value || '',
        AircraftCount: parseInt(document.getElementById('fp-number')?.value) || 1,
        AircraftType: document.getElementById('fp-actype')?.value || '',
        AircraftWake: document.getElementById('fp-wtc')?.value || '',
        AircraftEquip: document.getElementById('fp-radio')?.value || '',
        AircraftSurvEquip: document.getElementById('fp-survequip')?.value || '',
        DepAirport: document.getElementById('fp-dep')?.value || '',
        DesAirport: document.getElementById('fp-arr')?.value || document.getElementById('fp-dest')?.value || '',
        AltAirport: document.getElementById('fp-altndest')?.value || '',
        TAS: parseInt(document.getElementById('fp-speed')?.value?.replace(/\D/g, '')) || null,
        RFL: parseInt(document.getElementById('fp-level')?.value?.replace(/\D/g, '')) || null,
        Route: document.getElementById('fp-route')?.value || '',
        Remarks: document.getElementById('fp-other')?.value || '',
        SSRCode: parseInt(document.getElementById('fp-ssrcode')?.value, 8) || null
    };
    
    ws.send(JSON.stringify(request));
    console.log('📤 FDR Update sent:', action, callsign);
}

function renderConflictTable() {
    const listContainer = document.getElementById('conflict-list');
    if (!listContainer) return;
    
    listContainer.innerHTML = '';
    
    // Sort conflicts by earliest LOS time (matching C# OrderBy(t => t.EarliestLos))
    const sortedConflicts = [...conflicts].sort((a, b) => {
        const timeA = new Date(a.earliestLos || a.EarliestLos || 0).getTime();
        const timeB = new Date(b.earliestLos || b.EarliestLos || 0).getTime();
        return timeA - timeB;
    });
    
    // No "No conflicts" message - just show empty red area
    if (sortedConflicts.length > 0) {
        sortedConflicts.forEach((conflict, index) => {
            const row = document.createElement('div');
            const status = (conflict.status || conflict.Status || '').toLowerCase();
            
            // Row styling based on status
            let rowBg = '#d0d0b8';
            if (status === 'imminent') rowBg = '#ff6666';
            else if (status === 'actual') rowBg = '#ff9900';
            else if (status === 'advisory') rowBg = '#ffff66';
            
            row.style.cssText = `
                display: grid;
                grid-template-columns: 80px 30px 80px 30px 40px 50px 60px 60px;
                gap: 4px;
                padding: 4px 8px;
                background: ${rowBg};
                cursor: pointer;
                border-bottom: 1px solid #a0a090;
            `;
            
            // Get conflict symbol matching C# GetConflictSymbol
            const typeSymbol = getConflictSymbol(conflict);
            
            // Get attitude flags (matching C# intAtt.ConflictAttitudeFlag)
            const intAtt = getAttitudeFlag(conflict, 'intruder');
            const actAtt = getAttitudeFlag(conflict, 'active');
            
            // Format times as HHMM (matching C# ToString("HHmm"))
            const startTime = formatTimeHHMM(conflict.earliestLos || conflict.EarliestLos);
            const endTime = formatTimeHHMM(conflict.conflictEnd || conflict.ConflictEnd || conflict.latestLos || conflict.LatestLos);
            
            row.innerHTML = `
                <span style="overflow: hidden; text-overflow: ellipsis;">${(conflict.intruderCallsign || conflict.IntruderCallsign || '-').padEnd(7)}</span>
                <span>${intAtt}</span>
                <span style="overflow: hidden; text-overflow: ellipsis;">${(conflict.activeCallsign || conflict.ActiveCallsign || '-').padEnd(7)}</span>
                <span>${actAtt}</span>
                <span></span>
                <span>${typeSymbol}</span>
                <span>${startTime}</span>
                <span>${endTime}</span>
            `;
            
            row.onmouseover = () => { row.style.background = '#b0b0a0'; };
            row.onmouseout = () => { row.style.background = rowBg; };
            
            row.onclick = () => {
                // Deselect all rows
                document.querySelectorAll('#conflict-list > div').forEach(r => r.style.outline = 'none');
                row.style.outline = '2px solid #000';
                showConflictReport(conflict);
            };
            
            listContainer.appendChild(row);
        });
    }
    
    // Re-enable auto-hide for production
    const summaryWindow = document.getElementById('conflict-summary');
    if (summaryWindow) {
        summaryWindow.style.display = sortedConflicts.length > 0 ? 'block' : 'none';
    }
    if (sortedConflicts.length === 0) {
        const reportWindow = document.getElementById('conflict-report');
        if (reportWindow) reportWindow.style.display = 'none';
        window.selectedConflict = null;
    }
}

function getAttitudeFlag(conflict, aircraft) {
    // Match C# ConflictAttitudeFlag logic
    // Returns climb/descent indicator based on altitude changes
    return '';
}

function getConflictSymbol(conflict) {
    // Match C# AtopAircraftDisplayState.GetConflictSymbol
    const type = (conflict.conflictType || conflict.ConflictType || '').toLowerCase();
    const status = (conflict.status || conflict.Status || '').toLowerCase();
    
    let symbol = '';
    if (type === 'crossing') symbol = '>>X';
    else if (type === 'same') symbol = '>>';
    else if (type === 'reciprocal' || type === 'opposite') symbol = 'X';
    else symbol = '?';
    
    return symbol;
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
    // Extract all conflict data (matching C# DisplayConflictDetails)
    const conflictType = conflict.conflictType || conflict.ConflictType || 'unknown';
    const trkAngle = conflict.trkAngle || conflict.TrkAngle || 0;
    const latestLos = conflict.latestLos || conflict.LatestLos;
    const lateralSep = conflict.latSep || conflict.LateralSep || conflict.lateralSep || 0;
    const verticalSep = conflict.verticalSep || conflict.VerticalSep || 0;
    const verticalAct = conflict.verticalAct || conflict.VerticalAct || 0;
    const longTimeSep = conflict.longTimesep || conflict.LongTimeSep || 0;
    const longTimeAct = conflict.longTimeact || conflict.LongTimeAct || 0;
    const status = (conflict.status || conflict.Status || '').toLowerCase();
    
    // Intruder data
    const intruderCallsign = conflict.intruderCallsign || conflict.IntruderCallsign || '-';
    const intruderType = conflict.intruderType || conflict.IntruderType || '-';
    const intruderTAS = conflict.intruderTAS || conflict.IntruderTAS || '-';
    const intruderAlt = conflict.intruderAlt || conflict.IntruderAlt || '-';
    const intruderTop = conflict.intruderTop || conflict.IntruderTop || null;
    const intruderConfStart = conflict.intruderConfStart || conflict.IntruderConfStart || null;
    const intruderConfEnd = conflict.intruderConfEnd || conflict.IntruderConfEnd || null;
    
    // Active data
    const activeCallsign = conflict.activeCallsign || conflict.ActiveCallsign || '-';
    const activeType = conflict.activeType || conflict.ActiveType || '-';
    const activeTAS = conflict.activeTAS || conflict.ActiveTAS || '-';
    const activeAlt = conflict.activeAlt || conflict.ActiveAlt || '-';
    const activeTop = conflict.activeTop || conflict.ActiveTop || null;
    const activeConfStart = conflict.activeConfStart || conflict.ActiveConfStart || null;
    const activeConfEnd = conflict.activeConfEnd || conflict.ActiveConfEnd || null;
    
    // Update conflict type (just the type name, no label)
    setTextContent('report-conflict-type', conflictType.toLowerCase());
    
    // Update degrees (just the number, "degrees" is in the HTML)
    setTextContent('report-degrees', Math.round(trkAngle).toString());
    
    // Update LOS time with background color based on status
    const losTimeEl = document.getElementById('report-los-time');
    if (losTimeEl) {
        losTimeEl.textContent = formatTimeHHMMColon(latestLos);
        // Color based on status: Imminent = Emergency (red), otherwise Warning (orange)
        losTimeEl.style.background = status === 'imminent' ? '#ff0000' : '#ff8c00';
        losTimeEl.style.color = '#000000';
    }
    
    // Update required separation - format: "20 minutes ( 75 nm) 1000 ft"
    const reqMins = Math.round(longTimeSep / 60) || 20;
    const reqSepText = `${reqMins} minutes ( ${lateralSep || 75} nm) ${verticalSep || 1000} ft`;
    setTextContent('report-req-sep', reqSepText);
    
    // Update actual separation - format: "14 min 27 sec ( N/A ) 0 ft"
    const actMins = Math.floor((longTimeAct || 0) / 60);
    const actSecs = Math.floor((longTimeAct || 0) % 60);
    const actSepText = `${actMins} min ${actSecs} sec ( N/A ) ${verticalAct || 0} ft`;
    setTextContent('report-act-sep', actSepText);
    
    // Update Intruder row (table format)
    setTextContent('report-int-type', intruderType);
    setTextContent('report-int-callsign', intruderCallsign);
    setTextContent('report-int-tas', formatMach(intruderTAS));
    setTextContent('report-int-alt', intruderAlt ? `F${intruderAlt}` : '-');
    setInnerHTML('report-int-top', formatTopDataHtml(intruderTop, conflictType));
    setInnerHTML('report-int-conf-start', formatConfPointHtml(intruderConfStart));
    setInnerHTML('report-int-conf-end', formatConfPointHtml(intruderConfEnd));
    
    // Update Active row (table format)
    setTextContent('report-act-type', activeType);
    setTextContent('report-act-callsign', activeCallsign);
    setTextContent('report-act-tas', formatMach(activeTAS));
    setTextContent('report-act-alt', activeAlt ? `F${activeAlt}` : '-');
    setInnerHTML('report-act-top', formatTopDataHtml(activeTop, conflictType));
    setInnerHTML('report-act-conf-start', formatConfPointHtml(activeConfStart));
    setInnerHTML('report-act-conf-end', formatConfPointHtml(activeConfEnd));
    
    // Show the conflict report window
    const conflictReport = document.getElementById('conflict-report');
    if (conflictReport) {
        conflictReport.style.display = 'block';
        // Make it draggable
        makeDraggable(conflictReport);
    }
    
    // Store selected conflict for Draw button
    window.selectedConflict = conflict;
}

// Helper to set innerHTML
function setInnerHTML(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

// Format TAS as Mach number (e.g., "M084")
function formatMach(tas) {
    if (!tas) return '-';
    if (typeof tas === 'string' && tas.startsWith('M')) return tas;
    // Convert TAS to approximate Mach (very rough)
    const mach = Math.round(tas / 10);
    return `M${mach.toString().padStart(3, '0')}`;
}

// Format minutes from duration (matching C# ToString("mm"))
function formatMinutes(value) {
    if (!value) return '0';
    return Math.floor(value / 60).toString().padStart(2, '0');
}

// Format minutes and seconds (matching C# ToString("mm") + " min " + ToString("ss") + " sec")
function formatMinSec(value) {
    if (!value) return '0 min 0 sec';
    const mins = Math.floor(value / 60);
    const secs = Math.floor(value % 60);
    return `${mins} min ${secs} sec`;
}

// Format TOP (Track Overlap Point) data for reciprocal conflicts
function formatTopData(topData, conflictType) {
    if (!topData || conflictType.toLowerCase() !== 'reciprocal') return '-';
    // Format: lat/lon + time
    return formatLatLon(topData.latitude, topData.longitude) + '\n' + formatTimeHHMM(topData.time);
}

// Format conflict start/end point
function formatConfPoint(point) {
    if (!point || !point.latitude) return '-';
    return formatLatLon(point.latitude, point.longitude) + '\n' + formatTimeHHMM(point.time);
}

// Format TOP data as HTML with line breaks (for table cell display)
function formatTopDataHtml(topData, conflictType) {
    if (!topData || conflictType.toLowerCase() !== 'reciprocal') return '';
    const latStr = formatLatOnly(topData.latitude);
    const lonStr = formatLonOnly(topData.longitude);
    const timeStr = formatTimeHHMM(topData.time);
    return `${latStr}<br>${lonStr}<br>${timeStr}`;
}

// Format conflict point as HTML with line breaks (for table cell display)
function formatConfPointHtml(point) {
    if (!point || point.latitude === undefined) return '';
    const latStr = formatLatOnly(point.latitude);
    const lonStr = formatLonOnly(point.longitude);
    const timeStr = formatTimeHHMM(point.time);
    return `${latStr}<br>${lonStr}<br>${timeStr}`;
}

// Format latitude only (e.g., "3648N")
function formatLatOnly(lat) {
    if (lat === undefined) return '';
    const latDeg = Math.floor(Math.abs(lat));
    const latMin = Math.floor((Math.abs(lat) - latDeg) * 60);
    const latHem = lat >= 0 ? 'N' : 'S';
    return `${latDeg.toString().padStart(2, '0')}${latMin.toString().padStart(2, '0')}${latHem}`;
}

// Format longitude only (e.g., "06726W")  
function formatLonOnly(lon) {
    if (lon === undefined) return '';
    const lonDeg = Math.floor(Math.abs(lon));
    const lonMin = Math.floor((Math.abs(lon) - lonDeg) * 60);
    const lonHem = lon >= 0 ? 'E' : 'W';
    return `${lonDeg.toString().padStart(3, '0')}${lonMin.toString().padStart(2, '0')}${lonHem}`;
}

// Convert lat/lon to ARINC 424 format (matching C# ConvertToArinc424)
function formatLatLon(lat, lon) {
    if (lat === undefined || lon === undefined) return '-';
    
    const latDeg = Math.floor(Math.abs(lat));
    const latMin = Math.floor((Math.abs(lat) - latDeg) * 60);
    const latHem = lat >= 0 ? 'N' : 'S';
    
    const lonDeg = Math.floor(Math.abs(lon));
    const lonMin = Math.floor((Math.abs(lon) - lonDeg) * 60);
    const lonHem = lon >= 0 ? 'E' : 'W';
    
    return `${latDeg.toString().padStart(2, '0')}${latMin.toString().padStart(2, '0')}${latHem} ${lonDeg.toString().padStart(3, '0')}${lonMin.toString().padStart(2, '0')}${lonHem}`;
}

// Format time as HH:MM
function formatTimeHHMMColon(dateString) {
    if (!dateString) return '--:--';
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '--:--';
        const hours = date.getUTCHours().toString().padStart(2, '0');
        const mins = date.getUTCMinutes().toString().padStart(2, '0');
        return hours + ':' + mins;
    } catch {
        return '--:--';
    }
}

// Make a window draggable by its title bar
function makeDraggable(win) {
    const titlebar = win.querySelector('div[style*="cursor: move"]') || win.firstElementChild;
    if (!titlebar || titlebar.dataset.draggable === 'true') return;
    
    titlebar.dataset.draggable = 'true';
    titlebar.addEventListener('mousedown', (e) => {
        if (e.target !== titlebar) return;
        
        const offsetX = e.clientX - win.offsetLeft;
        const offsetY = e.clientY - win.offsetTop;
        
        function onMouseMove(e) {
            win.style.left = Math.max(0, e.clientX - offsetX) + 'px';
            win.style.top = Math.max(0, e.clientY - offsetY) + 'px';
        }
        
        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    });
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
            vertSep: c.verticalAct + '/' + c.verticalSep + 'ft'
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
                TrkAngle: c.trkAngle
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
    if (!conflictWorker) return;
    
    const fdrs = data.FDRs || [];
    
    // Debug logging
    console.log('=== FDR Bulk Update Received ===');
    console.log('Total FDRs:', fdrs.length);
    if (fdrs.length > 0) {
        console.table(fdrs.slice(0, 10).map(f => ({
            callsign: f.Callsign,
            state: f.State,
            cfl: f.CFL,
            rfl: f.RFL,
            waypoints: f.RouteWaypoints?.length || 0
        })));
        if (fdrs.length > 10) console.log(`... and ${fdrs.length - 10} more`);
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

function handleFDRUpdate(data) {
    // Single FDR update from plugin
    if (!conflictWorker) return;
    
    const fdr = data.FDR;
    if (!fdr) return;
    
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
    
    // Update sector queue network status
    // Map connection status to ATOP network display (LIVE, SB1, SB2, or DISCONNECTED)
    let networkStatus = 'DISCONNECTED';
    if (cssClass === 'connected') {
        networkStatus = 'LIVE';  // Could be LIVE, SB1, SB2 based on server status
    }
    if (window.updateSectorQueueNetwork) {
        window.updateSectorQueueNetwork(networkStatus);
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