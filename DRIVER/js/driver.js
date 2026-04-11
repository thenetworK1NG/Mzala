import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import { getDatabase, ref, onChildRemoved, onValue, get, update, onDisconnect, runTransaction, remove, push, set } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js';

const firebaseConfig = {
  apiKey: "AIzaSyDOK9DF3u9JXzfi7PYExrCDQX09vNN_c3k",
  authDomain: "uber-system-e73d6.firebaseapp.com",
  projectId: "uber-system-e73d6",
  storageBucket: "uber-system-e73d6.firebasestorage.app",
  messagingSenderId: "482805503804",
  appId: "1:482805503804:web:fa126da66cf3efcf45b039",
  measurementId: "G-CC559WX63X",
  databaseURL: "https://uber-system-e73d6-default-rtdb.firebaseio.com/"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const statusEl = document.getElementById('status');
const statusTextEl = statusEl ? statusEl.querySelector('.status-text') : null;
const listEl = document.getElementById('requests');
const refreshBtn = document.getElementById('refreshBtn');
const mapEl = document.getElementById('map');
const driverSelect = document.getElementById('driverSelect');
const selectDriverBtn = document.getElementById('selectDriverBtn');
const identityModal = document.getElementById('identityModal');
const changeIdentityBtn = document.getElementById('changeIdentityBtn');
const startShiftBtn = document.getElementById('startShiftBtn');
const stopShiftBtn = document.getElementById('stopShiftBtn');
const homeScreen = document.getElementById('homeScreen');
const onlineScreen = document.getElementById('onlineScreen');
const bottomBar = document.getElementById('bottomBar');
const emptyState = document.getElementById('emptyState');
const greetingLabel = document.getElementById('greetingLabel');
const greetingName = document.getElementById('greetingName');
const profileBtn = document.getElementById('profileBtn');

let selectedDriverId = null;
let selectedDriverName = null;
let shiftActive = false;
let watchId = null;
let onDisconnectHandler = null;

let map = null;
let driverLatLng = null;
let driverMarker = null;
let routeLayer = null;
let destMarker = null;
let popupMap = null;
let popupDriverMarker = null;
let popupDestMarker = null;
let popupRouteLayer = null;
let popupOriginMarker = null;
let popupUserRouteLayer = null;
let showDriverRoute = true;
let showPassengerRoute = true;
let popupStopMarkers = [];

// ===== Active ride state =====
let activeRideKey = null;       // Firebase key of the accepted ride
let activeRideData = null;      // Full ride request data
let currentStopIndex = 0;       // Which stop we're navigating to (0-based)
let navRouteLayer = null;       // Current navigation route polyline
let navTargetMarker = null;     // Current nav destination marker
let lastNavFetchTime = 0;       // Throttle nav re-routes to avoid OSRM hammering
let lastNavLatLng = null;       // Last position used for nav route fetch
const NAV_REROUTE_INTERVAL = 10000; // Min ms between OSRM re-routes
const NAV_REROUTE_DISTANCE = 50;    // Min meters moved before re-route

// ===== Map matching (road snap) =====
let mapMatchingEnabled = false;
try { mapMatchingEnabled = sessionStorage.getItem('roadSnap') === '1'; } catch(e){}

// ===== Heading tracking for Garmin arrow =====
let currentHeading = 0; // degrees, 0 = north

// ===== Add Stop mode (disables map auto-center) =====
let addingStopMode = false;

// Snap GPS coords to nearest road via OSRM
async function snapToRoad(lat, lng){
  try {
    const resp = await fetch(`https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`);
    if (!resp.ok) return { lat, lng };
    const data = await resp.json();
    if (data && data.code === 'Ok' && data.waypoints && data.waypoints.length) {
      const wp = data.waypoints[0].location; // [lng, lat]
      return { lat: wp[1], lng: wp[0] };
    }
  } catch(e) { console.error('Snap to road failed', e); }
  return { lat, lng }; // fallback to raw GPS
}

// Smooth marker animation using requestAnimationFrame
function animateMarker(marker, fromLatLng, toLatLng, duration){
  if (!marker || !fromLatLng || !toLatLng) return;
  const start = performance.now();
  const fLat = fromLatLng.lat || fromLatLng[0];
  const fLng = fromLatLng.lng || fromLatLng[1];
  const tLat = toLatLng.lat || toLatLng[0];
  const tLng = toLatLng.lng || toLatLng[1];
  function step(now){
    const elapsed = now - start;
    const t = Math.min(elapsed / duration, 1);
    const lat = fLat + (tLat - fLat) * t;
    const lng = fLng + (tLng - fLng) * t;
    marker.setLatLng([lat, lng]);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setStatus(msg){
  if(statusTextEl) statusTextEl.textContent = msg;
  else if(statusEl) statusEl.textContent = msg;
}

function getGreeting(){
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function updateGreeting(){
  if (greetingLabel) greetingLabel.textContent = getGreeting();
  if (greetingName) greetingName.textContent = selectedDriverName || '';
}

function showScreen(screen){
  if (homeScreen) homeScreen.style.display = screen === 'home' ? '' : 'none';
  if (onlineScreen) onlineScreen.style.display = screen === 'online' ? '' : 'none';
  if (bottomBar) bottomBar.style.display = screen === 'online' ? '' : 'none';
}

function haversine(a, b){
  // a and b are {lat,lng}
  const toRad = d => d * Math.PI / 180;
  const R = 6371e3; // meters
  const phi1 = toRad(a.lat), phi2 = toRad(b.lat);
  const dphi = toRad(b.lat - a.lat), dlambda = toRad(b.lng - a.lng);
  const x = Math.sin(dphi/2) * Math.sin(dphi/2) + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlambda/2)*Math.sin(dlambda/2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  return R * c;
}

function renderItem(key, data, distanceMeters){
  const el = document.createElement('div');
  el.className = 'req';
  el.id = `req-${key}`;
  const whenTs = data.timestamp || Date.now();
  const when = timeAgo(whenTs);
  const distText = (typeof distanceMeters === 'number') ? `${(distanceMeters/1000).toFixed(1)} km away` : `Distance unknown`;
  // rider info
  const riderName = (data.rider && data.rider.username) ? data.rider.username : 'Unknown rider';
  const riderPhone = (data.rider && data.rider.phone) ? data.rider.phone : '—';
  const hasPhone = data.rider && data.rider.phone;
  const waLink = hasPhone ? `https://wa.me/${data.rider.phone.replace(/[^0-9]/g, '')}` : '#';
  const waBtn = hasPhone ? `<a href="${waLink}" target="_blank" rel="noopener" class="wa-btn" title="Chat on WhatsApp"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg> WhatsApp</a>` : '';

  // Passenger count & price info
  const paxCount = data.passengers || 1;
  const paxText = paxCount === 1 ? '1 passenger' : `${paxCount} passengers`;
  const priceText = data.totalPrice ? `R${data.totalPrice}` : '';
  const hikeTag = data.isHikeZone ? ' <span class="hike-tag">HIKE</span>' : '';

  // Stop count (no coordinates)
  const stopCount = (data.stops && Array.isArray(data.stops)) ? data.stops.length : 1;
  const stopsText = stopCount === 1 ? '1 stop' : `${stopCount} stops`;

  const leftHtml = `<div class="left"><div class="title">${riderName} <span class="pax-badge">${paxText}</span>${hikeTag}</div><div class="rider-phone">📞 ${riderPhone} ${waBtn}</div><div class="meta">${stopsText} · ${when} · ${distText}${priceText ? ' · ' + priceText : ''}</div></div>`;
  // actions: View, Accept/In progress depending on state
  const actions = document.createElement('div');
  actions.className = 'actions';
  const openBtn = document.createElement('button'); openBtn.className = 'go'; openBtn.textContent = 'View';
  openBtn.onclick = () => { showRequestOnMap(data, key); };
  actions.appendChild(openBtn);

  if (data && data.acceptedBy) {
    if (data.acceptedBy === selectedDriverId) {
      const prog = document.createElement('div'); prog.className = 'meta'; prog.style.color = '#06c167'; prog.style.fontWeight = '600'; prog.textContent = 'In progress';
      actions.appendChild(prog);
    } else {
      const taken = document.createElement('div'); taken.className = 'meta'; taken.style.color = '#c33'; taken.textContent = 'Taken'; actions.appendChild(taken);
    }
  } else {
    const acc = document.createElement('button'); acc.className = 'accept'; acc.textContent = 'Accept';
    acc.onclick = () => { acceptRequest(key); };
    actions.appendChild(acc);
  }
  el.appendChild(document.createRange().createContextualFragment(leftHtml));
  el.appendChild(actions);
  return el;
}

async function acceptRequest(key){
  if (!selectedDriverId) return alert('Sign in as a driver first');
  if (!shiftActive) return alert('Start your shift before accepting rides');
  if (activeRideKey) return alert('You already have an active ride. Complete it first.');
  const r = ref(db, 'ride_requests/' + key);
  try{
    const result = await runTransaction(r, (current) => {
      if (!current) return current; // disappeared
      if (current.acceptedBy) return; // already taken
      current.acceptedBy = selectedDriverId;
      current.acceptedAt = Date.now();
      current.status = 'accepted';
      return current;
    });
    if (!result.committed) {
      alert('Request already accepted by another driver');
      return;
    }
    // Store active ride state
    const snap = await get(r);
    activeRideData = snap.val();
    activeRideKey = key;
    currentStopIndex = 0;
    saveActiveRide();
    setStatus('Accepted request — opening map');
    // Update driver rideStatus
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { rideStatus: 'picking_up' }); }catch(e){}
    // Auto-open the map modal and lock it
    await showRequestOnMap(activeRideData, key);
    lockMapModal();
    showRideActionButtons('accepted');
  }catch(e){ console.error('Accept failed', e); alert('Failed to accept request'); }
}

async function completeRequest(key){
  if (!selectedDriverId) return alert('Sign in as a driver first');
  const r = ref(db, 'ride_requests/' + key);
  try{
    // Show trip summary before completing
    if (activeRideData) {
      await showTripSummary(activeRideData);
    }
    // Set completed then remove
    await update(r, { status: 'completed' });
    // Small delay so passenger listener picks up the status before removal
    setTimeout(async () => {
      try { await remove(r); } catch(e){}
    }, 1500);
    clearActiveRide();
    setStatus('Ride completed — request removed');
  }catch(e){ console.error('Complete failed', e); alert('Failed to complete request'); }
}

// ===== Trip Summary Modal (two-step: Done → Receipt → Payment Received) =====
function showTripSummary(rideData){
  return new Promise((resolve) => {
    const modal = document.getElementById('tripSummaryModal');
    if (!modal) { resolve(); return; }
    const riderEl = document.getElementById('tripRider');
    const paxEl = document.getElementById('tripPax');
    const stopsEl = document.getElementById('tripStops');
    const hikeRow = document.getElementById('tripHikeRow');
    const totalEl = document.getElementById('tripTotal');
    const doneBtn = document.getElementById('tripSummaryDoneBtn');
    const receiptSection = document.getElementById('tripReceipt');
    const paymentBtn = document.getElementById('tripPaymentReceivedBtn');
    // Populate summary
    if (riderEl) riderEl.textContent = (rideData.rider && rideData.rider.username) || 'Unknown';
    if (paxEl) paxEl.textContent = rideData.passengers || 1;
    if (stopsEl) stopsEl.textContent = (rideData.stops && rideData.stops.length) || 1;
    if (hikeRow) hikeRow.classList.toggle('hidden', !rideData.isHikeZone);
    if (totalEl) totalEl.textContent = `R${rideData.totalPrice || 0}`;
    // Hide receipt initially
    if (receiptSection) receiptSection.classList.add('hidden');
    if (doneBtn) doneBtn.style.display = '';
    modal.style.display = 'flex';
    // Step 1: "Done" reveals receipt
    const doneHandler = () => {
      doneBtn.removeEventListener('click', doneHandler);
      doneBtn.style.display = 'none';
      // Populate receipt
      const rateEl = document.getElementById('tripRate');
      const rpaxEl = document.getElementById('tripReceiptPax');
      const rstopsEl = document.getElementById('tripReceiptStops');
      const rhikeRow = document.getElementById('tripReceiptHikeRow');
      const rtotalEl = document.getElementById('tripReceiptTotal');
      if (rateEl) rateEl.textContent = `R${rideData.pricePerPerson || 0}`;
      if (rpaxEl) rpaxEl.textContent = rideData.passengers || 1;
      if (rstopsEl) rstopsEl.textContent = (rideData.stops && rideData.stops.length) || 1;
      if (rhikeRow) rhikeRow.classList.toggle('hidden', !rideData.isHikeZone);
      if (rtotalEl) rtotalEl.textContent = `R${rideData.totalPrice || 0}`;
      if (receiptSection) receiptSection.classList.remove('hidden');
    };
    if (doneBtn) doneBtn.addEventListener('click', doneHandler);
    // Step 2: "Payment Received" completes and resolves
    const payHandler = () => {
      paymentBtn.removeEventListener('click', payHandler);
      modal.style.display = 'none';
      if (receiptSection) receiptSection.classList.add('hidden');
      resolve();
    };
    if (paymentBtn) paymentBtn.addEventListener('click', payHandler);
  });
}

// ===== Map modal lock/unlock for active ride =====
function lockMapModal(){
  const closeBtn = document.getElementById('mapModalClose');
  if (closeBtn) closeBtn.classList.add('disabled');
  // Hide bottom bar buttons during active ride
  if (refreshBtn) refreshBtn.style.display = 'none';
  if (stopShiftBtn) stopShiftBtn.style.display = 'none';
  const snapBtn = document.getElementById('roadSnapBtn');
  if (snapBtn) snapBtn.style.display = 'none';
  if (bottomBar) bottomBar.style.display = 'none';
}

function unlockMapModal(){
  const closeBtn = document.getElementById('mapModalClose');
  if (closeBtn) closeBtn.classList.remove('disabled');
  // Restore bottom bar
  if (refreshBtn) refreshBtn.style.display = '';
  if (stopShiftBtn) stopShiftBtn.style.display = '';
  const snapBtn = document.getElementById('roadSnapBtn');
  if (snapBtn) snapBtn.style.display = '';
  if (bottomBar) bottomBar.style.display = '';
}

function clearActiveRide(){
  activeRideKey = null;
  activeRideData = null;
  currentStopIndex = 0;
  lastNavFetchTime = 0;
  lastNavLatLng = null;
  addingStopMode = false;
  // Clear persisted ride state
  try{ localStorage.removeItem('activeRide'); }catch(e){}
  // Clear nav route layer
  if (navRouteLayer && popupMap) { try{ popupMap.removeLayer(navRouteLayer); }catch(e){} navRouteLayer = null; }
  if (navTargetMarker && popupMap) { try{ popupMap.removeLayer(navTargetMarker); }catch(e){} navTargetMarker = null; }
  // Hide nav banner and ride actions
  const navBanner = document.getElementById('navBanner');
  if (navBanner) navBanner.style.display = 'none';
  const rideActions = document.getElementById('rideActions');
  if (rideActions) rideActions.style.display = 'none';
  const panicBtn = document.getElementById('panicBtn');
  if (panicBtn) { panicBtn.style.display = 'none'; panicBtn.classList.remove('pressing','sent'); }
  unlockMapModal();
  closeMapModal();
  // Clear driver rideStatus
  if (selectedDriverId) {
    try{ update(ref(db, 'drivers/'+selectedDriverId), { rideStatus: null }); }catch(e){}
  }
}

// ===== Persist / restore active ride to survive app exit =====
function saveActiveRide(){
  try{
    localStorage.setItem('activeRide', JSON.stringify({
      key: activeRideKey,
      data: activeRideData,
      stopIndex: currentStopIndex
    }));
  }catch(e){}
}

async function restoreActiveRide(){
  try{
    const raw = localStorage.getItem('activeRide');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !saved.key) return;
    // Verify ride still exists in Firebase
    const snap = await get(ref(db, 'ride_requests/' + saved.key));
    const data = snap.val();
    if (!data || data.status === 'completed' || !data.acceptedBy) {
      localStorage.removeItem('activeRide');
      return;
    }
    // Restore state
    activeRideKey = saved.key;
    activeRideData = data; // use fresh Firebase data
    currentStopIndex = saved.stopIndex || 0;
    setStatus('Resuming active ride…');
    await showRequestOnMap(activeRideData, activeRideKey);
    lockMapModal();
    const state = activeRideData.status === 'picked_up' ? 'picked_up' : 'accepted';
    showRideActionButtons(state);
    if (state === 'picked_up') {
      const navBanner = document.getElementById('navBanner');
      if (navBanner) navBanner.style.display = 'flex';
      lastNavFetchTime = 0;
      lastNavLatLng = null;
      updateNavigation();
    }
    setStatus(state === 'picked_up' ? 'Ride in progress — navigating' : 'Ride accepted — heading to pickup');
  }catch(e){ console.error('Failed to restore active ride', e); }
}

// ===== Ride action button visibility =====
function showRideActionButtons(state){
  const rideActions = document.getElementById('rideActions');
  const pickedUpBtn = document.getElementById('pickedUpBtn');
  const nextStopBtn = document.getElementById('nextStopBtn');
  const tripDoneBtn = document.getElementById('tripDoneBtn');
  const addStopMidBtn = document.getElementById('addStopMidBtn');
  const panicBtn = document.getElementById('panicBtn');
  if (!rideActions) return;
  rideActions.style.display = 'flex';
  // Hide all first
  if (pickedUpBtn) pickedUpBtn.style.display = 'none';
  if (nextStopBtn) nextStopBtn.style.display = 'none';
  if (tripDoneBtn) tripDoneBtn.style.display = 'none';
  if (addStopMidBtn) addStopMidBtn.style.display = 'none';
  // Show panic button during active ride
  if (panicBtn) panicBtn.style.display = '';

  if (state === 'accepted') {
    // Driver has accepted but hasn't picked up yet — show "Picked Up"
    if (pickedUpBtn) pickedUpBtn.style.display = '';
  } else if (state === 'picked_up') {
    // Ride in progress — show navigation controls
    const stops = activeRideData && activeRideData.stops ? activeRideData.stops : [];
    const hasMoreStops = stops.length > 1 && currentStopIndex < stops.length - 1;
    if (hasMoreStops) {
      if (nextStopBtn) nextStopBtn.style.display = '';
    }
    if (addStopMidBtn) addStopMidBtn.style.display = '';
    if (tripDoneBtn) tripDoneBtn.style.display = '';
  }
}

// ===== Garmin-style navigation =====
// Get turn arrow character from OSRM modifier
function getTurnIcon(modifier, type){
  if (type === 'arrive') return '🏁';
  if (type === 'depart') return '🚗';
  switch(modifier){
    case 'left': case 'sharp left': return '⬅';
    case 'slight left': return '↰';
    case 'right': case 'sharp right': return '➡';
    case 'slight right': return '↱';
    case 'uturn': return '↩';
    case 'straight': default: return '⬆';
  }
}

function updateNavBanner(instruction, distance, modifier, type){
  const banner = document.getElementById('navBanner');
  const iconEl = document.getElementById('navBannerIcon');
  const textEl = document.getElementById('navBannerText');
  const distEl = document.getElementById('navBannerDist');
  if (!banner) return;
  banner.style.display = 'flex';
  if (iconEl) iconEl.textContent = getTurnIcon(modifier, type);
  if (textEl) textEl.textContent = instruction || 'Continue on route';
  if (distEl) {
    if (typeof distance === 'number') {
      distEl.textContent = distance >= 1000 ? `${(distance/1000).toFixed(1)} km` : `${Math.round(distance)} m`;
    } else {
      distEl.textContent = '';
    }
  }
}

// Fetch OSRM route with turn-by-turn steps from driver position to target
async function fetchNavRoute(fromLatLng, toLatLng){
  try {
    const fromLonLat = `${fromLatLng.lng},${fromLatLng.lat}`;
    const toLonLat = `${toLatLng.lng},${toLatLng.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLonLat};${toLonLat}?overview=full&geometries=geojson&alternatives=false&steps=true`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) return null;
    return data.routes[0];
  } catch(e) { console.error('Nav route fetch error', e); return null; }
}

