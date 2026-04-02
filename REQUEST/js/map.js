// js/map.js
export function createMap(containerId) {
  const map = L.map(containerId, {zoomControl:true}).setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: 'networKING Technology'
  }).addTo(map);
  if (map && map.attributionControl && typeof map.attributionControl.setPrefix === 'function') {
    map.attributionControl.setPrefix('');
  }
  return map;
}

function placeOrUpdate(map, marker, circle, lat, lon, acc) {
  if (!marker) {
    marker = L.marker([lat,lon]).addTo(map).bindPopup('You are here');
    circle = L.circle([lat,lon], {radius: acc}).addTo(map);
    map.setView([lat,lon], 16);
  } else {
    marker.setLatLng([lat,lon]);
    circle.setLatLng([lat,lon]).setRadius(acc);
  }
  return {marker, circle};
}

// locateOnce: fast-first (use cached/quick), then try high-accuracy update.
// If geolocation fails, attempt an IP-based fallback.
export function locateOnce(map, opts = {}) {
  return new Promise(async (resolve, reject) => {
    if (!navigator.geolocation) {
      // try IP fallback
      try {
        const ippos = await fetch('https://ipapi.co/json/').then(r => r.json());
        const lat = parseFloat(ippos.latitude), lon = parseFloat(ippos.longitude);
        const marker = L.marker([lat,lon]).addTo(map).bindPopup('Approximate location (IP)').openPopup();
        const circle = L.circle([lat,lon], {radius: 1000}).addTo(map);
        map.setView([lat,lon], 12);
        return resolve({marker, circle, position: null, fallback: 'ip'});
      } catch (e) {
        return reject(new Error('Geolocation not available'));
      }
    }

    let marker = null, circle = null;

    // Quick attempt: use cached position or a fast low-accuracy fix
    const quickOptions = { enableHighAccuracy: false, timeout: 2000, maximumAge: 60000 };
    const highOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

    let resolved = false;

    const onQuick = (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 50;
      ({marker, circle} = placeOrUpdate(map, marker, circle, lat, lon, acc));
      if (!resolved) {
        resolved = true;
        resolve({marker, circle, position: pos, fallback: 'quick'});
      }
    };

    const onQuickErr = async () => {
      // quick failed; fall back to high-accuracy attempt directly
      try {
        navigator.geolocation.getCurrentPosition(onHigh, onHighErr, highOptions);
      } catch (e) {
        // fall back to IP
        try {
          const ippos = await fetch('https://ipapi.co/json/').then(r => r.json());
          const lat = parseFloat(ippos.latitude), lon = parseFloat(ippos.longitude);
          ({marker, circle} = placeOrUpdate(map, marker, circle, lat, lon, 1000));
          map.setView([lat,lon], 12);
          if (!resolved) { resolved = true; resolve({marker, circle, position: null, fallback: 'ip'}); }
        } catch (e2) {
          if (!resolved) { resolved = true; reject(e2); }
        }
      }
    };

    const onHigh = (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 10;
      ({marker, circle} = placeOrUpdate(map, marker, circle, lat, lon, acc));
      if (!resolved) {
        resolved = true;
        resolve({marker, circle, position: pos, fallback: 'high'});
      }
    };

    const onHighErr = async (err) => {
      try {
        const ippos = await fetch('https://ipapi.co/json/').then(r => r.json());
        const lat = parseFloat(ippos.latitude), lon = parseFloat(ippos.longitude);
        ({marker, circle} = placeOrUpdate(map, marker, circle, lat, lon, 1000));
        map.setView([lat,lon], 12);
        if (!resolved) { resolved = true; resolve({marker, circle, position: null, fallback: 'ip'}); }
      } catch (e2) {
        if (!resolved) { resolved = true; reject(err || e2); }
      }
    };

    // Start quick then background high-accuracy
    try {
      navigator.geolocation.getCurrentPosition(onQuick, onQuickErr, quickOptions);
      // also schedule a high-accuracy update in parallel (it may take longer)
      navigator.geolocation.getCurrentPosition(onHigh, onHighErr, highOptions);
    } catch (e) {
      onQuickErr();
    }
  });
}

