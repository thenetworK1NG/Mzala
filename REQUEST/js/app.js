import {createMap, locateOnce, clearRoute} from './map.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import { getDatabase, ref, push, set, onValue, get, query, orderByChild, equalTo } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js';

const statusEl = document.getElementById('status');
const locateBtn = document.getElementById('locateBtn');
let map = null;
let lastKnownLatLng = null;
let mapClickRegistered = false;
let myRequestId = null;
let myRequestUnsub = null;
let myDriverUnsub = null;

// Multi-stop booking state
let stops = [];              // array of { lat, lng }
let currentRouteGeometry = null;
let totalDistanceM = 0;
let totalDurationS = 0;
let selectedPassengers = 1;
let addingStop = false;      // true when user is picking a new stop on map

// Current rider account (persisted in localStorage + Firebase)
let riderAccount = null;

// Geofence (loaded from Firebase settings/geofence)
let geofence = null;

// Pricing (loaded from Firebase settings/pricing)
let pricing = null; // { normalDay, normalNight, hikeDay, hikeNight, nightStartHour }

// Hike zones (loaded from Firebase settings/hikeZones)
let hikeZones = null; // { key: { lat, lng, radiusKm }, ... }

// Firebase config
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

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

// Listen for geofence config changes
onValue(ref(database, 'settings/geofence'), (snap) => {
  geofence = snap.val() || null;
});

// Listen for pricing config
onValue(ref(database, 'settings/pricing'), (snap) => {
  pricing = snap.val() || null;
});

// Listen for hike zones
onValue(ref(database, 'settings/hikeZones'), (snap) => {
  hikeZones = snap.val() || null;
});