// Update the navigation display on the popup map
async function updateNavigation(){
  if (!activeRideKey || !activeRideData || !driverLatLng || !popupMap) return;
  // Determine current navigation target
  const target = getNavTarget();
  if (!target) return;
  // Throttle: only re-fetch route if enough time passed or driver moved significantly
  const now = Date.now();
  const moved = lastNavLatLng ? haversine(driverLatLng, lastNavLatLng) : Infinity;
  if (now - lastNavFetchTime < NAV_REROUTE_INTERVAL && moved < NAV_REROUTE_DISTANCE) {
    // Just update map center to follow driver (skip if placing a new stop)
    if (!addingStopMode) { try { popupMap.setView([driverLatLng.lat, driverLatLng.lng], Math.max(popupMap.getZoom(), 16)); } catch(e){} }
    return;
  }
  lastNavFetchTime = now;
  lastNavLatLng = { lat: driverLatLng.lat, lng: driverLatLng.lng };
  const route = await fetchNavRoute(driverLatLng, target);
  if (!route) return;
  // Draw route on map
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
  if (navRouteLayer) { try{ popupMap.removeLayer(navRouteLayer); }catch(e){} }
  navRouteLayer = L.polyline(coords, { color: '#06c167', weight: 6, opacity: 0.9 }).addTo(popupMap);
  // Update turn instruction from first step of first leg
  if (route.legs && route.legs.length && route.legs[0].steps && route.legs[0].steps.length > 1) {
    const nextStep = route.legs[0].steps[1]; // step[0] is usually "depart", step[1] is first real turn
    const maneuver = nextStep.maneuver || {};
    const instruction = nextStep.name ? `${maneuver.type === 'turn' ? 'Turn' : maneuver.type || 'Continue'} onto ${nextStep.name}` : (maneuver.type || 'Continue');
    updateNavBanner(instruction, nextStep.distance, maneuver.modifier, maneuver.type);
  } else if (route.legs && route.legs[0] && route.legs[0].steps && route.legs[0].steps.length === 1) {
    updateNavBanner('Arriving at destination', route.legs[0].distance, null, 'arrive');
  }
  // Center map on driver position at street level (skip if placing a new stop)
  if (!addingStopMode) { try { popupMap.setView([driverLatLng.lat, driverLatLng.lng], Math.max(popupMap.getZoom(), 16)); } catch(e){} }
}

