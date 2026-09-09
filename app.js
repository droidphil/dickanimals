/* AT · Show & Tell — Appalachian Trail photo map (a Pic2Map-style EXIF viewer for a GPS-less thru-hike). */
'use strict';

const STORE_KEY = 'at-photo-journal-v1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const qattr = (s) => JSON.stringify(String(s)).replace(/"/g, '&quot;');

const state = {
  photos: [], screenshots: [], route: null,
  hike: null,
  checkins: [], overrides: {}, captions: {},
  photoLayer: null, checkinLayer: null, trail: null, map: null, draftLatLng: null,
  checkinBeingEdited: null, modalPhotoSelection: new Set(),
  view: 'map', stateCuts: [], photoMarkerById: {}, scrubMarker: null,
};

/* ---------------- persistence ---------------- */
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      hike: state.hike,
      checkins: state.checkins,
      overrides: state.overrides,
      captions: state.captions,
    }));
  } catch (e) { console.warn('save failed', e); }
}
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
function exportData() {
  const blob = new Blob([JSON.stringify({
    app: 'AT Show & Tell photo journal', exportedAt: new Date().toISOString(),
    hike: state.hike, checkins: state.checkins, overrides: state.overrides, captions: state.captions,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'at-show-and-tell-data.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Data exported');
}
function importData(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(rd.result);
      if (j.hike) state.hike = { ...state.hike, ...j.hike };
      state.checkins = Array.isArray(j.checkins) ? j.checkins : [];
      state.overrides = j.overrides || {};
      state.captions = j.captions || {};
      save(); location.reload();
    } catch (e) { toast('Could not read that file'); }
  };
  rd.readAsText(file);
}

/* ---------------- date / mile math ---------------- */
function dayNum(ymd) { const [y, m, d] = String(ymd).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); }
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  let t = '';
  const tm = iso.slice(11, 16);
  if (tm && tm.includes(':')) t = ' · ' + tm;
  return `${MONTHS[m - 1]} ${d}, ${y}${t}`;
}
function fmtMi(mi) { return mi == null ? '—' : (Math.round(mi * 10) / 10).toFixed(1); }
function anchorPts() {
  const h = state.hike;
  const pts = [{ d: dayNum(h.startDate), m: 0, label: h.startName }];
  for (const c of state.checkins) if (c.anchor && c.date && c.mile != null && c.mile > 0) pts.push({ d: dayNum(c.date), m: Number(c.mile), label: c.name, ci: c.id });
  pts.push({ d: dayNum(h.endDate), m: Number(h.totalMiles), label: h.endName });
  pts.sort((a, b) => a.d - b.d);
  return pts;
}
function mileForDay(dn) {
  const pts = anchorPts();
  if (dn == null) return null;
  if (dn <= pts[0].d) return 0;
  const last = pts[pts.length - 1];
  if (dn >= last.d) return last.m;
  for (let i = 1; i < pts.length; i++) {
    if (dn <= pts[i].d) {
      const a = pts[i - 1], b = pts[i];
      const f = b.d === a.d ? 0 : (dn - a.d) / (b.d - a.d);
      return a.m + f * (b.m - a.m);
    }
  }
  return last.m;
}
function dayForMile(mi) {
  const pts = anchorPts();
  mi = Number(mi);
  if (mi <= 0) return pts[0].d;
  const last = pts[pts.length - 1];
  if (mi >= last.m) return last.d;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (mi <= b.m) {
      if (b.m === a.m) return a.d;
      const f = (mi - a.m) / (b.m - a.m);
      return Math.round(a.d + f * (b.d - a.d));
    }
  }
  return last.d;
}
function mileForPhoto(p) {
  if (state.overrides[p.id] != null) return { mile: Number(state.overrides[p.id]), fixed: true };
  if (!p.date) return null;
  const dn = dayNum(p.date.slice(0, 10));
  if (state.hike && !isNaN(dn)) return { mile: mileForDay(dn), auto: true };
  return null;
}
function checkinForPhoto(id) { return state.checkins.find((c) => c.photoIds.includes(id)); }

/* route -> latlng, latlng -> mile */
function decimate(route) {
  // keep ≤ ~0.15 mi spacing for snappy map drawing & lookups
  const minGap = 0.15;
  const coords = [route.coords[0]], cum = [0];
  for (let i = 1; i < route.coords.length; i++) {
    if (route.cumMiles[i] - cum[cum.length - 1] >= minGap || i === route.coords.length - 1) {
      coords.push(route.coords[i]); cum.push(route.cumMiles[i]);
    }
  }
  return { coords, cum, measured: route.measuredMiles };
}
function cumForMile(mi) {
  const r = state.route;
  const scale = r.measured / Number(state.hike.totalMiles);
  return Number(mi) * scale;
}
function mileForCum(cum) {
  const r = state.route;
  return cum * Number(state.hike.totalMiles) / r.measured;
}
function miToLatLng(mi) {
  const r = state.route;
  const target = cumForMile(mi);
  const c = r.cum;
  if (target <= c[0]) return L.latLng(r.coords[0][1], r.coords[0][0]);
  if (target >= c[c.length - 1]) return L.latLng(r.coords[r.coords.length - 1][1], r.coords[r.coords.length - 1][0]);
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= target) lo = mid; else hi = mid; }
  const f = (c[hi] - c[lo]) === 0 ? 0 : (target - c[lo]) / (c[hi] - c[lo]);
  const a = r.coords[lo], b = r.coords[hi];
  return L.latLng(a[1] + f * (b[1] - a[1]), a[0] + f * (b[0] - a[0]));
}
function latLngToMi(ll) {
  const r = state.route;
  let best = 0, bd = Infinity;
  for (let i = 0; i < r.coords.length; i++) {
    const d = (r.coords[i][0] - ll.lng) ** 2 + (r.coords[i][1] - ll.lat) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return mileForCum(r.cum[best]);
}

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [ph, rt] = await Promise.all([
      fetch('data/photos.json').then((r) => r.json()),
      fetch('data/at-route.json').then((r) => r.json()),
    ]);
    state.photos = ph.photos; state.screenshots = ph.screenshots;
    state.route = decimate(rt);
    state.stateCuts = rt.stateCuts || DEFAULT_STATE_CUTS;
    $('#galleryCount').textContent = ph.counts.trailPhotos;
    $('#screenCount').textContent = ph.counts.screenshots;
    $('#screenCount2').textContent = ph.counts.screenshots;
    $('#brand-sub').textContent = `${ph.counts.trailPhotos} photos · ${fmtDate(ph.hike.defaultStartDate)} – ${fmtDate(ph.hike.defaultEndDate)}`;
    const fspan = document.querySelector('#foot span:first-child');
    if (fspan) fspan.textContent = `${ph.counts.trailPhotos} photos · ${ph.counts.screenshots} screenshots · ${fmtDate(ph.hike.defaultStartDate)} – ${fmtDate(ph.hike.defaultEndDate)}`;

    const st = loadStore();
    state.hike = {
      startDate: ph.hike.defaultStartDate, endDate: ph.hike.defaultEndDate,
      startName: ph.hike.startName, endName: ph.hike.endName,
      totalMiles: ph.hike.defaultTotalMiles,
      ...(st && st.hike ? st.hike : {}),
    };
    state.checkins = (st && st.checkins) || [];
    state.overrides = (st && st.overrides) || {};
    state.captions = (st && st.captions) || {};

    initUI();
    initMap();
    initTimelineBars();
    renderStats();
    renderCheckinList();
    renderGallery();
    renderScreens();
    fillSettings();
    state.view = 'map';
  } catch (e) {
    console.error(e);
    $('#view-map').outerHTML = `<div class="spinner-wrap"><div>Could not load data: ${esc(e.message)}<br>Start it with <code>node server.js</code> from the photo-map-site folder.</div></div>`;
  }
});