export function watchPosition(map, onUpdate) {
  if (!navigator.geolocation) return null;
  let marker = null, circle = null;
  const id = navigator.geolocation.watchPosition(pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 0;
    if (!marker) {
      marker = L.marker([lat,lon]).addTo(map).bindPopup('You are here');
      circle = L.circle([lat,lon], {radius: acc}).addTo(map);
    } else {
      marker.setLatLng([lat,lon]);
      circle.setLatLng([lat,lon]).setRadius(acc);
    }
    if (typeof onUpdate === 'function') onUpdate({marker,circle,position:pos});
  }, console.error, {enableHighAccuracy:true, maximumAge:0, timeout:10000});
  return () => navigator.geolocation.clearWatch(id);
}

// Routing helpers (uses public OSRM demo server)
let _currentRouteLayer = null;
let _currentDestMarker = null;
let _stopMarkers = [];

export async function routeBetween(map, fromLatLng, toLatLng) {
  if (!map) throw new Error('Map required');
  const from = Array.isArray(fromLatLng) ? fromLatLng : [fromLatLng.lat, fromLatLng.lng];
  const to = Array.isArray(toLatLng) ? toLatLng : [toLatLng.lat, toLatLng.lng];
  const fromLonLat = `${from[1]},${from[0]}`;
  const toLonLat = `${to[1]},${to[0]}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLonLat};${toLonLat}?overview=full&geometries=geojson&alternatives=false&steps=false`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Routing service error');
  const data = await resp.json();
  if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('No route found');
  const route = data.routes[0];
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);

  // clear previous
  if (_currentRouteLayer) { try { map.removeLayer(_currentRouteLayer); } catch(e){} _currentRouteLayer = null; }
  if (_currentDestMarker) { try { map.removeLayer(_currentDestMarker); } catch(e){} _currentDestMarker = null; }

  _currentRouteLayer = L.polyline(coords, {color:'#1978c8', weight:5, opacity:0.9}).addTo(map);
  _currentDestMarker = L.marker([to[0], to[1]]).addTo(map).bindPopup('Destination').openPopup();

  const bounds = _currentRouteLayer.getBounds();
  map.fitBounds(bounds, {padding:[40,40]});

  return {
    distance: route.distance, // meters
    duration: route.duration, // seconds
    geometry: coords,
    layer: _currentRouteLayer,
    destMarker: _currentDestMarker
  };
}

// Route through origin + multiple stops using OSRM waypoints
export async function routeMultiStop(map, originLatLng, stops) {
  if (!map) throw new Error('Map required');
  if (!stops || !stops.length) throw new Error('At least one stop required');

  // Build OSRM waypoints string: origin;stop1;stop2;...
  const points = [originLatLng, ...stops];
  const waypointStr = points.map(p => {
    const ll = Array.isArray(p) ? p : [p.lat, p.lng];
    return `${ll[1]},${ll[0]}`;
  }).join(';');

  const url = `https://router.project-osrm.org/route/v1/driving/${waypointStr}?overview=full&geometries=geojson&alternatives=false&steps=false`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Routing service error');
  const data = await resp.json();
  if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('No route found');
  const route = data.routes[0];
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);

  // clear previous route + markers
  if (_currentRouteLayer) { try { map.removeLayer(_currentRouteLayer); } catch(e){} _currentRouteLayer = null; }
  if (_currentDestMarker) { try { map.removeLayer(_currentDestMarker); } catch(e){} _currentDestMarker = null; }
  _stopMarkers.forEach(m => { try { map.removeLayer(m); } catch(e){} });
  _stopMarkers = [];

  _currentRouteLayer = L.polyline(coords, {color:'#1978c8', weight:5, opacity:0.9}).addTo(map);

  // Add numbered markers for each stop
  stops.forEach((s, i) => {
    const ll = Array.isArray(s) ? s : [s.lat, s.lng];
    const icon = L.divIcon({
      className: 'stop-number-icon',
      html: `<div style="background:#1978c8;color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)">${i+1}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    const m = L.marker(ll, { icon }).addTo(map).bindPopup(`Stop ${i+1}`);
    if (i === stops.length - 1) m.openPopup();
    _stopMarkers.push(m);
  });

  const bounds = _currentRouteLayer.getBounds();
  map.fitBounds(bounds, {padding:[40,40]});

  return {
    distance: route.distance,
    duration: route.duration,
    geometry: coords
  };
}

export function clearRoute(map) {
  if (_currentRouteLayer) { try { map.removeLayer(_currentRouteLayer); } catch(e){} _currentRouteLayer = null; }
  if (_currentDestMarker) { try { map.removeLayer(_currentDestMarker); } catch(e){} _currentDestMarker = null; }
  _stopMarkers.forEach(m => { try { map.removeLayer(m); } catch(e){} });
  _stopMarkers = [];
}