// Get the current navigation target (next stop or final destination)
function getNavTarget(){
  if (!activeRideData) return null;
  const stops = activeRideData.stops && Array.isArray(activeRideData.stops) ? activeRideData.stops : [];
  // If we have stops and currentStopIndex is valid, navigate to that stop
  if (stops.length > 0 && currentStopIndex < stops.length) {
    const s = stops[currentStopIndex];
    if (typeof s.lat === 'number') return { lat: s.lat, lng: s.lng };
  }
  // Fallback to final destination
  if (activeRideData.destination && typeof activeRideData.destination.lat === 'number') {
    return { lat: activeRideData.destination.lat, lng: activeRideData.destination.lng };
  }
  return null;
}

function timeAgo(ts){
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff} seconds ago`;
  const mins = Math.floor(diff/60);
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.floor(hrs/24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

// --- Driver identity management ---
function populateDrivers(snapshot){
  const list = snapshot.val() || {};
  if (!driverSelect) return;
  // clear, keep default
  const cur = driverSelect.value;
  driverSelect.innerHTML = '<option value="">-- Select driver identity --</option>';
  Object.keys(list).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = list[k].name || ('Driver ' + k.slice(0,6));
    driverSelect.appendChild(opt);
  });
  // restore if possible
  if (cur) driverSelect.value = cur;
  // if driver previously signed in on this device, auto-select
  const saved = localStorage.getItem('driverId');
  if (saved && !selectedDriverId) {
    // if the saved id exists in the list, set it
    const opt = Array.from(driverSelect.options).find(o => o.value === saved);
    if (opt) {
      setIdentityFromId(saved).catch(e=>console.error(e));
    }
  }
}

if (driverSelect) {
  // listen for drivers list
  onValue(ref(db, 'drivers'), snapshot => populateDrivers(snapshot));
}

if (selectDriverBtn) selectDriverBtn.addEventListener('click', async ()=>{
  const id = driverSelect.value;
  if (!id) return alert('Choose a driver identity first');
  try{
    await setIdentityFromId(id);
    // persist
    localStorage.setItem('driverId', id);
  }catch(e){ console.error(e); }
});

async function setIdentityFromId(id){
  if (!id) return;
  selectedDriverId = id;
  const snap = await get(ref(db, 'drivers/'+id));
  const val = snap.val() || {};
  selectedDriverName = val.name || '';
  updateGreeting();
  // DO NOT mark online yet — driver must press Go Online
  setStatus('Signed in');
  // hide modal if visible
  if (identityModal) identityModal.style.display = 'none';
  if (changeIdentityBtn) changeIdentityBtn.style.display = 'inline-block';
}

if (changeIdentityBtn) changeIdentityBtn.addEventListener('click', ()=>{
  if (identityModal) identityModal.style.display = 'flex';
});

if (profileBtn) profileBtn.addEventListener('click', ()=>{
  if (identityModal) identityModal.style.display = 'flex';
});

// mark offline on unload
window.addEventListener('beforeunload', ()=>{
  if (selectedDriverId && shiftActive) {
    try{ update(ref(db, 'drivers/'+selectedDriverId), { online: false, active: false, lastSeen: Date.now() }); }catch(e){}
    try{ if (onDisconnectHandler) onDisconnectHandler.cancel(); }catch(e){}
  }
});

// ===== Active status broadcasting via Visibility API =====
document.addEventListener('visibilitychange', ()=>{
  if (!selectedDriverId || !shiftActive) return;
  const isActive = document.visibilityState === 'visible';
  try{ update(ref(db, 'drivers/'+selectedDriverId), { active: isActive, lastSeen: Date.now() }); }catch(e){}
});

async function ensureMap(){
  if (map) return;
  map = L.map(mapEl, {zoomControl:true}).setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'networKING Technology'}).addTo(map);
  if (map && map.attributionControl && typeof map.attributionControl.setPrefix === 'function') {
    map.attributionControl.setPrefix('');
  }
  // Leaflet needs to invalidate size when container may have changed
  setTimeout(()=>{ try { map.invalidateSize(); } catch(e){} }, 200);
}

async function showRequestOnMap(reqData, key){
  // open popup modal and use the popup map so driver sees a larger map
  openMapModal();
  await ensurePopupMap();
  if (!driverLatLng) {
    setStatus('Driver location unknown — start your shift or refresh location');
    return;
  }
  // clear previous on popup map
  if (popupDestMarker) { try{ popupMap.removeLayer(popupDestMarker); }catch(e){} popupDestMarker = null; }
  if (popupOriginMarker) { try{ popupMap.removeLayer(popupOriginMarker); }catch(e){} popupOriginMarker = null; }
  if (popupRouteLayer) { try{ popupMap.removeLayer(popupRouteLayer); }catch(e){} popupRouteLayer = null; }
  if (popupUserRouteLayer) { try{ popupMap.removeLayer(popupUserRouteLayer); }catch(e){} popupUserRouteLayer = null; }
  popupStopMarkers.forEach(m => { try{ popupMap.removeLayer(m); }catch(e){} });
  popupStopMarkers = [];
    // Determine origin (where passenger was when requesting) and dest (where passenger wants to go)
    let origin = null;
    let dest = null;
    if (reqData.origin && typeof reqData.origin.lat === 'number') {
      origin = { lat: reqData.origin.lat, lng: reqData.origin.lng };
    } else if (reqData.geometry && Array.isArray(reqData.geometry) && reqData.geometry.length) {
      origin = { lat: reqData.geometry[0][0], lng: reqData.geometry[0][1] };
    } else if (typeof reqData.lat === 'number') {
      origin = { lat: reqData.lat, lng: reqData.lng };
    }

    if (reqData.destination && typeof reqData.destination.lat === 'number') {
      dest = { lat: reqData.destination.lat, lng: reqData.destination.lng };
    } else if (reqData.geometry && Array.isArray(reqData.geometry) && reqData.geometry.length) {
      const last = reqData.geometry[reqData.geometry.length - 1];
      dest = { lat: last[0], lng: last[1] };
    } else {
      dest = null;
    }
    if (origin) {
      popupOriginMarker = L.marker([origin.lat, origin.lng]).addTo(popupMap).bindPopup('Passenger pickup');
    }
    if (dest) {
      popupDestMarker = L.marker([dest.lat, dest.lng]).addTo(popupMap).bindPopup('Final destination').openPopup();
    }

    // Draw numbered markers for each stop (if multi-stop ride)
    if (reqData.stops && Array.isArray(reqData.stops) && reqData.stops.length > 1) {
      reqData.stops.forEach((s, i) => {
        if (typeof s.lat !== 'number') return;
        const icon = L.divIcon({
          className: 'stop-number-icon',
          html: `<div style="background:#e67e22;color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)">${i+1}</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });
        const m = L.marker([s.lat, s.lng], { icon }).addTo(popupMap).bindPopup(`Stop ${i+1}`);
        popupStopMarkers.push(m);
      });
    }
  if (!popupDriverMarker) {
    const arrowIcon = L.divIcon({
      className: 'driver-arrow-icon',
      html: `<svg viewBox="0 0 32 32" fill="#06c167" xmlns="http://www.w3.org/2000/svg" style="transform:rotate(${currentHeading}deg);transition:transform 0.3s ease"><polygon points="16,2 28,28 16,22 4,28"/></svg>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
    popupDriverMarker = L.marker([driverLatLng.lat, driverLatLng.lng], {icon: arrowIcon}).addTo(popupMap).bindPopup('You');
  } else popupDriverMarker.setLatLng([driverLatLng.lat, driverLatLng.lng]);

  // request route from OSRM (driver -> passenger pickup), prefer origin; fallback to destination
  const routeTarget = origin || dest;
  if (routeTarget) {
    try{
      const fromLonLat = `${driverLatLng.lng},${driverLatLng.lat}`;
      const toLonLat = `${routeTarget.lng},${routeTarget.lat}`;
      const url = `https://router.project-osrm.org/route/v1/driving/${fromLonLat};${toLonLat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const resp = await fetch(url);
      if (resp.ok){
        const data = await resp.json();
        if (data && data.routes && data.routes.length){
          const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
          popupRouteLayer = L.polyline(coords, {color:'#1978c8', weight:4});
          if (showDriverRoute) popupRouteLayer.addTo(popupMap);
          const bounds = popupRouteLayer.getBounds();
          popupMap.fitBounds(bounds, {padding:[40,40]});
        }
      }
    } catch(e){ console.error('Route error', e); }
  }
    // draw passenger origin->destination as a yellow line (use provided geometry if available)
    try{
      if (reqData.geometry && Array.isArray(reqData.geometry) && reqData.geometry.length) {
        popupUserRouteLayer = L.polyline(reqData.geometry, {color:'yellow', weight:4});
        if (showPassengerRoute) popupUserRouteLayer.addTo(popupMap);
        popupMap.fitBounds(popupUserRouteLayer.getBounds(), {padding:[40,40]});
      } else if (origin && dest) {
        popupUserRouteLayer = L.polyline([[origin.lat, origin.lng],[dest.lat, dest.lng]], {color:'yellow', weight:4});
        if (showPassengerRoute) popupUserRouteLayer.addTo(popupMap);
        const bounds = popupUserRouteLayer.getBounds();
        popupMap.fitBounds(bounds, {padding:[40,40]});
      } else {
        // fallback: show both markers
        const group = [];
        if (origin) group.push([origin.lat, origin.lng]);
        if (dest) group.push([dest.lat, dest.lng]);
        if (group.length) popupMap.fitBounds(group, {padding:[40,40]});
      }
    } catch(e){ console.error('Route draw error', e); }
}