/* ---------------- UI chrome ---------------- */
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, ms);
}
function initUI() {
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#btnRandom').addEventListener('click', () => { const p = state.photos[Math.floor(Math.random() * state.photos.length)]; openDetail(p.id); });
  $('#btnExport').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
  $('#btnSettings').addEventListener('click', () => switchView('settings'));
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnResetData').addEventListener('click', () => { if (confirm('Delete all check-ins, captions and mile fixes from this browser?')) { localStorage.removeItem(STORE_KEY); location.reload(); } });
  $('#btnNewCheckin').addEventListener('click', () => openCheckinEditor(null, null));
  $('#ciSave').addEventListener('click', saveCheckin);
  $('#ciDelete').addEventListener('click', () => deleteCheckin(state.checkinBeingEdited));
  buildMonthOptions();
  $('#galleryReset').addEventListener('click', resetGalleryFilters);
  $('#gallerySearch').addEventListener('input', renderGallery);
  $('#galleryMonth').addEventListener('change', renderGallery);
  $('#gallerySort').addEventListener('change', renderGallery);
  $('#galleryPlacedOnly').addEventListener('change', renderGallery);
  $('#screenSort').addEventListener('change', renderScreens);
  $('#btnFit').addEventListener('click', fitTrail);
  $('#btnTogglePhotos').addEventListener('click', togglePhotos);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });
  $$('[data-close-drawer]').forEach((el) => el.addEventListener('click', closeDrawer));
  $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));
  // mobile rail opener
  $('#btnListRail').addEventListener('click', toggleRail);
}
function toggleRail() {
  const rail = $('#rail');
  if (window.innerWidth <= 900) rail.classList.toggle('open');
  else {
    const hidden = document.body.classList.toggle('rail-hidden');
    $('#btnListRail').textContent = hidden ? '☰ Show check-ins' : '✕ Hide check-ins';
  }
}
function switchView(name) {
  state.view = name;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'map' && state.map) setTimeout(() => state.map.invalidateSize(), 60);
  hideTsPreview();
  hideHoverZoom();
  if (name !== 'map' && state.scrubMarker && state.map) { state.map.removeLayer(state.scrubMarker); state.scrubMarker = null; }
}