function haversineKm(a, b){
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function isInsideGeofence(latLng){
  if (!geofence || !geofence.enabled) return true;
  if (typeof geofence.lat !== 'number' || typeof geofence.lng !== 'number') return true;
  const dist = haversineKm(latLng, { lat: geofence.lat, lng: geofence.lng });
  return dist <= geofence.radiusKm;
}

function isTripWithinLimit(origin, destination){
  if (!geofence || !geofence.enabled) return true;
  if (typeof geofence.maxTripKm !== 'number') return true;
  const dist = haversineKm(origin, destination);
  return dist <= geofence.maxTripKm;
}

// Check if a point is inside any hike zone
function isInHikeZone(latLng){
  if (!hikeZones) return false;
  const zones = Object.values(hikeZones);
  for (const z of zones) {
    if (typeof z.lat !== 'number' || typeof z.lng !== 'number') continue;
    const dist = haversineKm(latLng, { lat: z.lat, lng: z.lng });
    if (dist <= (z.radiusKm || 5)) return true;
  }
  return false;
}

// Determine if it's nighttime
function isNightTime(){
  const hour = new Date().getHours();
  const nightStart = (pricing && typeof pricing.nightStartHour === 'number') ? pricing.nightStartHour : 22;
  return hour >= nightStart || hour < 6;
}

// Calculate price per person and total
function calculatePrice(passengers){
  const defaults = { normalDay: 20, normalNight: 30, hikeDay: 35, hikeNight: 50 };
  const p = pricing || defaults;
  // Hike zone applies if pickup OR any stop/destination is inside a hike zone
  let inHike = lastKnownLatLng ? isInHikeZone(lastKnownLatLng) : false;
  if (!inHike && stops.length) {
    for (const s of stops) {
      if (isInHikeZone(s)) { inHike = true; break; }
    }
  }
  const night = isNightTime();
  let pp;
  if (inHike) {
    pp = night ? (p.hikeNight || defaults.hikeNight) : (p.hikeDay || defaults.hikeDay);
  } else {
    pp = night ? (p.normalNight || defaults.normalNight) : (p.normalDay || defaults.normalDay);
  }
  return { pricePerPerson: pp, total: pp * passengers, isHikeZone: inHike, isNight: night };
}

// ===== Account management =====
function sanitize(str){ return String(str).trim().replace(/[<>"'&]/g, ''); }

async function isPhoneTaken(phone, excludeId){
  const snap = await get(query(ref(database, 'riders'), orderByChild('phone'), equalTo(phone)));
  if (!snap.exists()) return false;
  let taken = false;
  snap.forEach(child => { if (child.key !== excludeId) taken = true; });
  return taken;
}

async function createAccount(username, phone){
  username = sanitize(username);
  phone = sanitize(phone);
  if (!username || username.length < 2) throw new Error('Username must be at least 2 characters');
  if (!phone || phone.length < 7) throw new Error('Enter a valid phone number');
  if (await isPhoneTaken(phone, null)) throw new Error('This phone number is already registered');
  const ridersRef = ref(database, 'riders');
  const newRef = push(ridersRef);
  await set(newRef, { username, phone, createdAt: Date.now() });
  const account = { id: newRef.key, username, phone };
  try{ localStorage.setItem('riderAccount', JSON.stringify(account)); }catch(e){}
  return account;
}

function loadSavedAccount(){
  try{
    const raw = localStorage.getItem('riderAccount');
    if (raw) return JSON.parse(raw);
  }catch(e){}
  return null;
}

function showAccountBadge(account){
  const badge = document.getElementById('accountBadge');
  const badgeName = document.getElementById('badgeName');
  if (badge && account) {
    badgeName.textContent = account.username;
    badge.classList.remove('hidden');
    badge.onclick = () => showAccountModal(true);
  }
}

function showAccountModal(loggedIn){
  const modal = document.getElementById('accountModal');
  const form = document.getElementById('accountForm');
  const loggedInEl = document.getElementById('accLoggedIn');
  const title = document.getElementById('accountTitle');
  const displayName = document.getElementById('accDisplayName');
  if (!modal) return;
  modal.classList.remove('hidden');
  if (loggedIn && riderAccount) {
    form.classList.add('hidden');
    loggedInEl.classList.remove('hidden');
    title.textContent = 'Your account';
    displayName.textContent = `${riderAccount.username} (${riderAccount.phone})`;
  } else {
    form.classList.remove('hidden');
    loggedInEl.classList.add('hidden');
    title.textContent = 'Create your account';
  }
}

function hideAccountModal(){
  const modal = document.getElementById('accountModal');
  if (modal) modal.classList.add('hidden');
}

function initAccountUI(){
  const form = document.getElementById('accountForm');
  const errorEl = document.getElementById('accError');
  const submitBtn = document.getElementById('accSubmitBtn');
  const logoutBtn = document.getElementById('accLogout');

  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('accUsername').value.trim();
    const phone = document.getElementById('accPhone').value.trim();
    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
    try{
      riderAccount = await createAccount(username, phone);
      hideAccountModal();
      showAccountBadge(riderAccount);
      showToast('Account created');
    }catch(err){
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }finally{
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });

  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    riderAccount = null;
    try{ localStorage.removeItem('riderAccount'); }catch(e){}
    const badge = document.getElementById('accountBadge');
    if (badge) badge.classList.add('hidden');
    hideAccountModal();
    showToast('Signed out');
  });
}

function showToast(msg, timeout = 2500){
  let t = document.getElementById('__toast');
  if (!t){
    t = document.createElement('div');
    t.id = '__toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(()=>{ t.classList.remove('show'); }, timeout);
}

// ===== Booking step management =====
function showBookingStep(step){
  const s1 = document.getElementById('bookingStep1');
  const s2 = document.getElementById('bookingStep2');
  const s3 = document.getElementById('bookingStep3');
  if (s1) s1.classList.toggle('hidden', step !== 1);
  if (s2) s2.classList.toggle('hidden', step !== 2);
  if (s3) s3.classList.toggle('hidden', step !== 3);
}

function updateStopsInfo(){
  const stopsInfo = document.getElementById('stopsInfo');
  const stopsCount = document.getElementById('stopsCount');
  if (stops.length > 1 && stopsInfo && stopsCount) {
    stopsCount.textContent = `${stops.length} stops`;
    stopsInfo.classList.remove('hidden');
  } else if (stopsInfo) {
    stopsInfo.classList.add('hidden');
  }
}

function updatePriceDisplay(){
  const priceInfo = calculatePrice(selectedPassengers);
  const paxLabel = document.getElementById('pricePaxLabel');
  const zoneBadge = document.getElementById('priceZoneBadge');
  const totalDisplay = document.getElementById('priceTotalDisplay');
  if (paxLabel) paxLabel.textContent = `${selectedPassengers} × R${priceInfo.pricePerPerson}`;
  if (zoneBadge) zoneBadge.style.display = priceInfo.isHikeZone ? '' : 'none';
  if (totalDisplay) totalDisplay.textContent = `R${priceInfo.total}`;
}

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
  const bookBtn = document.getElementById('bookBtn');

  initAccountUI();
  const saved = loadSavedAccount();
  if (saved) {
    riderAccount = saved;
    showAccountBadge(riderAccount);
  }

  if (bookBtn) {
    bookBtn.addEventListener('click', async () => {
      if (!riderAccount) {
        showAccountModal(false);
        return;
      }
      // Show loader overlay (map stays hidden)
      const loader = document.getElementById('locLoader');
      const landing = document.getElementById('landing');
      if (landing) landing.classList.add('hidden');
      if (loader) loader.classList.remove('hidden');

      // Create map in background while locating
      if (!map) {
        map = createMap('map');
        ensureMapClick();
      }
      try {
        const res = await locateOnce(map);
        if (res && res.marker) lastKnownLatLng = res.marker.getLatLng();
        // Animate loader out, then show map
        if (loader) {
          loader.classList.add('loc-done');
          setTimeout(() => {
            loader.classList.add('hidden');
            loader.classList.remove('loc-done');
            showMapUI();
            if (map) map.invalidateSize();
          }, 600);
        } else {
          showMapUI();
          if (map) map.invalidateSize();
        }
      } catch (err) {
        if (loader) loader.classList.add('hidden');
        showMapUI();
        if (map) map.invalidateSize();
        setStatus('Location error: ' + (err && (err.message || err.code) ? (err.message || err.code) : 'unknown'));
      }
    });
  }

  if (locateBtn) {
    locateBtn.addEventListener('click', async () => {
      if (!map) {
        showMapUI();
        map = createMap('map');
        ensureMapClick();
        setTimeout(() => { if (map && typeof map.invalidateSize === 'function') map.invalidateSize(); }, 300);
      }
      setStatus('Locating…');
      try {
        const res = await locateOnce(map);
        if (res && res.marker) lastKnownLatLng = res.marker.getLatLng();
        setStatus('');
      } catch (err) {
        setStatus('Location error: ' + (err && (err.message || err.code) ? (err.message || err.code) : 'unknown'));
      }
    });
  }

  // Wire up booking step buttons
  initBookingUI();
});