function updateDriverRouteVisibility(){
  if (!popupMap) return;
  if (popupRouteLayer) {
    if (showDriverRoute && !popupMap.hasLayer(popupRouteLayer)) popupRouteLayer.addTo(popupMap);
    if (!showDriverRoute && popupMap.hasLayer(popupRouteLayer)) popupMap.removeLayer(popupRouteLayer);
  }
}

function updatePassengerRouteVisibility(){
  if (!popupMap) return;
  if (popupUserRouteLayer) {
    if (showPassengerRoute && !popupMap.hasLayer(popupUserRouteLayer)) popupUserRouteLayer.addTo(popupMap);
    if (!showPassengerRoute && popupMap.hasLayer(popupUserRouteLayer)) popupMap.removeLayer(popupUserRouteLayer);
  }
}

// Popup map support

function openMapModal(){
  const modal = document.getElementById('mapModal');
  if (!modal) return;
  modal.style.display = 'flex';
  // ensure popup map container visible
  setTimeout(()=>{ try{ const btn = document.getElementById('mapModalClose'); if(btn) btn.focus(); }catch(e){} },200);
}

function closeMapModal(){
  const modal = document.getElementById('mapModal');
  if (!modal) return;
  modal.style.display = 'none';
}

async function ensurePopupMap(){
  if (popupMap) { try{ popupMap.invalidateSize(); }catch(e){} return; }
  const popupEl = document.getElementById('mapPopup');
  if (!popupEl) return;
  popupMap = L.map(popupEl, {zoomControl:true}).setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'networKING Technology'}).addTo(popupMap);
  if (popupMap && popupMap.attributionControl && typeof popupMap.attributionControl.setPrefix === 'function') {
    popupMap.attributionControl.setPrefix('');
  }
  setTimeout(()=>{ try{ popupMap.invalidateSize(); }catch(e){} }, 200);
}

