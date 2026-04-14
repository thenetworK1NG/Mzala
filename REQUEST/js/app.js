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

// Track whether location came from real GPS (not IP fallback)
let locationIsGPS = false;

// Current rider account (persisted in localStorage + Firebase)
let riderAccount = null;

// Geofence (loaded from Firebase settings/geofence)
let geofence = null;

// Pricing (loaded from Firebase settings/pricing)
let pricing = null; // { normalDay, normalNight, hikeDay, hikeNight, nightStartHour, nightEndHour }

// Hike zones (loaded from Firebase settings/hikeZones)
let hikeZones = null; // { key: { lat, lng, radiusKm }, ... }

// Accepted sound
const acceptedSound = new Audio('sounds/accepted.mp3');
let acceptedSoundPlayed = false;

// Booked sound
const bookedSound = new Audio('sounds/booked.mp3');

// Last known ride data for receipt (captured before Firebase deletes it)
let lastRideData = null;

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

// Check if a single point is inside any hike zone (tight 1km default radius)
function isInHikeZone(latLng){
  if (!hikeZones) return false;
  const zones = Object.values(hikeZones);
  for (const z of zones) {
    if (typeof z.lat !== 'number' || typeof z.lng !== 'number') continue;
    const dist = haversineKm(latLng, { lat: z.lat, lng: z.lng });
    if (dist <= (z.radiusKm || 1)) return true;
  }
  return false;
}

// Check if the route polyline passes through any hike zone
// Samples every ~10th point for performance, plus checks all stops
function doesRouteCrossHikeZone(geometry, stopsArr){
  if (!hikeZones) return false;
  // Check all stop points first
  if (stopsArr && stopsArr.length) {
    for (const s of stopsArr) {
      if (isInHikeZone(s)) return true;
    }
  }
  // Check pickup point
  if (lastKnownLatLng && isInHikeZone(lastKnownLatLng)) return true;
  // Sample along the route polyline
  if (geometry && geometry.length) {
    const step = Math.max(1, Math.floor(geometry.length / 50)); // ~50 samples max
    for (let i = 0; i < geometry.length; i += step) {
      const pt = geometry[i];
      const latLng = Array.isArray(pt) ? { lat: pt[0], lng: pt[1] } : pt;
      if (isInHikeZone(latLng)) return true;
    }
    // Always check the last point
    const last = geometry[geometry.length - 1];
    const lastPt = Array.isArray(last) ? { lat: last[0], lng: last[1] } : last;
    if (isInHikeZone(lastPt)) return true;
  }
  return false;
}

// Determine if it's nighttime (default 22:00–08:00)
function isNightTime(){
  const hour = new Date().getHours();
  const nightStart = (pricing && typeof pricing.nightStartHour === 'number') ? pricing.nightStartHour : 22;
  const nightEnd = (pricing && typeof pricing.nightEndHour === 'number') ? pricing.nightEndHour : 8;
  return hour >= nightStart || hour < nightEnd;
}

// Calculate price: rate × passengers × points booked
function calculatePrice(passengers){
  const defaults = { normalDay: 20, normalNight: 30, hikeDay: 35, hikeNight: 50 };
  const p = pricing || defaults;
  // Hike zone applies if the route polyline crosses any hike zone
  const inHike = doesRouteCrossHikeZone(currentRouteGeometry, stops);
  const night = isNightTime();
  let pp;
  if (inHike) {
    pp = night ? (p.hikeNight || defaults.hikeNight) : (p.hikeDay || defaults.hikeDay);
  } else {
    pp = night ? (p.normalNight || defaults.normalNight) : (p.normalDay || defaults.normalDay);
  }
  const stopCount = stops.length;
  const total = pp * passengers * stopCount;
  return { pricePerPerson: pp, total, isHikeZone: inHike, isNight: night, stopCount };
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
      // Show tutorial for first-time users
      if (!localStorage.getItem('tutorialSeen')) {
        showTutorial();
      }
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
  const removeLink = document.getElementById('removeLastStopBtn');
  if (stops.length > 1 && stopsInfo && stopsCount) {
    stopsCount.textContent = `${stops.length} stops`;
    stopsInfo.classList.remove('hidden');
    if (removeLink) removeLink.classList.remove('hidden');
  } else if (stopsInfo) {
    stopsInfo.classList.add('hidden');
    if (removeLink) removeLink.classList.add('hidden');
  }
}