/* ---------------- map ---------------- */
function initMap() {
  const map = L.map('map', { zoomControl: true, attributionControl: true });
  state.map = map;
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
  });
  osm.addTo(map);
  L.control.layers({ 'Trail map': osm, 'Topographic': topo, 'Satellite': sat }, null, { position: 'topright' }).addTo(map);

  // the trail
  const r = state.route;
  state.trail = L.polyline(r.coords.map((c) => [c[1], c[0]]), { color: '#8a4d1d', weight: 3.5, opacity: .95 }).addTo(map);
  // termini
  const term = (mi, label, cls) => L.marker(miToLatLng(mi), { icon: L.divIcon({ className: '', html: `<div class="ci-flag ${cls}" style="background:#6b3010"><span>&#9875;</span></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map).bindPopup(`<b>${esc(label)}</b><br><span class="lp-mile">mile ${fmtMi(mi)}</span>`);
  term(0, 'Springer Mountain · southern terminus', '');
  term(Number(state.hike.totalMiles), 'Katahdin · northern terminus', '');
  // faint 100-mile labels along the trail
  const miLabel = (m) => L.marker(miToLatLng(m), {
    interactive: false,
    icon: L.divIcon({ className: '', html: `<div class="mi-label">${m} mi</div>`, iconSize: [0, 0] }),
    zIndexOffset: -10,
  }).addTo(map);
  for (let m = 100; m < Number(state.hike.totalMiles); m += 100) miLabel(m);

  map.on('click', (ev) => {
    // ignore clicks on markers, popups, controls and the trail's own popups
    const t = ev.originalEvent && ev.originalEvent.target;
    if (t && t.closest && t.closest('.leaflet-marker-icon,.leaflet-interactive,.leaflet-popup,.leaflet-control,.leaflet-bar,.mi-label')) return;
    const mi = latLngToMi(ev.latlng);
    // only treat clicks very close to the trail as check-in placement
    const pt = miToLatLng(mi);
    const d = ev.latlng.distanceTo(pt);
    if (d < 450) openCheckinEditor(null, mi);
    else toast('Click on the trail line to add a check-in');
  });

  state.checkinLayer = L.layerGroup().addTo(map);
  state.photoLayer = L.markerClusterGroup({
    maxClusterRadius: 44, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
    iconCreateFunction: (cl) => L.divIcon({ html: `<div class="cc-badge">${cl.getChildCount()}</div>`, className: '', iconSize: [30, 30] }),
  }).addTo(map);

  fitTrail();
  renderTrailMarkers();
}
function fitTrail() {
  if (!state.map) return;
  const r = state.route;
  const c0 = r.coords[0], cN = r.coords[r.coords.length - 1];
  state.map.fitBounds(L.latLngBounds(L.latLng(Math.min(c0[1], cN[1]), Math.min(c0[0], cN[0])), L.latLng(Math.max(c0[1], cN[1]), Math.max(c0[0], cN[0]))), { padding: [30, 30] });
}
function togglePhotos() {
  if (state.map.hasLayer(state.photoLayer)) { state.map.removeLayer(state.photoLayer); $('#btnTogglePhotos').textContent = 'Show photo dots'; }
  else { state.map.addLayer(state.photoLayer); $('#btnTogglePhotos').textContent = 'Hide photo dots'; }
}
function renderTrailMarkers() {
  if (!state.map) return;
  // check-ins
  state.checkinLayer.clearLayers();
  const sorted = [...state.checkins].sort((a, b) => a.mile - b.mile);
  const idx = new Map(sorted.map((c, i) => [c.id, i + 1]));
  for (const c of sorted) {
    const flag = L.marker(miToLatLng(c.mile), {
      icon: L.divIcon({ className: '', html: `<div class="ci-flag ${c.anchor ? 'anchor-flag' : ''}"><span>${idx.get(c.id)}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      title: c.name,
    }).addTo(state.checkinLayer);
    flag.bindPopup(checkinPopup(c, idx.get(c.id)), { maxWidth: 300 });
    flag.on('click', () => { /* active list highlight */ });
  }
  // photos
  state.photoLayer.clearLayers();
  state.photoMarkerById = {};
  for (const p of state.photos) {
    const mp = mileForPhoto(p);
    if (!mp) continue;
    const m = L.marker(miToLatLng(mp.mile), {
      icon: L.divIcon({ className: '', html: '<div class="ph-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
      riseOnHover: true,
    });
    m.options.pid = p.id;
    m.bindPopup(photoPopup(p, mp), { maxWidth: 290 });
    m.on('click', () => {});
    m.addTo(state.photoLayer);
    state.photoMarkerById[p.id] = m;
  }
}
function photoPopup(p, mp) {
  const ci = checkinForPhoto(p.id);
  const cap = state.captions[p.id] || '';
  return `<div style="width:238px">
    <img class="lp-thumb" loading="lazy" src="thumbs/480/${encodeURIComponent(p.id)}" alt="">
    <p class="lp-name">${fmtDate(p.date)}</p>
    <p><span class="lp-mile">mile ${fmtMi(mp.mile)}</span> ${mp.fixed ? '· pinned' : mp.auto ? '· auto' : ''}${ci ? `<span class="chip">${esc(ci.name)}</span>` : ''}</p>
    ${p.summary ? `<p style="font-size:11.5px;color:var(--ink-soft)">${esc(p.summary)}</p>` : ''}
    ${cap ? `<p style="font-size:11.5px;font-style:italic">${esc(cap.slice(0, 90))}</p>` : ''}
    <div class="lp-actions"><button class="primary small" onclick="openDetail(${qattr(p.id)})">Open photo</button></div>
  </div>`;
}
function checkinPopup(c, n) {
  const thumbs = c.photoIds.slice(0, 4).map((id) => `<img src="thumbs/480/${encodeURIComponent(id)}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;margin:1px" alt="">`).join('');
  return `<div style="width:250px">
    <p class="lp-mile">check-in ${n} · mile ${fmtMi(c.mile)}</p>
    <p class="lp-name">${esc(c.name)}</p>
    <p class="lp-date">${c.date ? fmtDate(c.date) : 'no date'}${c.anchor ? ' · calibration anchor' : ''}</p>
    ${c.note ? `<p style="font-size:12px;color:var(--ink-soft);white-space:pre-line">${esc(c.note)}</p>` : ''}
    ${thumbs ? `<div style="display:flex;flex-wrap:wrap;gap:2px">${thumbs}</div>` : ''}
    <div class="lp-actions">
      <button class="primary small" onclick="openCheckinEditor('${c.id}')">Edit</button>
      ${c.photoIds.length ? `<button class="ghost-inline" onclick="openDetail(${qattr(c.photoIds[0])})">First photo</button>` : ''}
    </div>
  </div>`;
}

/* ---------------- check-in editor ---------------- */
function openCheckinEditor(checkinId, mileHint) {
  state.checkinBeingEdited = checkinId || null;
  const c = checkinId ? state.checkins.find((x) => x.id === checkinId) : null;
  const h = state.hike;
  $('#modalTitle').textContent = c ? 'Edit check-in' : 'New FarOut-style check-in';
  let mile = mileHint != null ? Math.round(mileHint * 10) / 10 : (c ? Number(c.mile) : null);
  const guessDn = c ? (c.date || (mile != null ? dayForMile(mile) : null)) : (mile != null ? dayForMile(mile) : null);
  $('#ciName').value = c ? c.name : (mile != null ? `Around mile ${fmtMi(mile)}` : '');
  $('#ciMile').value = mile != null ? mile : '';
  $('#ciDate').value = c && c.date ? c.date : (guessDn != null ? ymdFromDay(guessDn) : '');
  $('#ciNote').value = (c && c.note) || '';
  $('#ciAnchor').checked = !!(c && c.anchor);
  $('#ciDelete').hidden = !c;
  $('#modalSub').innerHTML = c
    ? `Editing <b>${esc(c.name)}</b>${c.date ? ' · ' + fmtDate(c.date) : ''}.`
    : (mileHint != null ? `Placed at <b>mile ${fmtMi(mile)}</b> (≈ ${fmtDate(ymdFromDay(guessDn))}) — edit either one.` : 'Give it a mile — or close and click the trail line instead.');
  state.modalPhotoSelection = new Set(c ? c.photoIds : []);
  const photosWithMile = state.photos.filter((p) => mileForPhoto(p) != null);
  // nearest photos by mile
  if (mile != null) {
    photosWithMile.sort((a, b) => Math.abs(mileForPhoto(a).mile - mile) - Math.abs(mileForPhoto(b).mile - mile));
  } else {
    photosWithMile.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  const cand = photosWithMile.slice(0, 80);
  const grid = $('#ciPhotoGrid');
  grid.innerHTML = '';
  $('#ciPickHint').textContent = mile != null ? 'Suggested: photos closest to this mile (open a photo to pin it precisely, then check it here).' : 'Pick the photos taken at this spot.';
  $('#ciSelNear').onclick = () => ciSelectN(10);
  $('#ciSelNone').onclick = () => ciSelectN(0);
  for (const p of cand) {
    const mp = mileForPhoto(p);
    const el = document.createElement('div');
    el.className = 'pick';
    el.dataset.id = p.id;
    const sel = state.modalPhotoSelection.has(p.id);
    el.innerHTML = `<img loading="lazy" src="thumbs/480/${encodeURIComponent(p.id)}" alt=""><span class="mile">~${fmtMi(mp && mp.mile)}</span><span class="pd">${fmtDate(p.date)}</span><span class="tk">&#10003;</span>`;
    if (sel) el.classList.add('sel');
    el.addEventListener('click', () => {
      if (state.modalPhotoSelection.has(p.id)) state.modalPhotoSelection.delete(p.id); else state.modalPhotoSelection.add(p.id);
      el.classList.toggle('sel');
      updateCiCounter();
    });
    grid.appendChild(el);
  }
  $('#ciMile').onchange = () => {
    const mv = parseFloat($('#ciMile').value);
    if (isFinite(mv) && !$('#ciDate').value) {
      $('#ciDate').value = ymdFromDay(dayForMile(mv));
      $('#modalSub').innerHTML = `Check-in at mile ${fmtMi(mv)} — date estimated ${fmtDate($('#ciDate').value)}.`;
    }
  };
  $('#ciCounter').textContent = state.modalPhotoSelection.size ? `${state.modalPhotoSelection.size} photo(s) attached` : '';
  showModal();
}
function updateCiCounter() {
  $('#ciCounter').textContent = state.modalPhotoSelection.size ? `${state.modalPhotoSelection.size} photo(s) attached` : '';
}
function ciSelectN(n) {
  const picks = $$('#ciPhotoGrid .pick');
  if (n === 0) state.modalPhotoSelection.clear();
  picks.forEach((el, i) => {
    if (i < n) { state.modalPhotoSelection.add(el.dataset.id); el.classList.add('sel'); }
    else { state.modalPhotoSelection.delete(el.dataset.id); el.classList.remove('sel'); }
  });
  updateCiCounter();
}
function ymdFromDay(dn) { return new Date(dn * DAY).toISOString().slice(0, 10); }
function saveCheckin() {
  const name = $('#ciName').value.trim();
  const mile = parseFloat($('#ciMile').value);
  const date = $('#ciDate').value || null;
  const note = $('#ciNote').value.trim();
  const anchor = $('#ciAnchor').checked;
  if (!name) { toast('Give this check-in a name'); return; }
  if (!isFinite(mile) || mile < 0) { toast('Enter a valid trail mile'); return; }
  const rec = { id: state.checkinBeingEdited || 'ci-' + Math.random().toString(36).slice(2, 9), name, mile: Math.round(mile * 10) / 10, date, note, anchor, photoIds: [...state.modalPhotoSelection] };
  // remove photo from other check-ins
  for (const c of state.checkins) if (c.id !== rec.id) c.photoIds = c.photoIds.filter((x) => !rec.photoIds.includes(x));
  if (state.checkinBeingEdited) {
    const i = state.checkins.findIndex((c) => c.id === rec.id);
    state.checkins[i] = rec;
  } else state.checkins.push(rec);
  save(); closeModal(); renderCheckinList(); renderTrailMarkers(); renderGallery(); renderStats();
  toast(`Saved “${name}”`);
  fitTrail();
}
function deleteCheckin(id) {
  const c = state.checkins.find((x) => x.id === id);
  if (c && confirm(`Delete check-in “${c.name}” (${c.photoIds.length} photo(s) attached)?`)) {
    state.checkins = state.checkins.filter((x) => x.id !== id);
    save(); closeModal(); renderCheckinList(); renderTrailMarkers(); renderGallery(); renderStats();
    toast('Check-in deleted');
  }
}
function showModal() { $('#modal').hidden = false; $('#modal').setAttribute('aria-hidden', 'false'); }
function closeModal() { $('#modal').hidden = true; $('#modal').setAttribute('aria-hidden', 'true'); }

/* ---------------- check-in rail list (grouped by state + brief history) ---------------- */
function renderCheckinList() {
  const ul = $('#checkinList');
  ul.innerHTML = '';
  const byState = new Map();
  for (const c of state.checkins) {
    const n = stateNameOf(c.mile);
    if (!byState.has(n)) byState.set(n, []);
    byState.get(n).push(c);
  }
  const perState = new Map();
  for (const p of state.photos) {
    const mp = mileForPhoto(p);
    if (!mp) continue;
    const n = stateNameOf(mp.mile);
    perState.set(n, (perState.get(n) || 0) + 1);
  }
  for (const s of state.stateCuts.slice().sort((a, b) => a.from - b.from)) {
    const items = (byState.get(s.state) || []).slice().sort((a, b) => a.mile - b.mile);
    const nPhotos = perState.get(s.state) || 0;
    const sec = document.createElement('li');
    sec.className = 'state-sec' + (items.length === 0 && nPhotos === 0 ? ' empty' : '');
    const blurb = STATE_BLURBS[s.state] || '';
    const mid = ((Number(s.from) + Number(s.to)) / 2).toFixed(1);
    const itemsHTML = items.map((c) => {
      const thumbs = c.photoIds.slice(0, 4).map((id) => `<img loading="lazy" src="thumbs/480/${encodeURIComponent(id)}" alt="">`).join('');
      return `<li class="ci-item" data-mid="${fmtMi(c.mile)}" data-name="${esc(c.name)}" data-id="${c.id}">
        <div class="ci-top"><span class="ci-mile">${fmtMi(c.mile)} mi</span><span class="ci-name">${esc(c.name)}</span><span class="ci-date">${c.date ? fmtDate(c.date) : ''}</span></div>
        ${c.note ? `<p class="ci-note">${esc(c.note)}</p>` : ''}
        <div class="ci-meta">${c.anchor ? '<span class="chip anchor">calibration anchor</span>' : ''}<span class="chip">${c.photoIds.length} photo(s)</span>
          <span class="ci-thumbs">${thumbs}${c.photoIds.length > 4 ? `<span class="ci-thumb-more">+${c.photoIds.length - 4}</span>` : ''}</span>
          <span class="spacer"></span>
          <button class="primary small" onclick="event.stopPropagation();openCheckinEditor('${c.id}')">Edit</button>
        </div></li>`;
    }).join('');
    sec.innerHTML = `
      <div class="state-head" data-mid="${mid}" data-name="${esc(s.state)}">
        <span class="st-name">${esc(s.state)}</span>
        <span class="st-mile">mi ${fmtMi(s.from)} – ${fmtMi(s.to)}</span>
        <span class="st-badge">${nPhotos} photo${nPhotos === 1 ? '' : 's'}</span>
      </div>
      ${blurb ? `<p class="state-hist">${esc(blurb)}</p>` : ''}
      <ul class="ci-list">${itemsHTML}</ul>
      ${items.length === 0 && nPhotos > 0 ? '<p class="sec-empty-note">No check-in here yet — open a photo of this state and add one.</p>' : ''}`;
    sec.querySelector('.state-head').addEventListener('click', () => {
      if (state.map) {
        state.map.setView(miToLatLng(Number(mid)), Math.max(state.map.getZoom(), 8));
        toast(`${s.state} — mile ${fmtMi(mid)}`);
      }
    });
    sec.querySelectorAll('.ci-item').forEach((li) => {
      li.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        const m = Number(li.dataset.mid);
        const nm = li.dataset.name;
        if (state.map) {
          state.map.setView(miToLatLng(m), Math.max(state.map.getZoom(), 11));
          toast(`Mile ${fmtMi(m)} · ${nm}`);
        }
      });
    });
    ul.appendChild(sec);
  }
  renderStats();
}
function renderStats() {
  const placed = state.photos.filter((p) => mileForPhoto(p) != null).length;
  $('#statPhotos').textContent = state.photos.length;
  $('#statPlaced').textContent = placed;
  $('#statCheckins').textContent = state.checkins.length;
  const h = state.hike;
  const days = dayNum(h.endDate) - dayNum(h.startDate);
  $('#statPace').textContent = days > 0 ? (Number(h.totalMiles) / days).toFixed(1) : '—';
}

/* ---------------- gallery ---------------- */
function buildMonthOptions() {
  const set = new Set(state.photos.filter((p) => p.date).map((p) => p.date.slice(0, 7)));
  const sel = $('#galleryMonth');
  sel.innerHTML = '<option value="">All months</option>';
  [...set].sort().forEach((m) => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = MONTHS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
    sel.appendChild(o);
  });
}
function galleryFiltered() {
  const q = $('#gallerySearch').value.trim().toLowerCase();
  const month = $('#galleryMonth').value;
  const placedOnly = $('#galleryPlacedOnly').checked;
  let arr = state.photos.filter((p) => {
    if (month && (!p.date || !p.date.startsWith(month))) return false;
    if (q) {
      const ci = checkinForPhoto(p.id);
      const hay = `${p.id} ${state.captions[p.id] || ''} ${ci ? ci.name + ' ' + ci.note : ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const mp = mileForPhoto(p);
    if (placedOnly && mp == null) return false;
    return true;
  });
  const sort = $('#gallerySort').value;
  arr.sort((a, b) => {
    if (sort === 'dateAsc' || sort === 'dateDesc') {
      const c = (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0;
      return sort === 'dateAsc' ? c : -c;
    }
    const ma = mileForPhoto(a), mb = mileForPhoto(b);
    const va = ma ? ma.mile : null, vb = mb ? mb.mile : null;
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // unplaced always last
    if (vb == null) return -1;
    const c = va - vb;
    return sort.startsWith('mileAsc') ? c : -c;
  });
  return arr;
}
function renderGallery() {
  if (!state.photos.length) return;
  const arr = galleryFiltered();
  const grid = $('#galleryGrid');
  grid.innerHTML = '';
  $('#galleryEmpty').hidden = arr.length > 0;
  for (const p of arr) {
    const mp = mileForPhoto(p);
    const ci = checkinForPhoto(p.id);
    const cap = state.captions[p.id];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<figure><img loading="lazy" src="thumbs/480/${encodeURIComponent(p.id)}" alt="${esc(p.date || p.id)}"></figure>
      <div class="cap">
        <div class="d"><span>${fmtDate(p.date)}</span>${mp ? `<span class="milechip">${fmtMi(mp.mile)} mi</span>` : '<span class="chip">no date</span>'}</div>
        <div class="t">${cap ? esc(cap) : (ci ? `In check-in “${esc(ci.name)}”` : (p.summary || p.id))}</div>
      </div>`;
    card.addEventListener('click', () => openDetail(p.id));
    card.addEventListener('mouseenter', () => showHoverZoom(p));
    card.addEventListener('mouseleave', hideHoverZoom);
    card.dataset.photo = p.id;
    grid.appendChild(card);
  }
}
function resetGalleryFilters() { $('#gallerySearch').value = ''; $('#galleryMonth').value = ''; $('#galleryPlacedOnly').checked = false; renderGallery(); }

/* ---------------- screenshots ---------------- */
function renderScreens() {
  const grid = $('#screenGrid');
  const sort = $('#screenSort').value;
  const arr = [...state.screenshots];
  arr.sort((a, b) => {
    if (sort.startsWith('date')) { const c = (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0; return sort === 'dateAsc' ? c : -c; }
    const c = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return sort === 'nameAsc' ? c : -c;
  });
  grid.innerHTML = '';
  for (const s of arr) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<figure><img loading="lazy" src="thumbs/480/${encodeURIComponent(s.id)}" alt=""></figure>
      <div class="cap"><div class="d"><span>${fmtDate(s.date)}</span></div><div class="t" title="${esc(s.id)}">${esc(s.id.slice(0, 42))}${s.id.length > 42 ? '…' : ''}</div></div>`;
    card.addEventListener('click', () => openDetail(s.id, true));
    card.addEventListener('mouseenter', () => showHoverZoom(s, true));
    card.addEventListener('mouseleave', hideHoverZoom);
    grid.appendChild(card);
  }
}

/* ---------------- detail drawer ---------------- */
function openDetail(photoId, isScreen) {
  const p = isScreen ? state.screenshots.find((x) => x.id === photoId) : state.photos.find((x) => x.id === photoId);
  if (!p) return;
  const body = $('#drawerBody');
  const mp = isScreen ? null : mileForPhoto(p);
  const ci = isScreen ? null : checkinForPhoto(p.id);
  const cap = state.captions[p.id] || '';
  const exifPanel = (title, rows) => rows.length ? `<div class="panel"><h3>${title}</h3><dl>${rows.map(([k, v]) => v == null || v === '' ? '' : `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>` : '';
  const placementHTML = isScreen ? '' : `
    <div class="panel">
      <h3>Trail placement</h3>
      <div class="placement">
        <div class="mile-big">${mp ? fmtMi(mp.mile) : '—'} <span style="font-size:13px;color:var(--ink-soft)">mi</span></div>
        <div class="mile-est">${mp ? (mp.fixed ? 'You pinned this mile.' : `Auto-estimated from ${fmtDate(p.date)} (linear date pace${state.checkins.some((c) => c.anchor) ? ', bent by your calibration anchors' : ''}).`) : (p.date ? 'Could not estimate — drag the slider to pin it.' : 'This photo has no readable date; pin it manually below.')}</div>
        ${ci ? `<div><span class="chip">In check-in “${esc(ci.name)}”</span> <button class="link" onclick="detachFromCheckin('${p.id}')">remove</button></div>` : ''}
        <div class="slider-row">
          <input type="range" id="dtMileSlider" min="0" max="${Number(state.hike.totalMiles)}" step="0.1" value="${mp ? mp.mile : 0}">
          <input type="number" id="dtMileNum" style="width:92px" step="0.1" min="0" max="${Number(state.hike.totalMiles)}" value="${mp ? mp.mile : ''}" placeholder="exact mile">
        </div>
        <div>
          <button class="primary small" id="dtApply">Pin at this mile</button>
          ${ci ? '' : `<button class="ghost small" id="dtCheckin">Make a check-in here…</button>`}
        </div>
        <p class="trail-note">Miles follow FarOut-style guide miles (0 = Springer, ${fmtMi(state.hike.totalMiles)} ≈ Katahdin). Pin any photo you remember precisely — it will move on the map instantly.</p>
      </div>
    </div>`;
  const cameraRows = [];
  if (p.make || p.model) cameraRows.push(['Device', [p.make, p.model].filter(Boolean).join(' ')]);
  if (p.lens) cameraRows.push(['Lens', p.lens]);
  if (p.software) cameraRows.push(['Software', p.software]);
  const exRows = [];
  if (p.exposure) exRows.push(['Shutter speed', p.exposure]);
  if (p.fnumber) exRows.push(['Aperture (F Number)', 'f/' + p.fnumber]);
  if (p.iso) exRows.push(['ISO speed', p.iso]);
  if (p.focal) exRows.push(['Focal length', p.focal + ' mm' + (p.focal35 ? ` (35 mm equiv. ${p.focal35} mm)` : '')]);
  if (p.flash) exRows.push(['Flash', p.flash]);
  const fileRows = [
    ['File', p.id], ['Taken', p.dateText || fmtDate(p.date)], ['Timezone offset', p.tzOffset || '—'],
    ['Image size', p.w ? `${p.w} × ${p.h} px` : '—'], ['Megapixels', p.w && p.h ? (p.w * p.h / 1e6).toFixed(1) : '—'],
    ['MIME type', 'image/jpeg'], ['Size on disk', p.bytes ? (p.bytes / 1e6).toFixed(1) + ' MB' : '—'],
  ];
  body.innerHTML = `
  <div class="detail">
    <div class="photo-side">
      <img class="ph" src="thumbs/1600/${encodeURIComponent(p.id)}" alt="">
    </div>
    <div class="info-side">
      <h2>${isScreen ? 'Screenshot' : fmtDate(p.date)}</h2>
      <div class="sub">${p.summary ? esc(p.summary) : (p.make || 'no camera info')}${mp ? ` · ~ mile ${fmtMi(mp.mile)}` : ''}</div>
      ${placementHTML}
      <div class="panel"><h3>Caption · show &amp; tell</h3>
        <textarea class="caption-box" id="dtCaption" rows="2" placeholder="Tell the story of this photo…">${esc(cap)}</textarea>
        <div class="actions" style="margin-top:8px"><button class="primary small" id="dtSaveCap">Save caption</button></div>
      </div>
      ${exifPanel('Camera', cameraRows)}
      ${exifPanel('Exposure', exRows)}
      ${exifPanel('File &amp; date', fileRows)}
      ${isScreen ? '' : '<p class="trail-note">Like Pic2Map, this panel shows the EXIF data embedded by the phone. The GPS block is missing because location data was stripped from these files — that is why placement is by trail mile instead of coordinates.</p>'}
    </div>
  </div>`;
  const msel = $('#dtMileSlider'), mnum = $('#dtMileNum');
  const sync = (v) => { msel.value = v; mnum.value = Math.round(Number(v) * 10) / 10; };
  msel.addEventListener('input', () => { mnum.value = msel.value; });
  mnum.addEventListener('input', () => { msel.value = Math.min(Math.max(mnum.value, 0), state.hike.totalMiles); });
  $('#dtApply').addEventListener('click', () => {
    const v = parseFloat(mnum.value || msel.value);
    if (!isFinite(v)) { toast('Enter a mile'); return; }
    state.overrides[p.id] = Math.round(v * 10) / 10;
    save(); renderTrailMarkers(); renderGallery(); renderCheckinList(); renderStats();
    toast(`Pinned ${p.id.slice(0, 22)} at mile ${fmtMi(v)}`);
  });
  const mk = $('#dtCheckin');
  if (mk) mk.addEventListener('click', () => { closeDrawer(); const m = mileForPhoto(p); openCheckinEditor(null, m ? m.mile : 0); if (m) $('#ciDate').value = p.date ? p.date.slice(0, 10) : ''; state.modalPhotoSelection.add(p.id); updateCiCounter(); $$('#ciPhotoGrid .pick').forEach((el) => el.classList.toggle('sel', state.modalPhotoSelection.has(el.dataset.id))); });
  $('#dtSaveCap').addEventListener('click', () => {
    const t = $('#dtCaption').value.trim();
    if (t) state.captions[p.id] = t; else delete state.captions[p.id];
    save(); renderGallery(); renderCheckinList(); toast('Caption saved');
  });
  showDrawer();
}
function detachFromCheckin(photoId) {
  for (const c of state.checkins) c.photoIds = c.photoIds.filter((x) => x !== photoId);
  delete state.overrides[photoId];
  save(); renderTrailMarkers(); renderCheckinList(); renderGallery(); renderStats();
  toast('Removed from check-in');
  closeDrawer();
}
function showDrawer() { $('#drawer').hidden = false; $('#drawer').setAttribute('aria-hidden', 'false'); }
function closeDrawer() { $('#drawer').hidden = true; $('#drawer').setAttribute('aria-hidden', 'true'); }

/* ---------------- settings ---------------- */
function fillSettings() {
  const h = state.hike;
  $('#setStartDate').value = h.startDate; $('#setEndDate').value = h.endDate;
  $('#setStartName').value = h.startName || ''; $('#setEndName').value = h.endName || '';
  $('#setTotalMiles').value = h.totalMiles;
}
function saveSettings() {
  const s = $('#setStartDate').value, e = $('#setEndDate').value;
  if (!s || !e) { toast('Need both dates'); return; }
  state.hike.startDate = s; state.hike.endDate = e;
  state.hike.startName = $('#setStartName').value || state.hike.startName;
  state.hike.endName = $('#setEndName').value || state.hike.endName;
  const tm = parseFloat($('#setTotalMiles').value);
  state.hike.totalMiles = isFinite(tm) && tm > 0 ? tm : state.hike.totalMiles;
  save(); renderTrailMarkers(); renderGallery(); renderCheckinList(); renderStats(); renderGallery();
  fillSettings();
  toast('Hike settings saved — auto-placed photos now follow the new dates/miles.');
}

/* init helpers called after boot */

/* ================= timeline scrubber, hover-enlarge, state history ================= */

const DEFAULT_STATE_CUTS = [
  { state: 'Georgia', from: 0, to: 78.2 },
  { state: 'North Carolina & Tennessee', from: 78.2, to: 468 },
  { state: 'Virginia', from: 468, to: 1018 },
  { state: 'West Virginia', from: 1018, to: 1024.5 },
  { state: 'Maryland', from: 1024.5, to: 1065.5 },
  { state: 'Pennsylvania', from: 1065.5, to: 1294.5 },
  { state: 'New Jersey', from: 1294.5, to: 1366.5 },
  { state: 'New York', from: 1366.5, to: 1454.5 },
  { state: 'Connecticut', from: 1454.5, to: 1506.5 },
  { state: 'Massachusetts', from: 1506.5, to: 1596.5 },
  { state: 'Vermont', from: 1596.5, to: 1746.5 },
  { state: 'New Hampshire', from: 1746.5, to: 1907.5 },
  { state: 'Maine', from: 1907.5, to: 2190.4 },
];

const STATE_BLURBS = {
  'Georgia': 'Where the journey begins — Springer Mountain, the 8.8-mile approach trail from Amicalola Falls, and some of the friendliest shelters on the trail before the climb over Blood Mountain.',
  'North Carolina & Tennessee': 'Nearly four hundred miles in which the trail rides the state line — through Great Smoky Mountains National Park and over the Roan Highlands, including the AT’s high point at Clingmans Dome (6,643 ft).',
  'Virginia': 'The longest state on the trail: the Triple Crown of McAfee Knob, Tinker Cliffs and Dragon’s Tooth, all of Shenandoah National Park, and hundreds of ridgeline miles that stretch both the legs and the mind.',
  'West Virginia': 'A blink of the trail through Harpers Ferry — home of the Appalachian Trail Conservancy and the place thru-hikers mark as their psychological halfway point.',
  'Maryland': '41 friendly, easy-going miles from the Potomac River toward the Mason–Dixon Line, where the trail trades southern mountains for gentle, wooded hills.',
  'Pennsylvania': '“Rocksylvania” — long rocky ridge walks and the legendary half-gallon ice-cream challenge at Pine Grove Furnace, just past the true halfway mark of the whole trail.',
  'New Jersey': 'The Garden State surprises: 72 quiet miles through dense woods, past Sunfish Pond’s glacial lake, up to the trail’s high point at High Point.',
  'New York': 'Eighty-eight miles of bear country heading north out of Jersey, ending with the Hudson crossing at the Bear Mountain Bridge — the trail’s lowest point.',
  'Connecticut': 'The shortest New England state — just over fifty easy miles of low, rolling, wooded hills through small towns that welcome hikers.',
  'Massachusetts': 'Ninety miles of New England walking up to Mt. Greylock (the state’s highest peak) and past the legendary “Cookie Lady” in Becket.',
  'Vermont': 'One hundred fifty miles over the Green Mountains, where the AT runs together with the Long Trail and the South’s heat gives way to cool alpine ridges.',
  'New Hampshire': 'The hardest miles on the whole trail: 161 rugged miles through the White Mountains — Franconia Ridge, the Presidentials and the exposed summit of Mt. Washington.',
  'Maine': 'The final push: the roadless 100-Mile Wilderness, the Bigelows and finally Katahdin, where the summit sign at Baxter Peak ends the journey.',
};

function stateNameOf(mile) {
  const cuts = state.stateCuts.length ? state.stateCuts : DEFAULT_STATE_CUTS;
  for (const s of cuts) if (mile >= s.from && mile < s.to) return s.state;
  return cuts.length ? cuts[cuts.length - 1].state : '—';
}

/* ---------- timeline bars ---------- */
const tsState = { cur: null, hideTimer: null };
function photoAt(idx) { return state.photos[Math.max(0, Math.min(idx, state.photos.length - 1))]; }

function initTimelineBars() {
  if (!state.photos.length) return;
  const first = state.photos[0], last = state.photos[state.photos.length - 1];
  [['#tsMap', 'map'], ['#tsGal', 'gallery']].forEach(([sel, kind]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.innerHTML = `
      <div class="ts-top">
        <span class="ts-date" data-role="date">${fmtDate(first.date)}</span>
        <input type="range" data-role="range" min="0" max="${state.photos.length - 1}" step="1" value="0"
               aria-label="Scrub through the hike by date" title="Drag to travel through the hike">
        <span class="ts-mile" data-role="mile">day 1</span>
      </div>
      <div class="ts-ends"><span data-role="start">${fmtDate(first.date)}</span><span>drag to travel — ${state.photos.length} photos</span><span data-role="end">${fmtDate(last.date)}</span></div>`;
    const range = el.querySelector('[data-role=range]');
    range.addEventListener('input', () => { tsGo(photoAt(Number(range.value)), kind, false); });
    range.addEventListener('change', () => { tsGo(photoAt(Number(range.value)), kind, true); });
    let outT = null;
    el.addEventListener('mouseenter', () => { clearTimeout(outT); });
    el.addEventListener('mouseleave', () => {
      clearTimeout(outT);
      outT = setTimeout(() => {
        hideTsPreview();
        if (state.map && state.scrubMarker) { state.map.removeLayer(state.scrubMarker); state.scrubMarker = null; }
      }, 700);
    });
  });
}
function tsGo(p, kind, isRelease) {
  tsState.cur = p;
  const dayLabel = p.date ? `day ${1 + Math.floor((Date.parse(p.date.slice(0, 10)) - Date.parse(state.hike.startDate)) / DAY)}` : '';
  document.querySelectorAll('.tsbar').forEach((b) => {
    const r = b.querySelector('[data-role=range]');
    const dEl = b.querySelector('[data-role=date]');
    const mEl = b.querySelector('[data-role=mile]');
    const cur = state.photos.indexOf(p);
    if (r && Number(r.value) !== cur) r.value = cur;
    if (dEl) dEl.textContent = fmtDate(p.date);
    if (mEl) mEl.textContent = dayLabel || '';
  });
  showTsPreview(p);
  const mp = kind === 'map' ? mileForPhoto(p) : null;
  if (kind === 'map' && mp && state.map && state.view === 'map') {
    const ll = miToLatLng(mp.mile);
    if (!state.scrubMarker) state.scrubMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="scrub-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 900 }).addTo(state.map);
    else state.scrubMarker.setLatLng(ll);
  }
  if (isRelease) {
    clearTimeout(tsState.hideTimer);
    tsState.hideTimer = setTimeout(() => {
      hideTsPreview();
      if (state.map && state.scrubMarker) { state.map.removeLayer(state.scrubMarker); state.scrubMarker = null; }
    }, 4200);
    if (kind === 'map' && mp && state.map && state.view === 'map') {
      const m = state.photoMarkerById[p.id];
      const dest = m ? m.getLatLng() : miToLatLng(mp.mile);
      state.map.flyTo(dest, Math.max(state.map.getZoom(), 12), { duration: 0.7 });
      if (m && state.map.hasLayer(state.photoLayer)) setTimeout(() => m.openPopup(), 800);
    } else if (kind === 'gallery') {
      flashCard(p.id);
    }
  }
}
function showTsPreview(p) {
  const el = $('#tsPreview');
  const mp = mileForPhoto(p);
  hideHoverZoom();
  el.hidden = false;
  const img = el.querySelector('img') || (el.innerHTML = '<img alt=""><div class="tp-meta"><span class="tp-date"></span><span class="tp-sub"></span><span class="tp-mile"></span></div>', el.querySelector('img'));
  img.src = `thumbs/1600/${encodeURIComponent(p.id)}`;
  img.alt = p.date || p.id;
  el.querySelector('.tp-date').textContent = fmtDate(p.date);
  el.querySelector('.tp-sub').textContent = p.summary || (mp ? (mp.fixed ? 'pinned by you' : 'auto-placed by date') : 'no camera info');
  el.querySelector('.tp-mile').textContent = mp ? `~ mile ${fmtMi(mp.mile)}` : 'no mile yet';
  el.onclick = () => { hideTsPreview(); openDetail(p.id); };
}
function hideTsPreview() { const el = $('#tsPreview'); if (el) el.hidden = true; }

/* ---------- hover-enlarge ---------- */
function showHoverZoom(p, isScreen) {
  if (window.innerWidth <= 900) return;
  const el = $('#hoverZoom');
  const mp = isScreen ? null : mileForPhoto(p);
  el.hidden = false;
  el.innerHTML = `
    <img loading="lazy" src="thumbs/1600/${encodeURIComponent(p.id)}" alt="">
    <div class="hz-meta">
      <span class="hz-date">${fmtDate(p.date)}</span>
      <span class="hz-sub">${esc(p.summary || p.id)}</span>
      ${mp ? `<span class="hz-mile">~ mile ${fmtMi(mp.mile)}${mp.fixed ? ' · pinned' : ''}</span>` : ''}
    </div>`;
  el.onclick = () => { hideHoverZoom(); openDetail(p.id, !!isScreen); };
}
function hideHoverZoom() { const el = $('#hoverZoom'); if (el) el.hidden = true; }

/* ---------- flash/scroll a gallery card ---------- */
function flashCard(id) {
  const card = document.querySelector(`#galleryGrid .card[data-photo="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1600);
}