// wire close button (respects ride lock)
const modalCloseBtn = document.getElementById('mapModalClose');
if (modalCloseBtn) modalCloseBtn.addEventListener('click', () => {
  if (activeRideKey) return; // locked during active ride
  closeMapModal();
});

// Toggle controls in modal (buttons exist in DOM)
const toggleDriverPathBtn = document.getElementById('toggleDriverPathBtn');
const togglePassengerRouteBtn = document.getElementById('togglePassengerRouteBtn');
if (toggleDriverPathBtn) {
  toggleDriverPathBtn.addEventListener('click', () => {
    showDriverRoute = !showDriverRoute;
    toggleDriverPathBtn.textContent = showDriverRoute ? 'Driver route' : 'Driver route';
    toggleDriverPathBtn.classList.toggle('active', showDriverRoute);
    updateDriverRouteVisibility();
  });
  toggleDriverPathBtn.textContent = 'Driver route';
  toggleDriverPathBtn.classList.toggle('active', showDriverRoute);
}
if (togglePassengerRouteBtn) {
  togglePassengerRouteBtn.addEventListener('click', () => {
    showPassengerRoute = !showPassengerRoute;
    togglePassengerRouteBtn.textContent = 'Passenger route';
    togglePassengerRouteBtn.classList.toggle('active', showPassengerRoute);
    updatePassengerRouteVisibility();
  });
  togglePassengerRouteBtn.textContent = 'Passenger route';
  togglePassengerRouteBtn.classList.toggle('active', showPassengerRoute);
}