function initBookingUI(){
  const addStopBtn = document.getElementById('addStopBtn');
  const continueBtn = document.getElementById('continueBtn');
  const clearBtn = document.getElementById('clearRouteBtn');
  const step2BackBtn = document.getElementById('step2BackBtn');
  const step2ContinueBtn = document.getElementById('step2ContinueBtn');
  const step3BackBtn = document.getElementById('step3BackBtn');
  const bookRideBtn = document.getElementById('bookRideBtn');

  // Passenger pills
  document.querySelectorAll('.passenger-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.passenger-pill').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
      selectedPassengers = parseInt(pill.getAttribute('data-count'), 10) || 1;
    });
  });

  // Step 1: Add another stop
  if (addStopBtn) addStopBtn.addEventListener('click', () => {
    addingStop = true;
    hideRidePanel();
    setStatus('Tap the map to add another stop.');
    const hint = document.getElementById('mapHint');
    if (hint) { hint.textContent = 'Tap the map to add another stop'; hint.classList.remove('hidden'); }
  });

  // Step 1: Continue → Step 2
  if (continueBtn) continueBtn.addEventListener('click', () => {
    showBookingStep(2);
  });

  // Step 1: Clear
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (map) clearRoute(map);
    stops = [];
    currentRouteGeometry = null;
    totalDistanceM = 0;
    totalDurationS = 0;
    addingStop = false;
    hideRidePanel();
    setStatus('Route cleared. Tap the map to choose a destination.');
  });

  // Step 2: Back → Step 1
  if (step2BackBtn) step2BackBtn.addEventListener('click', () => {
    showBookingStep(1);
  });

  // Step 2: Continue → Step 3
  if (step2ContinueBtn) step2ContinueBtn.addEventListener('click', () => {
    updatePriceDisplay();
    showBookingStep(3);
  });

  // Step 3: Back → Step 2
  if (step3BackBtn) step3BackBtn.addEventListener('click', () => {
    showBookingStep(2);
  });

  // Step 3: Book ride
  if (bookRideBtn) bookRideBtn.addEventListener('click', async () => {
    if (!riderAccount) { showAccountModal(false); return; }
    if (!lastKnownLatLng || !stops.length) { setStatus('Missing origin or destination.'); return; }

    // Geofence check
    if (!isInsideGeofence(lastKnownLatLng)) {
      showToast('Mzala isn\u2019t available in your area yet');
      setStatus('You\u2019re outside the service zone.');
      return;
    }

    // Max trip distance check (check against furthest stop)
    for (const s of stops) {
      if (!isTripWithinLimit(lastKnownLatLng, s)) {
        const maxKm = geofence && geofence.maxTripKm ? geofence.maxTripKm : '?';
        showToast('A destination is too far');
        setStatus(`Max trip distance is ${maxKm} km.`);
        return;
      }
    }

    const priceInfo = calculatePrice(selectedPassengers);
    setStatus('Sending ride request…');
    bookRideBtn.disabled = true;

    try {
      const reqRef = ref(database, 'ride_requests');
      const newReq = push(reqRef);
      await set(newReq, {
        origin: { lat: lastKnownLatLng.lat, lng: lastKnownLatLng.lng },
        destination: { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng },
        stops: stops.map(s => ({ lat: s.lat, lng: s.lng })),
        geometry: currentRouteGeometry || null,
        passengers: selectedPassengers,
        pricePerPerson: priceInfo.pricePerPerson,
        totalPrice: priceInfo.total,
        isHikeZone: priceInfo.isHikeZone,
        timestamp: Date.now(),
        source: 'user_map_request',
        rider: {
          id: riderAccount.id,
          username: riderAccount.username,
          phone: riderAccount.phone
        }
      });
      myRequestId = newReq.key;
      try{ localStorage.setItem('myRequestId', myRequestId); }catch(e){}
      attachRequestListener(myRequestId);
      showToast('Ride booked!');
      setStatus('Ride requested.');
      bookRideBtn.disabled = true;
      bookRideBtn.querySelector('span').textContent = 'Booked ✓';
    } catch (e) {
      console.error('Failed to send ride request', e);
      setStatus('Failed to send request.');
      bookRideBtn.disabled = false;
    }
  });
}