function updatePriceDisplay(){
  const priceInfo = calculatePrice(selectedPassengers);
  const paxLabel = document.getElementById('pricePaxLabel');
  const zoneBadge = document.getElementById('priceZoneBadge');
  const totalDisplay = document.getElementById('priceTotalDisplay');
  // Breakdown: "{stops} points × {pax} pax × R{rate}"
  let label = '';
  if (priceInfo.stopCount > 0) {
    label = `${priceInfo.stopCount} point${priceInfo.stopCount !== 1 ? 's' : ''} × ${selectedPassengers} pax × R${priceInfo.pricePerPerson}`;
  } else {
    label = `${selectedPassengers} pax × R${priceInfo.pricePerPerson}`;
  }
  if (paxLabel) paxLabel.textContent = label;
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
      // Check location permission
      const gpsOverlay = document.getElementById('gpsOverlay');
      try {
        if (navigator.permissions) {
          const perm = await navigator.permissions.query({ name: 'geolocation' });
          if (perm.state === 'denied') {
            if (loader) loader.classList.add('hidden');
            if (landing) landing.classList.remove('hidden');
            if (gpsOverlay) gpsOverlay.style.display = 'flex';
            return;
          }
        }
      } catch(e) { /* permissions API not supported, continue */ }
      try {
        const res = await locateOnce(map);
        // Block IP fallback — require real GPS
        if (res && res.fallback === 'ip') {
          if (loader) loader.classList.add('hidden');
          if (landing) landing.classList.remove('hidden');
          if (gpsOverlay) gpsOverlay.style.display = 'flex';
          locationIsGPS = false;
          return;
        }
        locationIsGPS = true;
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
        const landing = document.getElementById('landing');
        if (landing) landing.classList.remove('hidden');
        const gpsOverlay = document.getElementById('gpsOverlay');
        if (gpsOverlay) gpsOverlay.style.display = 'flex';
        locationIsGPS = false;
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
    setStatus('');
    const banner = document.getElementById('addStopBanner');
    const hint = document.getElementById('mapHint');
    if (hint) hint.classList.add('hidden');
    if (banner) banner.classList.remove('hidden');
  });

  // Cancel adding stop
  const cancelAddStopBtn = document.getElementById('cancelAddStopBtn');
  if (cancelAddStopBtn) cancelAddStopBtn.addEventListener('click', () => {
    addingStop = false;
    const banner = document.getElementById('addStopBanner');
    if (banner) banner.classList.add('hidden');
    // Re-show the ride panel if we have stops
    if (stops.length > 0) {
      const km = (totalDistanceM / 1000).toFixed(2);
      const mins = Math.round(totalDurationS / 60);
      showRidePanel(km, mins);
      setStatus(`Route: ${km} km`);
    } else {
      setStatus('Tap the map to set your destination.');
    }
  });

  // Step 1: Continue → Step 2
  if (continueBtn) continueBtn.addEventListener('click', () => {
    showBookingStep(2);
  });

  // Step 1: Remove last stop
  const removeLastStopBtn = document.getElementById('removeLastStopBtn');
  if (removeLastStopBtn) removeLastStopBtn.addEventListener('click', async () => {
    if (stops.length <= 1) {
      // Only one stop — same as clear all
      if (map) clearRoute(map);
      stops = [];
      currentRouteGeometry = null;
      totalDistanceM = 0;
      totalDurationS = 0;
      addingStop = false;
      hideRidePanel();
      setStatus('Route cleared. Tap the map to choose a destination.');
      return;
    }
    stops.pop();
    setStatus('Recalculating route…');
    try {
      const { routeBetween, routeMultiStop } = await import('./map.js');
      let result;
      if (stops.length === 1) {
        result = await routeBetween(map, lastKnownLatLng, stops[0]);
      } else {
        result = await routeMultiStop(map, lastKnownLatLng, stops);
      }
      currentRouteGeometry = result.geometry || null;
      totalDistanceM = result.distance;
      totalDurationS = result.duration;
      const km = (result.distance / 1000).toFixed(2);
      const mins = Math.round(result.duration / 60);
      showRidePanel(km, mins);
      setStatus(`Route: ${km} km`);
    } catch (err) {
      setStatus('Route update failed.');
    }
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

    // GPS check — block booking if location came from IP fallback
    if (!locationIsGPS) {
      const gpsOverlay = document.getElementById('gpsOverlay');
      if (gpsOverlay) gpsOverlay.style.display = 'flex';
      return;
    }

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
      bookedSound.play().catch(()=>{});
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
    const banner = document.getElementById('addStopBanner');
    if (banner) banner.classList.add('hidden');

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
      setStatus(`Route: ${km} km`);
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
  if (distEl) distEl.textContent = km;
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

// ===== Ride overlay state machine =====
function showRideOverlay(message, subMessage){
  const overlay = document.getElementById('rideOverlay');
  const msgEl = document.getElementById('rideOverlayMsg');
  const subEl = document.getElementById('rideOverlaySub');
  const receipt = document.getElementById('rideReceipt');
  const doneBtn = document.getElementById('rideDoneBtn');
  if (overlay) overlay.style.display = 'flex';
  if (msgEl) msgEl.textContent = message;
  if (subEl) subEl.textContent = subMessage || '';
  // Hide receipt and done button by default
  if (receipt) receipt.classList.add('hidden');
  if (doneBtn) doneBtn.classList.add('hidden');
}

function showThankYouScreen(rideData){
  const overlay = document.getElementById('rideOverlay');
  const msgEl = document.getElementById('rideOverlayMsg');
  const receipt = document.getElementById('rideReceipt');
  const doneBtn = document.getElementById('rideDoneBtn');
  if (overlay) overlay.style.display = 'flex';
  if (msgEl) msgEl.textContent = 'THANK YOU FOR USING US';
  // Populate receipt
  if (receipt && rideData) {
    const rateEl = document.getElementById('receiptRate');
    const paxEl = document.getElementById('receiptPax');
    const stopsEl = document.getElementById('receiptStops');
    const hikeRow = document.getElementById('receiptHikeRow');
    const totalEl = document.getElementById('receiptTotal');
    if (rateEl) rateEl.textContent = `R${rideData.pricePerPerson || 0}`;
    if (paxEl) paxEl.textContent = `${rideData.passengers || 1}`;
    if (stopsEl) stopsEl.textContent = `${(rideData.stops && rideData.stops.length) || 1}`;
    if (hikeRow) hikeRow.classList.toggle('hidden', !rideData.isHikeZone);
    if (totalEl) totalEl.textContent = `R${rideData.totalPrice || 0}`;
    receipt.classList.remove('hidden');
  }
  if (doneBtn) doneBtn.classList.remove('hidden');
}

function hideRideOverlay(){
  const overlay = document.getElementById('rideOverlay');
  if (overlay) overlay.style.display = 'none';
}

function resetBookingState(){
  if (map) clearRoute(map);
  stops = [];
  currentRouteGeometry = null;
  totalDistanceM = 0;
  totalDurationS = 0;
  selectedPassengers = 1;
  addingStop = false;
  acceptedSoundPlayed = false;
  lastRideData = null;
  myRequestId = null;
  try{ localStorage.removeItem('myRequestId'); }catch(e){}
  hideRidePanel();
  hideRideOverlay();
  // Reset book button
  const bookRideBtn = document.getElementById('bookRideBtn');
  if (bookRideBtn) {
    bookRideBtn.disabled = false;
    const sp = bookRideBtn.querySelector('span');
    if (sp) sp.textContent = 'Book Ride';
  }
  // Show map hint
  const hint = document.getElementById('mapHint');
  if (hint) { hint.textContent = 'Tap the map to set your destination'; hint.classList.remove('hidden'); }
  setStatus('');
}

function attachRequestListener(requestId){
  if (!requestId) return;
  const rRef = ref(database, 'ride_requests/' + requestId);
  // detach previous
  try{ if (myRequestUnsub) myRequestUnsub(); }catch(e){}
  try{ if (myDriverUnsub) myDriverUnsub(); myDriverUnsub = null; }catch(e){}

  // Show initial waiting overlay
  showRideOverlay('WAITING FOR A DRIVER', 'You can turn off your location now. Please keep this screen open to see when your driver accepts.');

  myRequestUnsub = onValue(rRef, (snap) => {
    const data = snap.val();
    if (!data) {
      // Request removed (driver completed the ride)
      try{ localStorage.removeItem('myRequestId'); }catch(e){}
      showThankYouScreen(lastRideData);
      hideRidePanel();
      return;
    }
    // Always capture latest ride data for receipt
    lastRideData = data;
    if (data.status === 'completed'){
      try{ localStorage.removeItem('myRequestId'); }catch(e){}
      showThankYouScreen(lastRideData);
      hideRidePanel();
      return;
    }
    if (data.status === 'picked_up'){
      const stopCount = (data.stops && data.stops.length) || 1;
      const total = data.totalPrice || 0;
      showRideOverlay('YOUR RIDE IS IN PROGRESS', `${stopCount} stop${stopCount !== 1 ? 's' : ''} · Total: R${total}`);
      hideRidePanel();
      return;
    }
    if (data.acceptedBy) {
      // Driver accepted — play accepted sound once
      if (!acceptedSoundPlayed) {
        acceptedSoundPlayed = true;
        acceptedSound.play().catch(()=>{});
      }
      showRideOverlay('DRIVER ON THE WAY TO YOU');
      hideRidePanel();
      return;
    }
    // No driver yet — waiting
    showRideOverlay('WAITING FOR A DRIVER', 'You can turn off your location now. Please keep this screen open to see when your driver accepts.');
  });
}

// Wire "Done" button on ride overlay
document.addEventListener('DOMContentLoaded', () => {
  const doneBtn = document.getElementById('rideDoneBtn');
  if (doneBtn) doneBtn.addEventListener('click', resetBookingState);
});

// attach listener on load if we have an outstanding request
try{
  const saved = localStorage.getItem('myRequestId');
  if (saved) {
    myRequestId = saved;
    hideRidePanel();
    attachRequestListener(saved);
  }
}catch(e){}

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

// ===== First-time Tutorial =====
function showTutorial(){
  const overlay = document.getElementById('tutorialOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  let current = 1;
  const totalSteps = 4;
  const updateStep = () => {
    overlay.querySelectorAll('.tutorial-step').forEach(s => {
      s.classList.toggle('hidden', parseInt(s.dataset.step) !== current);
    });
    overlay.querySelectorAll('.tutorial-dot').forEach(d => {
      d.classList.toggle('active', parseInt(d.dataset.dot) === current);
    });
    const nextBtn = document.getElementById('tutorialNextBtn');
    if (nextBtn) nextBtn.textContent = current === totalSteps ? 'Got it!' : 'Next';
  };
  const close = () => {
    overlay.classList.add('hidden');
    try{ localStorage.setItem('tutorialSeen', '1'); }catch(e){}
  };
  const nextBtn = document.getElementById('tutorialNextBtn');
  const skipBtn = document.getElementById('tutorialSkipBtn');
  if (nextBtn) nextBtn.onclick = () => { if (current < totalSteps) { current++; updateStep(); } else { close(); } };
  if (skipBtn) skipBtn.onclick = close;
  updateStep();
}

// ===== Route Bookmarks (localStorage) =====
function getSavedRoutes(){
  try{
    const raw = localStorage.getItem('savedRoutes');
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}
function persistRoutes(routes){
  try{ localStorage.setItem('savedRoutes', JSON.stringify(routes)); }catch(e){}
}
function renderSavedRoutes(){
  const list = document.getElementById('savedRoutesList');
  const empty = document.getElementById('savedRoutesEmpty');
  if (!list) return;
  const routes = getSavedRoutes();
  list.innerHTML = '';
  if (!routes.length){ if (empty) empty.classList.remove('hidden'); return; }
  if (empty) empty.classList.add('hidden');
  routes.forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'saved-route-card';
    card.innerHTML = `<div class="saved-route-info"><div class="saved-route-name">${r.name}</div><div class="saved-route-meta">${r.stops.length} stop${r.stops.length !== 1 ? 's' : ''}</div></div><button class="saved-route-delete" data-idx="${i}">✕</button>`;
    card.querySelector('.saved-route-info').addEventListener('click', () => loadSavedRoute(r));
    card.querySelector('.saved-route-delete').addEventListener('click', (ev) => { ev.stopPropagation(); deleteSavedRoute(i); });
    list.appendChild(card);
  });
}
function deleteSavedRoute(idx){
  const routes = getSavedRoutes();
  routes.splice(idx, 1);
  persistRoutes(routes);
  renderSavedRoutes();
  showToast('Route deleted');
}
async function loadSavedRoute(route){
  // Close modal
  const modal = document.getElementById('savedRoutesModal');
  if (modal) modal.classList.add('hidden');
  if (!lastKnownLatLng){ showToast('Get your location first'); return; }
  stops = route.stops.map(s => ({lat: s.lat, lng: s.lng}));
  setStatus('Loading saved route…');
  try{
    const { routeBetween, routeMultiStop } = await import('./map.js');
    let result;
    if (stops.length === 1){
      result = await routeBetween(map, lastKnownLatLng, stops[0]);
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
  }catch(err){
    setStatus('Failed to load route.');
  }
}

// Wire bookmark buttons
document.addEventListener('DOMContentLoaded', () => {
  const savedRoutesBtn = document.getElementById('savedRoutesBtn');
  const closeSavedRoutesBtn = document.getElementById('closeSavedRoutesBtn');
  const saveRouteBtn = document.getElementById('saveRouteBtn');
  const savedRoutesModal = document.getElementById('savedRoutesModal');

  if (savedRoutesBtn) savedRoutesBtn.addEventListener('click', () => {
    renderSavedRoutes();
    if (savedRoutesModal) savedRoutesModal.classList.remove('hidden');
  });
  if (closeSavedRoutesBtn) closeSavedRoutesBtn.addEventListener('click', () => {
    if (savedRoutesModal) savedRoutesModal.classList.add('hidden');
  });
  if (saveRouteBtn) saveRouteBtn.addEventListener('click', () => {
    if (!stops.length){ showToast('No route to save'); return; }
    const name = prompt('Name this route:');
    if (!name || !name.trim()) return;
    const routes = getSavedRoutes();
    routes.push({ name: name.trim(), stops: stops.map(s => ({lat:s.lat, lng:s.lng})) });
    persistRoutes(routes);
    showToast('Route saved');
  });
});

// ===== GPS Retry Button =====
const gpsRetryBtn = document.getElementById('gpsRetryBtn');
if (gpsRetryBtn) gpsRetryBtn.addEventListener('click', () => {
  const gpsOverlay = document.getElementById('gpsOverlay');
  if (gpsOverlay) gpsOverlay.style.display = 'none';
  // Re-trigger the bookBtn flow
  const bookBtn = document.getElementById('bookBtn');
  if (bookBtn) bookBtn.click();
});

// ===== PWA Install Prompt =====
let deferredInstallPrompt = null;
const installBtn = document.getElementById('installBtn');

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