const reqRef = ref(db, 'ride_requests');

// Cache of last-rendered data keyed by request id, used for diffing
let renderedKeys = [];
let renderedDataHash = {};

// Sound for new incoming requests
const requestSound = new Audio('sounds/request.mp3');

function dataHash(val){
  // lightweight signature to detect meaningful changes
  const a = val.acceptedBy || '';
  const s = val.status || '';
  const t = val.timestamp || 0;
  const rn = (val.rider && val.rider.username) || '';
  return `${a}|${s}|${t}|${rn}`;
}

function renderSnapshot(snapshot){
  if (!snapshot.exists()) {
    listEl.innerHTML = '';
    renderedKeys = [];
    renderedDataHash = {};
    if (emptyState) emptyState.style.display = '';
    setStatus('No active requests');
    return;
  }
  const items = [];
  snapshot.forEach(child => { items.push({key: child.key, val: child.val()}); });
  // filter out requests accepted by other drivers
  const filtered = items.filter(i => { return !(i.val && i.val.acceptedBy && i.val.acceptedBy !== selectedDriverId); });
  // compute distances if driver known
  if (driverLatLng) {
    filtered.forEach(i => {
      const origin = i.val && i.val.origin ? { lat: i.val.origin.lat, lng: i.val.origin.lng } : (i.val.lat ? { lat: i.val.lat, lng: i.val.lng } : null);
      if (origin) i.dist = haversine(driverLatLng, origin);
      else i.dist = Infinity;
    });
    filtered.sort((a,b) => (a.dist||0) - (b.dist||0));
  }

  const newKeys = filtered.map(i => i.key);
  const newHashMap = {};
  filtered.forEach(i => { newHashMap[i.key] = dataHash(i.val); });

  // Play request sound if there are NEW un-accepted request keys
  const oldKeySet = new Set(renderedKeys);
  const hasNewRequest = newKeys.some(k => !oldKeySet.has(k) && !newHashMap[k].startsWith(selectedDriverId));
  if (hasNewRequest && shiftActive) requestSound.play().catch(()=>{});

  // Remove items no longer present
  const newKeySet = new Set(newKeys);
  renderedKeys.forEach(k => {
    if (!newKeySet.has(k)) {
      const old = document.getElementById(`req-${k}`);
      if (old) old.remove();
    }
  });

  // Add or update items in correct order
  filtered.forEach((i, idx) => {
    const existing = document.getElementById(`req-${i.key}`);
    if (existing && renderedDataHash[i.key] === newHashMap[i.key]) {
      // No data change — just ensure correct order
      if (listEl.children[idx] !== existing) {
        listEl.insertBefore(existing, listEl.children[idx] || null);
      }
    } else {
      // New or changed — build fresh element
      const el = renderItem(i.key, i.val, i.dist);
      if (existing) {
        existing.replaceWith(el);
      } else {
        listEl.insertBefore(el, listEl.children[idx] || null);
      }
    }
  });

  renderedKeys = newKeys;
  renderedDataHash = newHashMap;

  // manage empty state
  if (emptyState) emptyState.style.display = filtered.length ? 'none' : '';
  if (shiftActive) setStatus('Online \u00b7 ' + filtered.length + ' ride' + (filtered.length !== 1 ? 's' : ''));
}

onValue(reqRef, snapshot => { renderSnapshot(snapshot); });

onChildRemoved(reqRef, (snap) => {
  const el = document.getElementById(`req-${snap.key}`);
  if (el) el.remove();
});

setStatus('Ready');