function ensureMapClick() {
  if (!map || mapClickRegistered) return;
  map.on('click', async (e) => {
    const to = e.latlng;
    if (!lastKnownLatLng) {
      setStatus('No known starting location — please tap "Center on me" first.');
      return;
    }

    // If the ride panel is showing step 2 or 3, ignore map clicks
    const s2 = document.getElementById('bookingStep2');
    const s3 = document.getElementById('bookingStep3');
    if ((s2 && !s2.classList.contains('hidden')) || (s3 && !s3.classList.contains('hidden'))) return;

    setStatus('Routing…');
    const hint = document.getElementById('mapHint');
    if (hint) hint.classList.add('hidden');

    try {
      const { routeBetween, routeMultiStop } = await import('./map.js');

      // Add destination to stops list
      stops.push({ lat: to.lat, lng: to.lng });
      addingStop = false;

      let result;
      if (stops.length === 1) {
        result = await routeBetween(map, lastKnownLatLng, to);
      } else {
        result = await routeMultiStop(map, lastKnownLatLng, stops);
      }

      currentRouteGeometry = result.geometry || null;
      totalDistanceM = result.distance;
      totalDurationS = result.duration;

      const km = (result.distance / 1000).toFixed(2);
      const mins = Math.round(result.duration / 60);
      showRidePanel(km, mins);
      setStatus(`Route: ${km} km · ~${mins} min`);
    } catch (err) {
      // Revert the stop we just added on failure
      stops.pop();
      setStatus('Routing failed: ' + (err && err.message ? err.message : 'unknown'));
    }
  });
  mapClickRegistered = true;
}

function showRidePanel(km, mins) {
  const panel = document.getElementById('ridePanel');
  const distEl = document.getElementById('rideDistance');
  const durEl = document.getElementById('rideDuration');
  if (distEl) distEl.textContent = km;
  if (durEl) durEl.textContent = mins;
  if (panel) panel.classList.remove('hidden');
  updateStopsInfo();
  showBookingStep(1);

  // Reset book button state
  const bookRideBtn = document.getElementById('bookRideBtn');
  if (bookRideBtn) {
    bookRideBtn.disabled = false;
    bookRideBtn.querySelector('span').textContent = 'Book Ride';
  }
}

