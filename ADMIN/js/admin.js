// Admin script — manages drivers + geofence via Firebase Realtime Database
document.addEventListener('DOMContentLoaded', ()=>{
  const driverName = document.getElementById('driverName');
  const addBtn = document.getElementById('addDriverBtn');
  const list = document.getElementById('driversList');

  // Firebase (compat) already loaded in page
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

  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();

  // ===== DRIVERS =====
  function renderDrivers(snapshot){
    const val = snapshot.val() || {};
    list.innerHTML = '';
    const keys = Object.keys(val).sort();
    if (!keys.length) { list.textContent = 'No drivers yet.'; return; }
    keys.forEach(k => {
      const d = val[k];
      const el = document.createElement('div');
      el.className = 'driver-card';
      let online;
      if (d.online && d.active) {
        online = '<strong style="color:#06c167">Online · Active</strong>';
      } else if (d.online && !d.active) {
        online = '<strong style="color:#f5a623">Online · Inactive</strong>';
      } else {
        online = '<span style="color:#636366">Offline</span>';
      }
      const loc = (d.lat && d.lng) ? `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}` : 'no location';
      const hasLoc = typeof d.lat === 'number' && typeof d.lng === 'number';
      el.innerHTML = `<div class="driver-info"><strong>${escapeHtml(d.name||'Unnamed')}</strong><div class="driver-meta">${online} · ${loc}</div></div>
        <div class="driver-actions">
          ${hasLoc ? `<button data-id="${escapeHtml(k)}" data-name="${escapeHtml(d.name||'Unnamed')}" data-lat="${d.lat}" data-lng="${d.lng}" class="locate">Locate</button>` : ''}
          <button data-id="${escapeHtml(k)}" class="remove">Remove</button>
        </div>`;
      list.appendChild(el);
    });
    list.querySelectorAll('.locate').forEach(btn => btn.addEventListener('click', (e)=>{
      const b = e.target;
      showDriverLocation(b.getAttribute('data-name'), parseFloat(b.getAttribute('data-lat')), parseFloat(b.getAttribute('data-lng')));
    }));
    list.querySelectorAll('.remove').forEach(btn => btn.addEventListener('click', async (e)=>{
      const id = e.target.getAttribute('data-id');
      if (!confirm('Remove driver?')) return;
      await db.ref('drivers/'+id).remove();
    }));
  }

  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }

  db.ref('drivers').on('value', renderDrivers);

  addBtn.addEventListener('click', async ()=>{
    const name = (driverName.value || '').trim();
    if (!name) return alert('Enter a driver name');
    const r = db.ref('drivers').push();
    await r.set({ name, online:false, created: Date.now() });
    driverName.value = '';
  });

  // ===== LOCATE DRIVER =====
  const locOverlay = document.getElementById('locateOverlay');
  const locCloseBtn = document.getElementById('locateClose');
  const locNameEl = document.getElementById('locateName');
  const locMapEl = document.getElementById('locateMap');
  const locInfoEl = document.getElementById('locateInfo');
  let locMap = null;
  let locMarker = null;

  function showDriverLocation(name, lat, lng){
    locNameEl.textContent = name;
    locInfoEl.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    locOverlay.classList.remove('hidden');

    if (!locMap) {
      locMap = L.map(locMapEl, { zoomControl: true }).setView([lat, lng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '' }).addTo(locMap);
      if (locMap.attributionControl) locMap.attributionControl.setPrefix('');
    } else {
      locMap.setView([lat, lng], 15);
    }
    setTimeout(()=>{ try{ locMap.invalidateSize(); }catch(e){} }, 150);

    if (locMarker) {
      locMarker.setLatLng([lat, lng]);
    } else {
      locMarker = L.marker([lat, lng]).addTo(locMap);
    }
    locMarker.bindPopup(`<strong>${escapeHtml(name)}</strong>`).openPopup();
  }

  function closeLocatePopup(){
    locOverlay.classList.add('hidden');
  }
  locCloseBtn.addEventListener('click', closeLocatePopup);
  locOverlay.addEventListener('click', (e)=>{ if (e.target === locOverlay) closeLocatePopup(); });

  // ===== GEOFENCE =====
  const fenceToggle = document.getElementById('fenceToggle');
  const fenceStatus = document.getElementById('fenceStatus');
  const fenceMapEl = document.getElementById('fenceMap');
  const radiusInput = document.getElementById('radiusInput');
  const radiusMinus = document.getElementById('radiusMinus');
  const radiusPlus = document.getElementById('radiusPlus');
  const fenceSaveBtn = document.getElementById('fenceSaveBtn');
  const fenceResetBtn = document.getElementById('fenceResetBtn');
  const fenceCoords = document.getElementById('fenceCoords');
  const fenceMsg = document.getElementById('fenceMsg');
  const maxTripInput = document.getElementById('maxTripInput');
  const maxTripMinus = document.getElementById('maxTripMinus');
  const maxTripPlus = document.getElementById('maxTripPlus');

  let fenceMap = null;
  let fenceCircle = null;
  let maxTripCircle = null;
  let fenceCenter = null;   // {lat, lng}
  let fenceRadiusKm = 10;
  let maxTripKm = 50;
  let fenceEnabled = false;

  // Init Leaflet map for geofence
  function initFenceMap(){
    if (fenceMap) return;
    fenceMap = L.map(fenceMapEl, { zoomControl: true }).setView([-26.2041, 28.0473], 10); // default: Johannesburg
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: 'networKING Technology' }).addTo(fenceMap);
    if (fenceMap.attributionControl) fenceMap.attributionControl.setPrefix('');
    setTimeout(()=>{ try{ fenceMap.invalidateSize(); }catch(e){} }, 200);

    // Click to set center
    fenceMap.on('click', (e)=>{
      fenceCenter = { lat: e.latlng.lat, lng: e.latlng.lng };
      drawFenceCircle();
      updateCoordsLabel();
    });
  }

  function drawFenceCircle(){
    if (!fenceMap || !fenceCenter) return;
    const radiusM = fenceRadiusKm * 1000;
    if (fenceCircle) {
      fenceCircle.setLatLng([fenceCenter.lat, fenceCenter.lng]);
      fenceCircle.setRadius(radiusM);
    } else {
      fenceCircle = L.circle([fenceCenter.lat, fenceCenter.lng], {
        radius: radiusM,
        color: '#06c167',
        fillColor: '#06c167',
        fillOpacity: 0.12,
        weight: 2
      }).addTo(fenceMap);
    }
    // Max trip distance circle
    drawMaxTripCircle();
    // fit map to the largest circle
    const outerCircle = maxTripKm > fenceRadiusKm ? maxTripCircle : fenceCircle;
    try { fenceMap.fitBounds((outerCircle || fenceCircle).getBounds(), { padding: [30, 30] }); } catch(e){}
  }

  function drawMaxTripCircle(){
    if (!fenceMap || !fenceCenter) return;
    const radiusM = maxTripKm * 1000;
    if (maxTripCircle) {
      maxTripCircle.setLatLng([fenceCenter.lat, fenceCenter.lng]);
      maxTripCircle.setRadius(radiusM);
    } else {
      maxTripCircle = L.circle([fenceCenter.lat, fenceCenter.lng], {
        radius: radiusM,
        color: '#276ef1',
        fillColor: '#276ef1',
        fillOpacity: 0.05,
        weight: 2,
        dashArray: '8 6'
      }).addTo(fenceMap);
    }
  }

  function updateCoordsLabel(){
    if (!fenceCenter) { fenceCoords.textContent = 'Click map to set center'; return; }
    fenceCoords.textContent = `${fenceCenter.lat.toFixed(5)}, ${fenceCenter.lng.toFixed(5)}`;
  }

  function updateStatusPill(){
    if (fenceEnabled) {
      fenceStatus.className = 'status-pill on';
      fenceStatus.innerHTML = '<span class="status-dot"></span> On';
    } else {
      fenceStatus.className = 'status-pill off';
      fenceStatus.innerHTML = '<span class="status-dot"></span> Off';
    }
  }

  function showFenceMsg(text, type){
    fenceMsg.textContent = text;
    fenceMsg.className = 'panel-msg ' + type;
    fenceMsg.classList.remove('hidden');
    clearTimeout(fenceMsg._t);
    fenceMsg._t = setTimeout(()=>{ fenceMsg.classList.add('hidden'); }, 3000);
  }

  // Toggle on/off — saves immediately
  fenceToggle.addEventListener('change', async ()=>{
    fenceEnabled = fenceToggle.checked;
    updateStatusPill();
    try {
      await db.ref('settings/geofence').update({ enabled: fenceEnabled });
      showFenceMsg(fenceEnabled ? 'Geofence turned ON' : 'Geofence turned OFF', 'success');
    } catch(e){
      console.error(e);
      showFenceMsg('Failed to update', 'error');
    }
  });

  // Radius controls
  radiusMinus.addEventListener('click', ()=>{
    fenceRadiusKm = Math.max(1, fenceRadiusKm - 1);
    radiusInput.value = fenceRadiusKm;
    drawFenceCircle();
  });
  radiusPlus.addEventListener('click', ()=>{
    fenceRadiusKm = Math.min(500, fenceRadiusKm + 1);
    radiusInput.value = fenceRadiusKm;
    drawFenceCircle();
  });
  radiusInput.addEventListener('change', ()=>{
    let v = parseInt(radiusInput.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 500) v = 500;
    fenceRadiusKm = v;
    radiusInput.value = v;
    drawFenceCircle();
  });

  // Max trip distance controls
  maxTripMinus.addEventListener('click', ()=>{
    maxTripKm = Math.max(1, maxTripKm - 1);
    maxTripInput.value = maxTripKm;
    drawMaxTripCircle();
  });
  maxTripPlus.addEventListener('click', ()=>{
    maxTripKm = Math.min(500, maxTripKm + 1);
    maxTripInput.value = maxTripKm;
    drawMaxTripCircle();
  });
  maxTripInput.addEventListener('change', ()=>{
    let v = parseInt(maxTripInput.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 500) v = 500;
    maxTripKm = v;
    maxTripInput.value = v;
    drawMaxTripCircle();
  });

  // Save full geofence config
  fenceSaveBtn.addEventListener('click', async ()=>{
    if (!fenceCenter) { showFenceMsg('Click the map to set a center point first', 'error'); return; }
    fenceSaveBtn.disabled = true;
    fenceSaveBtn.textContent = 'Saving…';
    try {
      await db.ref('settings/geofence').set({
        enabled: fenceEnabled,
        lat: fenceCenter.lat,
        lng: fenceCenter.lng,
        radiusKm: fenceRadiusKm,
        maxTripKm: maxTripKm,
        updatedAt: Date.now()
      });
      showFenceMsg('Zone saved', 'success');
    } catch(e) {
      console.error(e);
      showFenceMsg('Failed to save', 'error');
    } finally {
      fenceSaveBtn.disabled = false;
      fenceSaveBtn.textContent = 'Save zone';
    }
  });

  // Reset to last saved
  fenceResetBtn.addEventListener('click', ()=>{
    loadFenceFromDB();
  });

  // Load saved geofence from Firebase
  function loadFenceFromDB(){
    db.ref('settings/geofence').once('value').then(snap => {
      const data = snap.val();
      if (!data) return;
      fenceEnabled = !!data.enabled;
      fenceToggle.checked = fenceEnabled;
      updateStatusPill();
      if (typeof data.lat === 'number' && typeof data.lng === 'number') {
        fenceCenter = { lat: data.lat, lng: data.lng };
      }
      if (typeof data.radiusKm === 'number') {
        fenceRadiusKm = data.radiusKm;
        radiusInput.value = fenceRadiusKm;
      }
      if (typeof data.maxTripKm === 'number') {
        maxTripKm = data.maxTripKm;
        maxTripInput.value = maxTripKm;
      }
      updateCoordsLabel();
      if (fenceCenter) drawFenceCircle();
    }).catch(e => console.error('Failed to load geofence', e));
  }

  // Also listen for live changes so admin sees updates if another admin modifies
  db.ref('settings/geofence').on('value', snap => {
    const data = snap.val();
    if (!data) return;
    fenceEnabled = !!data.enabled;
    fenceToggle.checked = fenceEnabled;
    updateStatusPill();
    if (typeof data.lat === 'number' && typeof data.lng === 'number') {
      fenceCenter = { lat: data.lat, lng: data.lng };
    }
    if (typeof data.radiusKm === 'number') {
      fenceRadiusKm = data.radiusKm;
      radiusInput.value = fenceRadiusKm;
    }
    if (typeof data.maxTripKm === 'number') {
      maxTripKm = data.maxTripKm;
      maxTripInput.value = maxTripKm;
    }
    updateCoordsLabel();
    if (fenceCenter) drawFenceCircle();
  });

  // Initialise map after a short delay to let the layout settle
  setTimeout(initFenceMap, 100);

  // ===== PRICING =====
  const priceNormalDayEl = document.getElementById('priceNormalDay');
  const priceNormalNightEl = document.getElementById('priceNormalNight');
  const priceHikeDayEl = document.getElementById('priceHikeDay');
  const priceHikeNightEl = document.getElementById('priceHikeNight');
  const priceNightHourEl = document.getElementById('priceNightHour');
  const priceBaseFareEl = document.getElementById('priceBaseFare');
  const pricePricePerStopEl = document.getElementById('pricePricePerStop');
  const priceSaveBtn = document.getElementById('priceSaveBtn');
  const priceResetBtn = document.getElementById('priceResetBtn');
  const priceMsg = document.getElementById('priceMsg');

  function showPriceMsg(text, type){
    priceMsg.textContent = text;
    priceMsg.className = 'panel-msg ' + type;
    priceMsg.classList.remove('hidden');
    clearTimeout(priceMsg._t);
    priceMsg._t = setTimeout(()=>{ priceMsg.classList.add('hidden'); }, 3000);
  }

  function applyPricingData(data){
    if (!data) return;
    if (typeof data.normalDay === 'number') priceNormalDayEl.value = data.normalDay;
    if (typeof data.normalNight === 'number') priceNormalNightEl.value = data.normalNight;
    if (typeof data.hikeDay === 'number') priceHikeDayEl.value = data.hikeDay;
    if (typeof data.hikeNight === 'number') priceHikeNightEl.value = data.hikeNight;
    if (typeof data.nightStartHour === 'number') priceNightHourEl.value = data.nightStartHour;
    if (typeof data.baseFare === 'number') priceBaseFareEl.value = data.baseFare;
    if (typeof data.pricePerStop === 'number') pricePricePerStopEl.value = data.pricePerStop;
  }

  // Live listener — syncs across admins
  db.ref('settings/pricing').on('value', snap => {
    const data = snap.val();
    if (data) applyPricingData(data);
  });

  priceSaveBtn.addEventListener('click', async ()=>{
    const normalDay = Math.max(1, Math.min(999, parseInt(priceNormalDayEl.value,10)||20));
    const normalNight = Math.max(1, Math.min(999, parseInt(priceNormalNightEl.value,10)||30));
    const hikeDay = Math.max(1, Math.min(999, parseInt(priceHikeDayEl.value,10)||35));
    const hikeNight = Math.max(1, Math.min(999, parseInt(priceHikeNightEl.value,10)||50));
    const nightStartHour = Math.max(0, Math.min(23, parseInt(priceNightHourEl.value,10)||22));
    const baseFare = Math.max(0, Math.min(999, parseInt(priceBaseFareEl.value,10)||0));
    const pricePerStop = Math.max(0, Math.min(999, parseInt(pricePricePerStopEl.value,10)||5));
    priceSaveBtn.disabled = true;
    priceSaveBtn.textContent = 'Saving…';
    try {
      await db.ref('settings/pricing').set({ normalDay, normalNight, hikeDay, hikeNight, nightStartHour, baseFare, pricePerStop, updatedAt: Date.now() });
      showPriceMsg('Pricing saved', 'success');
    } catch(e){
      console.error(e);
      showPriceMsg('Failed to save pricing', 'error');
    } finally {
      priceSaveBtn.disabled = false;
      priceSaveBtn.textContent = 'Save pricing';
    }
  });

  priceResetBtn.addEventListener('click', ()=>{
    db.ref('settings/pricing').once('value').then(snap => {
      const data = snap.val();
      if (data) applyPricingData(data);
      else showPriceMsg('No saved pricing found', 'error');
    });
  });

  // ===== PRICE HIKE ZONES =====
  const hikeMapEl = document.getElementById('hikeMap');
  const hikeRadiusInput = document.getElementById('hikeRadiusInput');
  const hikeRadiusMinus = document.getElementById('hikeRadiusMinus');
  const hikeRadiusPlus = document.getElementById('hikeRadiusPlus');
  const hikeCoords = document.getElementById('hikeCoords');
  const hikeAddBtn = document.getElementById('hikeAddBtn');
  const hikeMsg = document.getElementById('hikeMsg');
  const hikeZonesList = document.getElementById('hikeZonesList');

  let hikeMap = null;
  let hikePreviewCircle = null;
  let hikeCenter = null;
  let hikeRadiusKm = 5;
  let hikeZoneCircles = {}; // keyed by zone id -> L.circle

  function showHikeMsg(text, type){
    hikeMsg.textContent = text;
    hikeMsg.className = 'panel-msg ' + type;
    hikeMsg.classList.remove('hidden');
    clearTimeout(hikeMsg._t);
    hikeMsg._t = setTimeout(()=>{ hikeMsg.classList.add('hidden'); }, 3000);
  }

  function initHikeMap(){
    if (hikeMap) return;
    hikeMap = L.map(hikeMapEl, { zoomControl: true }).setView([-26.2041, 28.0473], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: 'networKING Technology' }).addTo(hikeMap);
    if (hikeMap.attributionControl) hikeMap.attributionControl.setPrefix('');
    setTimeout(()=>{ try{ hikeMap.invalidateSize(); }catch(e){} }, 200);

    hikeMap.on('click', (e)=>{
      hikeCenter = { lat: e.latlng.lat, lng: e.latlng.lng };
      drawHikePreview();
      hikeCoords.textContent = `${hikeCenter.lat.toFixed(5)}, ${hikeCenter.lng.toFixed(5)}`;
    });
  }

  function drawHikePreview(){
    if (!hikeMap || !hikeCenter) return;
    const radiusM = hikeRadiusKm * 1000;
    if (hikePreviewCircle) {
      hikePreviewCircle.setLatLng([hikeCenter.lat, hikeCenter.lng]);
      hikePreviewCircle.setRadius(radiusM);
    } else {
      hikePreviewCircle = L.circle([hikeCenter.lat, hikeCenter.lng], {
        radius: radiusM,
        color: '#e67e22',
        fillColor: '#e67e22',
        fillOpacity: 0.15,
        weight: 2,
        dashArray: '6 4'
      }).addTo(hikeMap);
    }
  }

  hikeRadiusMinus.addEventListener('click', ()=>{
    hikeRadiusKm = Math.max(1, hikeRadiusKm - 1);
    hikeRadiusInput.value = hikeRadiusKm;
    drawHikePreview();
  });
  hikeRadiusPlus.addEventListener('click', ()=>{
    hikeRadiusKm = Math.min(100, hikeRadiusKm + 1);
    hikeRadiusInput.value = hikeRadiusKm;
    drawHikePreview();
  });
  hikeRadiusInput.addEventListener('change', ()=>{
    let v = parseInt(hikeRadiusInput.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 100) v = 100;
    hikeRadiusKm = v;
    hikeRadiusInput.value = v;
    drawHikePreview();
  });

  hikeAddBtn.addEventListener('click', async ()=>{
    if (!hikeCenter) { showHikeMsg('Click the map to set a zone center first', 'error'); return; }
    hikeAddBtn.disabled = true;
    hikeAddBtn.textContent = 'Adding…';
    try {
      const r = db.ref('settings/hikeZones').push();
      await r.set({ lat: hikeCenter.lat, lng: hikeCenter.lng, radiusKm: hikeRadiusKm, createdAt: Date.now() });
      showHikeMsg('Hike zone added', 'success');
      // clear preview
      hikeCenter = null;
      hikeCoords.textContent = 'Click map to set zone center';
      if (hikePreviewCircle) { try{ hikeMap.removeLayer(hikePreviewCircle); }catch(e){} hikePreviewCircle = null; }
    } catch(e){
      console.error(e);
      showHikeMsg('Failed to add zone', 'error');
    } finally {
      hikeAddBtn.disabled = false;
      hikeAddBtn.textContent = 'Add zone';
    }
  });

  function renderHikeZones(snapshot){
    const val = snapshot.val() || {};
    hikeZonesList.innerHTML = '';
    // remove old circles from map
    Object.values(hikeZoneCircles).forEach(c => { try{ hikeMap.removeLayer(c); }catch(e){} });
    hikeZoneCircles = {};

    const keys = Object.keys(val);
    if (!keys.length) { hikeZonesList.innerHTML = '<div style="font-size:0.82rem;color:#888;text-align:center;padding:8px 0;">No hike zones yet</div>'; return; }

    keys.forEach((k, i) => {
      const z = val[k];
      // draw circle on map
      if (hikeMap && typeof z.lat === 'number' && typeof z.lng === 'number') {
        const c = L.circle([z.lat, z.lng], {
          radius: (z.radiusKm || 5) * 1000,
          color: '#e67e22',
          fillColor: '#e67e22',
          fillOpacity: 0.12,
          weight: 2
        }).addTo(hikeMap);
        hikeZoneCircles[k] = c;
      }
      // list item
      const el = document.createElement('div');
      el.className = 'hike-zone-item';
      el.innerHTML = `<div class="hike-zone-info"><strong>Zone ${i+1}</strong><span>${z.lat.toFixed(4)}, ${z.lng.toFixed(4)} · ${z.radiusKm||5} km</span></div>`;
      const rmBtn = document.createElement('button');
      rmBtn.className = 'remove';
      rmBtn.textContent = 'Remove';
      rmBtn.addEventListener('click', async ()=>{
        if (!confirm('Remove this hike zone?')) return;
        try{ await db.ref('settings/hikeZones/'+k).remove(); showHikeMsg('Zone removed', 'success'); }catch(e){ showHikeMsg('Failed to remove', 'error'); }
      });
      el.appendChild(rmBtn);
      hikeZonesList.appendChild(el);
    });
  }

  db.ref('settings/hikeZones').on('value', renderHikeZones);

  setTimeout(initHikeMap, 200);
});