// location handling
async function updateDriverLocation(pos){
  let lat = pos.coords.latitude;
  let lng = pos.coords.longitude;
  // Apply road snap if enabled
  if (mapMatchingEnabled) {
    const snapped = await snapToRoad(lat, lng);
    lat = snapped.lat;
    lng = snapped.lng;
  }
  const oldLatLng = driverLatLng ? { lat: driverLatLng.lat, lng: driverLatLng.lng } : null;
  driverLatLng = { lat, lng };
  // Calculate heading from previous position for Garmin arrow
  if (oldLatLng && (oldLatLng.lat !== lat || oldLatLng.lng !== lng)) {
    const dLng = (lng - oldLatLng.lng) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat * Math.PI / 180);
    const x = Math.cos(oldLatLng.lat * Math.PI / 180) * Math.sin(lat * Math.PI / 180) - Math.sin(oldLatLng.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.cos(dLng);
    currentHeading = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }
  // Rotate the arrow icon on popup map
  if (popupDriverMarker) {
    const el = popupDriverMarker.getElement();
    if (el) {
      const svg = el.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${currentHeading}deg)`;
    }
  }
  // Smooth marker animation on popup map (during navigation)
  if (popupMap && popupDriverMarker && oldLatLng) {
    animateMarker(popupDriverMarker, oldLatLng, driverLatLng, 500);
  } else if (popupMap && popupDriverMarker) {
    popupDriverMarker.setLatLng([lat, lng]);
  }
  // Do not create or show the main map automatically; only update marker if main map exists
  if (map) {
    if (!driverMarker) driverMarker = L.marker([lat, lng]).addTo(map).bindPopup('You');
    else if (oldLatLng) animateMarker(driverMarker, oldLatLng, driverLatLng, 500);
    else driverMarker.setLatLng([lat, lng]);
    try{ map.setView([lat, lng], 13); }catch(e){}
  }
  // trigger a reload of list ordering
  const ev = new Event('reorderRequests');
  listEl.dispatchEvent(ev);
  // update driver record in database if identity selected AND shift active
  if (selectedDriverId && shiftActive) {
    try{
      await update(ref(db, 'drivers/'+selectedDriverId), { lat, lng, lastSeen: Date.now(), online: true });
    }catch(e){ console.error('Failed to update driver location', e); }
  }
  // Update Garmin-style navigation if we have an active picked-up ride
  if (activeRideKey && activeRideData && (activeRideData.status === 'picked_up' || activeRideData.status === 'in_progress')) {
    updateNavigation();
  }
}

if (refreshBtn) refreshBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Geolocation not supported'); return; }
  if (!shiftActive) { setStatus('Start your shift first'); return; }
  setStatus('Refreshing location…');
  navigator.geolocation.getCurrentPosition(pos => { updateDriverLocation(pos); setStatus('Location refreshed'); }, err => { setStatus('Location error'); console.error(err); }, {enableHighAccuracy:true, timeout:10000});
});

// Start shift flow — requests and map are hidden until shift begins
async function startShift(){
  if (!selectedDriverId) {
    // show identity modal so driver can sign in
    if (identityModal) identityModal.style.display = 'flex';
    return;
  }
  const gpsOverlay = document.getElementById('gpsOverlay');
  if (!navigator.geolocation) {
    if (gpsOverlay) gpsOverlay.style.display = 'flex';
    return;
  }
  // Check location permission before attempting geolocation
  try {
    if (navigator.permissions) {
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      if (perm.state === 'denied') {
        if (gpsOverlay) gpsOverlay.style.display = 'flex';
        return;
      }
    }
  } catch(e) { /* permissions API not supported, continue anyway */ }
  setStatus('Starting shift — obtaining location…');
  try{
    // initial position
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {enableHighAccuracy:true, timeout:10000});
    });
    await updateDriverLocation(pos);
    // mark driver online + active
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { online: true, active: true, lastSeen: Date.now() }); }catch(e){ console.error('Failed to set online', e); }
    // register onDisconnect fallback so if the driver loses connection or closes the browser
    // the DB will mark them offline + inactive automatically
    try{
      onDisconnectHandler = onDisconnect(ref(db, 'drivers/'+selectedDriverId));
      await onDisconnectHandler.update({ online: false, active: false, lastSeen: Date.now() });
    }catch(e){ console.error('Failed to set onDisconnect', e); }
    // show UI (requests only). main map remains hidden until the driver opens a request
    showScreen('online');
    // start continuous updates
    watchId = navigator.geolocation.watchPosition(async p => { await updateDriverLocation(p); }, err => { console.error('watch error', err); }, {enableHighAccuracy:true, maximumAge:2000, timeout:10000});
    shiftActive = true;
    setStatus('Online');
    if (statusEl) statusEl.classList.add('online');
    // toggle buttons
    if (startShiftBtn) startShiftBtn.style.display = 'none';
    if (stopShiftBtn) stopShiftBtn.style.display = '';
    // hide main map by default
    const mapc = document.getElementById('map'); if (mapc) mapc.style.display = 'none';
    // Restore active ride if one was in progress before app exit
    await restoreActiveRide();
  }catch(e){
    console.error('Start shift failed', e);
    const gpsOverlay = document.getElementById('gpsOverlay');
    if (gpsOverlay) gpsOverlay.style.display = 'flex';
  }
}

if (startShiftBtn) startShiftBtn.addEventListener('click', startShift);

// GPS retry button
const gpsRetryBtn = document.getElementById('gpsRetryBtn');
if (gpsRetryBtn) gpsRetryBtn.addEventListener('click', () => {
  const gpsOverlay = document.getElementById('gpsOverlay');
  if (gpsOverlay) gpsOverlay.style.display = 'none';
  startShift();
});

// Stop shift (clean shutdown)
async function stopShift(){
  if (!shiftActive) return;
  if (activeRideKey) return alert('You have an active ride. Complete it before going offline.');
  // stop geo watch
  try{ if (watchId && navigator.geolocation) navigator.geolocation.clearWatch(watchId); }catch(e){}
  watchId = null;
  shiftActive = false;
  // cancel onDisconnect and mark offline + inactive
  if (onDisconnectHandler) {
    try{ await onDisconnectHandler.cancel(); }catch(e){}
    onDisconnectHandler = null;
  }
  if (selectedDriverId) {
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { online: false, active: false, lastSeen: Date.now() }); }catch(e){ console.error('Failed to set offline', e); }
  }
  // hide UI — back to home screen
  showScreen('home');
  const mapc = document.getElementById('map'); if (mapc) mapc.style.display = 'none';
  if (startShiftBtn) startShiftBtn.style.display = '';
  if (stopShiftBtn) stopShiftBtn.style.display = 'none';
  if (statusEl) statusEl.classList.remove('online');
  setStatus('Offline');
}

if (stopShiftBtn) stopShiftBtn.addEventListener('click', stopShift);

// show identity modal on first load if not signed in
window.addEventListener('load', ()=>{
  updateGreeting();
  showScreen('home');
  const saved = localStorage.getItem('driverId');
  if (!saved) {
    if (identityModal) identityModal.style.display = 'flex';
  }
});

// allow external reorder trigger to re-render (simple: re-read db snapshot)
listEl.addEventListener('reorderRequests', async () => {
  try{
    const snap = await get(reqRef);
    renderSnapshot(snap);
  }catch(e){ console.error('Failed to refresh requests', e); }
});

// ===== Road Snap toggle =====
const roadSnapBtn = document.getElementById('roadSnapBtn');
if (roadSnapBtn) {
  // Restore saved state
  roadSnapBtn.classList.toggle('active', mapMatchingEnabled);
  roadSnapBtn.addEventListener('click', () => {
    mapMatchingEnabled = !mapMatchingEnabled;
    roadSnapBtn.classList.toggle('active', mapMatchingEnabled);
    try { sessionStorage.setItem('roadSnap', mapMatchingEnabled ? '1' : '0'); } catch(e){}
    setStatus(mapMatchingEnabled ? 'Road snap ON' : 'Road snap OFF');
  });
}

// ===== Ride action button handlers =====
const pickedUpBtn = document.getElementById('pickedUpBtn');
const nextStopBtn = document.getElementById('nextStopBtn');
const tripDoneBtn = document.getElementById('tripDoneBtn');

// "Picked Up" — driver confirms passenger is in the car
if (pickedUpBtn) pickedUpBtn.addEventListener('click', async () => {
  if (!activeRideKey) return;
  try {
    await update(ref(db, 'ride_requests/' + activeRideKey), { status: 'picked_up' });
    if (activeRideData) activeRideData.status = 'picked_up';
    saveActiveRide();
    // Update driver rideStatus
    try{ await update(ref(db, 'drivers/'+selectedDriverId), { rideStatus: 'on_route' }); }catch(e){}
    showRideActionButtons('picked_up');
    // Start navigation to first stop/destination
    const navBanner = document.getElementById('navBanner');
    if (navBanner) navBanner.style.display = 'flex';
    // Force immediate nav update
    lastNavFetchTime = 0;
    lastNavLatLng = null;
    updateNavigation();
    setStatus('Ride started — navigating');
  } catch(e) { console.error('Failed to update status', e); alert('Failed to mark as picked up'); }
});

// "Next Stop" — advance to next waypoint
if (nextStopBtn) nextStopBtn.addEventListener('click', async () => {
  if (!activeRideKey || !activeRideData) return;
  const stops = activeRideData.stops && Array.isArray(activeRideData.stops) ? activeRideData.stops : [];
  if (currentStopIndex < stops.length - 1) {
    currentStopIndex++;
    // Update Firebase so passenger can track progress
    try { await update(ref(db, 'ride_requests/' + activeRideKey), { currentStop: currentStopIndex }); } catch(e){}
    // Force re-route
    lastNavFetchTime = 0;
    lastNavLatLng = null;
    await updateNavigation();
    // Update button visibility
    showRideActionButtons('picked_up');
    saveActiveRide();
    setStatus(`Navigating to stop ${currentStopIndex + 1}`);
  }
});

// "Trip Done" — with confirmation
if (tripDoneBtn) tripDoneBtn.addEventListener('click', async () => {
  if (!activeRideKey) return;
  if (!confirm('Are you sure the trip is done?')) return;
  try {
    await completeRequest(activeRideKey);
    setStatus('Trip completed');
  } catch(e) { console.error('Failed to complete trip', e); alert('Failed to complete trip'); }
});

// ===== Mid-trip Add Stop =====
const addStopMidBtn = document.getElementById('addStopMidBtn');
if (addStopMidBtn) addStopMidBtn.addEventListener('click', () => {
  if (!activeRideKey || !activeRideData || !popupMap) return;
  addingStopMode = true;
  setStatus('Tap the map to add a new stop (pan freely)');
  const onMapClick = async (e) => {
    popupMap.off('click', onMapClick);
    addingStopMode = false;
    const newStop = { lat: e.latlng.lat, lng: e.latlng.lng };
    // Insert as the next stop after currentStopIndex
    if (!activeRideData.stops) activeRideData.stops = [];
    const insertIdx = currentStopIndex + 1;
    activeRideData.stops.splice(insertIdx, 0, newStop);
    // Update Firebase with new stops array
    try {
      await update(ref(db, 'ride_requests/' + activeRideKey), { stops: activeRideData.stops });
      // Add a marker for the new stop
      const icon = L.divIcon({
        className: 'stop-number-icon',
        html: `<div style="background:#ff9500;color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)">+</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      const m = L.marker([newStop.lat, newStop.lng], { icon }).addTo(popupMap).bindPopup('Added stop');
      popupStopMarkers.push(m);
      // Re-route navigation
      lastNavFetchTime = 0;
      lastNavLatLng = null;
      await updateNavigation();
      showRideActionButtons('picked_up');
      saveActiveRide();
      setStatus('Stop added');
    } catch(err) {
      console.error('Failed to add stop', err);
      activeRideData.stops.splice(insertIdx, 1); // revert
      addingStopMode = false;
      setStatus('Failed to add stop');
    }
  };
  popupMap.once('click', onMapClick);
});