function distanceMeters(a, b){
  if(!a || !b) return Infinity;
  const toRad = d => d * Math.PI / 180;
  const R = 6371e3;
  const phi1 = toRad(a.lat), phi2 = toRad(b.lat);
  const dphi = toRad(b.lat - a.lat), dlambda = toRad(b.lng - a.lng);
  const x = Math.sin(dphi/2) * Math.sin(dphi/2) + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlambda/2)*Math.sin(dlambda/2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  return R * c;
}

function estimateMinutesFromMeters(m){
  if (!isFinite(m)) return null;
  const metersPerMin = 700; // ~42 km/h average
  return Math.max(1, Math.round(m / metersPerMin));
}

function ensureRideStatusEl(){
  let el = document.getElementById('rideStatus');
  const panel = document.getElementById('ridePanel');
  if (!panel) return null;
  if (!el){
    el = document.createElement('div'); el.id = 'rideStatus'; el.style.marginTop = '12px'; el.style.fontSize = '0.85rem'; el.style.fontWeight = '600'; el.style.color = '#06c167'; el.style.textAlign = 'center';
    panel.appendChild(el);
  }
  return el;
}

function attachRequestListener(requestId){
  if (!requestId) return;
  const rRef = ref(database, 'ride_requests/' + requestId);
  // detach previous
  try{ if (myRequestUnsub) myRequestUnsub(); }catch(e){}
  myRequestUnsub = onValue(rRef, async (snap) => {
    const data = snap.val();
    const statusEl = ensureRideStatusEl();
    if (!data) {
      // request removed (likely completed by driver) — clear UI immediately
      try{ localStorage.removeItem('myRequestId'); }catch(e){}
      try{ if (myDriverUnsub) myDriverUnsub(); }catch(e){}
      // remove status element if present
      const rs = document.getElementById('rideStatus'); if (rs) rs.remove();
      hideRidePanel();
      showToast('Ride completed');
      return;
    }
    if (data.status === 'completed'){
      try{ localStorage.removeItem('myRequestId'); }catch(e){}
      try{ if (myDriverUnsub) myDriverUnsub(); }catch(e){}
      const rs = document.getElementById('rideStatus'); if (rs) rs.remove();
      hideRidePanel();
      showToast('Ride completed');
      return;
    }
    if (data.acceptedBy) {
      // show driver ETA — fetch driver location and subscribe to updates
      const driverId = data.acceptedBy;
      if (statusEl) statusEl.textContent = 'Driver assigned — calculating ETA…';
      // detach previous driver listener
      try{ if (myDriverUnsub) myDriverUnsub(); }catch(e){}
      const dRef = ref(database, 'drivers/' + driverId);
      myDriverUnsub = onValue(dRef, (dSnap) => {
        const dv = dSnap.val() || {};
        const driverPos = (typeof dv.lat === 'number' && typeof dv.lng === 'number') ? { lat: dv.lat, lng: dv.lng } : null;
        // prefer pickup origin if available
        const origin = data.origin ? { lat: data.origin.lat, lng: data.origin.lng } : (data.lat ? { lat: data.lat, lng: data.lng } : null);
        if (driverPos && origin) {
          const meters = distanceMeters(driverPos, origin);
          const mins = estimateMinutesFromMeters(meters);
          if (statusEl) statusEl.textContent = `Driver is on the way — ETA ~${mins} min`;
        } else if (statusEl) {
          statusEl.textContent = 'Driver is on the way';
        }
      });
    } else {
      if (statusEl) statusEl.textContent = 'Waiting for a driver to accept your request';
    }
  });
}

// attach listener on load if we have an outstanding request
try{ const saved = localStorage.getItem('myRequestId'); if (saved) { myRequestId = saved; attachRequestListener(saved); } }catch(e){}

function hideRidePanel() {
  const panel = document.getElementById('ridePanel');
  if (panel) panel.classList.add('hidden');
}

function showMapUI() {
  const landing = document.getElementById('landing');
  const topbar = document.getElementById('topbar');
  const mapEl = document.getElementById('map');
  const status = document.getElementById('status');
  const hint = document.getElementById('mapHint');
  if (landing) landing.classList.add('hidden');
  if (topbar) topbar.classList.remove('hidden');
  if (hint) hint.classList.remove('hidden');
  if (mapEl) mapEl.classList.remove('hidden');
  if (status) status.classList.remove('hidden');
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}