// ===== Panic Button (3-second long press) =====
const panicBtnEl = document.getElementById('panicBtn');
if (panicBtnEl) {
  let panicTimer = null;
  const startPanic = () => {
    panicBtnEl.classList.add('pressing');
    panicTimer = setTimeout(async () => {
      panicBtnEl.classList.remove('pressing');
      panicBtnEl.classList.add('sent');
      // Send panic alert to Firebase
      try {
        const alertData = {
          driverId: selectedDriverId,
          driverName: selectedDriverName || 'Unknown',
          lat: driverLatLng ? driverLatLng.lat : null,
          lng: driverLatLng ? driverLatLng.lng : null,
          rideKey: activeRideKey || null,
          timestamp: Date.now()
        };
        await push(ref(db, 'panic_alerts'), alertData);
        setStatus('PANIC ALERT SENT');
      } catch(e) {
        console.error('Panic alert failed', e);
        setStatus('Panic alert failed');
        panicBtnEl.classList.remove('sent');
      }
    }, 3000);
  };
  const cancelPanic = () => {
    if (panicTimer) { clearTimeout(panicTimer); panicTimer = null; }
    panicBtnEl.classList.remove('pressing');
  };
  panicBtnEl.addEventListener('mousedown', startPanic);
  panicBtnEl.addEventListener('touchstart', (e) => { e.preventDefault(); startPanic(); });
  panicBtnEl.addEventListener('mouseup', cancelPanic);
  panicBtnEl.addEventListener('mouseleave', cancelPanic);
  panicBtnEl.addEventListener('touchend', cancelPanic);
  panicBtnEl.addEventListener('touchcancel', cancelPanic);
}

// ===== PWA Install Prompt =====
let deferredInstallPrompt = null;
const installBtn = document.getElementById('installBtn');

// Hide install button if already running as installed PWA
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

if (!isStandalone && installBtn) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.style.display = 'flex';
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    if (result.outcome === 'accepted') {
      installBtn.style.display = 'none';
    }
    deferredInstallPrompt = null;
  });
}

window.addEventListener('appinstalled', () => {
  if (installBtn) installBtn.style.display = 'none';
  deferredInstallPrompt = null;
});

// ===== Service Worker Registration =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err => console.error('SW registration failed', err));
}
