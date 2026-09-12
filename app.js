/* AT · Show & Tell — Appalachian Trail photo map (a Pic2Map-style EXIF viewer for a GPS-less thru-hike). */
'use strict';

const STORE_KEY = 'at-photo-journal-v1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const qattr = (s) => JSON.stringify(String(s)).replace(/"/g, '&quot;');
/** Bind an event only if the element exists — missing/mismatched markup must never break boot. */
function on(sel, ev, fn) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) { console.warn('[at] no element for ' + sel + ' (skipped ' + ev + ')'); return null; }
  el.addEventListener(ev, fn);
  return el;
}
/** Run a boot step without letting it take the whole app down. */
function safe(label, fn) {
  try { return fn(); } catch (e) { console.error('[at] ' + label + ' failed: ' + (e && e.message)); return null; }
}

/* thumbnails live in per-state folders: thumbs/<size>/<State folder>/<file> */
const SCREEN_THUMB_FOLDER = '_screenshots';
const UNPLACED_THUMB_FOLDER = '_unplaced';
const safeFolderName = (s) => String(s).replace(/&/g, 'and').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
function thumbFolderOf(rec) {
  if (!rec) return UNPLACED_THUMB_FOLDER;
  if (rec.kind === 'screenshot') return SCREEN_THUMB_FOLDER;
  if (rec.folder) return rec.folder;
  const mp = mileForPhoto(rec);
  return mp ? safeFolderName(stateNameOf(mp.mile)) : UNPLACED_THUMB_FOLDER;
}
/** thumbUrl(photoRecord, 480|1600) or thumbUrl('file.jpg', size) for lookups by id */
function thumbUrl(recOrId, size) {
  let rec = recOrId;
  if (typeof recOrId === 'string') rec = (state.photoById && state.photoById[recOrId]) || (state.screenById && state.screenById[recOrId]) || null;
  const folder = thumbFolderOf(rec);
  const id = typeof recOrId === 'string' ? recOrId : recOrId.id;
  return `thumbs/${size}/${encodeURIComponent(folder)}/${encodeURIComponent(id)}`;
}

const state = {
  photos: [], screenshots: [], route: null,
  hike: null,
  checkins: [], overrides: {}, comments: {},
  photoLayer: null, checkinLayer: null, trail: null, map: null, draftLatLng: null,
  checkinBeingEdited: null, modalPhotoSelection: new Set(),
  view: 'map', stateCuts: [], photoMarkerById: {}, scrubMarker: null,
  camps: [], campLogTotal: 2197.4, campLayer: null,
  photoById: {}, screenById: {},
};

/* ---------------- persistence ---------------- */
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      hike: state.hike,
      checkins: state.checkins,
      overrides: state.overrides,
      comments: state.comments,
    }));
  } catch (e) { console.warn('save failed', e); }
}
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
/* comments replace the old single "caption" field */
function commentsFor(id) { const c = state.comments[id]; return Array.isArray(c) ? c : []; }
function commentText(id) { return commentsFor(id).map((c) => c.t).join(' · '); }
function addComment(id, text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!Array.isArray(state.comments[id])) state.comments[id] = [];
  state.comments[id].push({ t, at: new Date().toISOString() });
  save(); return true;
}
function removeComment(id, idx) {
  const list = state.comments[id];
  if (!Array.isArray(list)) return;
  list.splice(idx, 1);
  if (!list.length) delete state.comments[id];
  save();
}
function commentsHTML(id) {
  const list = commentsFor(id);
  if (!list.length) return '<li class="cmt-empty">No comments yet — say something.</li>';
  return list.map((c, i) => `<li class="cmt">
      <p class="cmt-text">${esc(c.t)}</p>
      <div class="cmt-meta"><span>${c.at ? fmtDate(c.at) : ''}</span><button class="cmt-del" onclick="deleteComment(${qattr(id)},${i})">remove</button></div>
    </li>`).join('');
}
function deleteComment(id, idx) {
  removeComment(id, idx);
  const ul = document.querySelector('#dtComments');
  if (ul) ul.innerHTML = commentsHTML(id);
  renderGallery(); renderTrailMarkers();
  toast('Comment removed');
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
    const [ph, rt, cp] = await Promise.all([
      fetch('data/photos.json').then((r) => r.json()),
      fetch('data/at-route.json').then((r) => r.json()),
      fetch('data/camps.json').then((r) => r.json()).catch(() => ({ camps: [] })),
    ]);
    state.photos = ph.photos; state.screenshots = ph.screenshots;
    state.route = decimate(rt);
    state.stateCuts = rt.stateCuts || DEFAULT_STATE_CUTS;
    state.camps = cp.camps || [];
    state.campLogTotal = cp.logTotal || 2197.4;
    state.photoById = {}; state.screenById = {};
    for (const p of state.photos) state.photoById[p.id] = p;
    for (const s of state.screenshots) state.screenById[s.id] = s;
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
    state.comments = (st && st.comments) || {};
    // migrate any old single-caption text into the new comment list
    if (st && st.captions && typeof st.captions === 'object') {
      let migrated = false;
      for (const [id, t] of Object.entries(st.captions)) {
        if (!t) continue;
        if (!Array.isArray(state.comments[id])) state.comments[id] = [];
        if (!state.comments[id].some((c) => c.t === t)) { state.comments[id].push({ t, at: null }); migrated = true; }
      }
      if (migrated) save();
    }

    // each step is isolated: one broken/missing element can no longer kill the whole page
    safe('initUI', initUI);
    safe('initMap', initMap);
    safe('initTimelineBars', initTimelineBars);
    safe('renderStats', renderStats);
    safe('renderCheckinList', renderCheckinList);
    safe('renderGallery', renderGallery);
    safe('renderScreens', renderScreens);
    state.view = 'map';
    if (!state.map) {
      const host = $('#view-map');
      if (host) host.innerHTML = '<div class="spinner-wrap"><div>Map failed to start — check the browser console for details.</div></div>';
    }
  } catch (e) {
    console.error(e);
    const host = $('#view-map');
    const msg = e && e.message ? esc(e.message) : 'unknown error';
    const hint = /fetch|Failed to load|NetworkError/i.test(String(e && e.message))
      ? 'The data files could not be fetched. On GitHub Pages, publish the <b>contents of the <code>site/</code> folder</b> as the site root (with <code>data/</code>, <code>thumbs/</code> and <code>vendor/</code> committed).<br>Locally, start it with <code>node server.js</code> in the photo-map-site folder.'
      : 'Open the browser console (F12) for the full stack trace.';
    if (host) host.innerHTML = `<div class="spinner-wrap"><div>Could not load data: ${msg}<br>${hint}</div></div>`;
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
  on('#btnRandom', 'click', () => { const p = state.photos[Math.floor(Math.random() * state.photos.length)]; openDetail(p.id); });
  on('#ciSave', 'click', saveCheckin);
  on('#ciDelete', 'click', () => deleteCheckin(state.checkinBeingEdited));
  safe('buildMonthOptions', buildMonthOptions);
  on('#galleryReset', 'click', resetGalleryFilters);
  on('#gallerySearch', 'input', renderGallery);
  on('#galleryMonth', 'change', renderGallery);
  on('#gallerySort', 'change', renderGallery);
  on('#galleryPlacedOnly', 'change', renderGallery);
  on('#screenSort', 'change', renderScreens);
  on('#btnFit', 'click', fitTrail);
  on('#btnTogglePhotos', 'click', togglePhotos);
  on('#btnToggleCamps', 'click', toggleCamps);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });
  $$('[data-close-drawer]').forEach((el) => el.addEventListener('click', closeDrawer));
  $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModal));
  // mobile rail opener / closer
  on('#btnListRail', 'click', toggleRail);
  on('#btnRailMobile', 'click', toggleRail);
  on('#btnRailClose', 'click', closeRail);
  initLegendToggle();
}
/* collapsible map legend (the little arrow closes the panel) */
const LEGEND_KEY = 'atj.legend.collapsed';
function applyLegendState(collapsed) {
  const l = $('#legend'), btn = $('#legendToggle');
  if (!l || !btn) return;
  l.classList.toggle('collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Expand the legend' : 'Collapse the legend';
}
function initLegendToggle() {
  const btn = $('#legendToggle');
  if (!btn) return;
  let stored = null;
  try { stored = localStorage.getItem(LEGEND_KEY); } catch (e) { /* private mode */ }
  applyLegendState(stored === null ? window.innerWidth <= 900 : stored === '1');
  btn.addEventListener('click', () => {
    const collapsed = !$('#legend').classList.contains('collapsed');
    applyLegendState(collapsed);
    try { localStorage.setItem(LEGEND_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
  });
}
function toggleRail() {
  const rail = $('#rail');
  if (!rail) return;
  if (window.innerWidth <= 900) {
    const open = rail.classList.toggle('open');
    document.body.classList.toggle('rail-open', open);
  } else {
    const hidden = document.body.classList.toggle('rail-hidden');
    const btn = $('#btnListRail');
    if (btn) btn.textContent = hidden ? '☰ Show check-ins' : '✕ Hide check-ins';
  }
}
function closeRail() {
  const rail = $('#rail');
  if (rail) rail.classList.remove('open');
  document.body.classList.remove('rail-open');
}
function switchView(name) {
  state.view = name;
  closeRail();
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
  // the legend lives inside the map container now — keep its clicks/scrolls off the map
  const legendEl = document.getElementById('legend');
  if (legendEl) { L.DomEvent.disableClickPropagation(legendEl); L.DomEvent.disableScrollPropagation(legendEl); }
  // the mobile "States" button must not bubble into the map click handler
  const fab = document.getElementById('btnRailMobile');
  if (fab) L.DomEvent.disableClickPropagation(fab);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
  });
  topo.addTo(map); // topographic is the default base layer
  L.control.layers({ 'Topographic': topo, 'Streets (OSM)': osm, 'Satellite': sat }, null, { position: 'topright' }).addTo(map);

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
    // on phones the rail is a sheet over the map: a tap anywhere on the map closes it
    if (window.innerWidth <= 900 && document.body.classList.contains('rail-open')) { closeRail(); return; }
    // ignore clicks on the legend, markers, popups and controls
    const t = ev.originalEvent && ev.originalEvent.target;
    if (t && t.closest && t.closest('#legend,#btnRailMobile,.leaflet-marker-icon,.leaflet-interactive,.leaflet-popup,.leaflet-control,.leaflet-bar,.mi-label')) return;
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
  // campfire nights from the caitlog — clustered, campfire-styled badges
  state.campLayer = L.markerClusterGroup({
    maxClusterRadius: 34, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
    iconCreateFunction: (cl) => L.divIcon({
      html: `<div class="cf-badge">${campfireSVG(12)}<span>${cl.getChildCount()}</span></div>`,
      className: '', iconSize: [34, 24],
    }),
  }).addTo(map);

  fitTrail();
  renderTrailMarkers();
  renderCamps();
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
  const cap = commentText(p.id);
  return `<div style="width:238px">
    <img class="lp-thumb" loading="lazy" src="${thumbUrl(p, 480)}" alt="">
    <p class="lp-name">${fmtDate(p.date)}</p>
    <p><span class="lp-mile">mile ${fmtMi(mp.mile)}</span> ${mp.fixed ? '· pinned' : mp.auto ? '· auto' : ''}${ci ? `<span class="chip">${esc(ci.name)}</span>` : ''}</p>
    ${p.summary ? `<p style="font-size:11.5px;color:var(--ink-soft)">${esc(p.summary)}</p>` : ''}
    ${cap ? `<p style="font-size:11.5px;font-style:italic">${esc(cap.slice(0, 90))}</p>` : ''}
    <div class="lp-actions"><button class="primary small" onclick="openDetail(${qattr(p.id)})">Open photo</button></div>
  </div>`;
}
function checkinPopup(c, n) {
  const thumbs = c.photoIds.slice(0, 4).map((id) => `<img src="${thumbUrl(id, 480)}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;margin:1px" alt="">`).join('');
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
  $('#modalTitle').textContent = c ? 'Edit check-in' : 'New check-in';
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
    el.innerHTML = `<img loading="lazy" src="${thumbUrl(p, 480)}" alt=""><span class="mile">~${fmtMi(mp && mp.mile)}</span><span class="pd">${fmtDate(p.date)}</span><span class="tk">&#10003;</span>`;
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
  if (!ul) return;
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
      const thumbs = c.photoIds.slice(0, 4).map((id) => `<img loading="lazy" src="${thumbUrl(id, 480)}" alt="">`).join('');
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
      <ul class="ci-list">${itemsHTML}</ul>`;
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
  // the rail's photo/check-in counters were removed — nothing to update
  const el = $('#statPhotos');
  if (!el) return;
  const placed = state.photos.filter((p) => mileForPhoto(p) != null).length;
  el.textContent = state.photos.length;
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
  const qEl = $('#gallerySearch'), mEl = $('#galleryMonth'), pEl = $('#galleryPlacedOnly'), sEl = $('#gallerySort');
  const q = (qEl && qEl.value ? qEl.value : '').trim().toLowerCase();
  const month = mEl ? mEl.value : '';
  const placedOnly = !!(pEl && pEl.checked);
  let arr = state.photos.filter((p) => {
    if (month && (!p.date || !p.date.startsWith(month))) return false;
    if (q) {
      const ci = checkinForPhoto(p.id);
      const hay = `${p.id} ${commentText(p.id)} ${ci ? ci.name + ' ' + ci.note : ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const mp = mileForPhoto(p);
    if (placedOnly && mp == null) return false;
    return true;
  });
  const sort = sEl ? sEl.value : 'dateAsc';
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
  const grid = $('#galleryGrid');
  if (!grid) return;
  const arr = galleryFiltered();
  grid.innerHTML = '';
  const emptyEl = $('#galleryEmpty');
  if (emptyEl) emptyEl.hidden = arr.length > 0;
  for (const p of arr) {
    const mp = mileForPhoto(p);
    const ci = checkinForPhoto(p.id);
    const cap = commentText(p.id);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<figure><img loading="lazy" src="${thumbUrl(p, 480)}" alt="${esc(p.date || p.id)}"></figure>
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
function resetGalleryFilters() {
  ['#gallerySearch', '#galleryMonth', '#galleryPlacedOnly'].forEach((s) => {
    const el = $(s);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = false; else el.value = '';
  });
  renderGallery();
}

/* ---------------- screenshots ---------------- */
function renderScreens() {
  const grid = $('#screenGrid');
  if (!grid) return;
  const sEl = $('#screenSort');
  const sort = sEl ? sEl.value : 'dateAsc';
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
    card.innerHTML = `<figure><img loading="lazy" src="${thumbUrl(s, 480)}" alt=""></figure>
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
  const cap = commentText(p.id);
  const exifPanel = (title, rows) => rows.length ? `<div class="panel"><h3>${title}</h3><dl>${rows.map(([k, v]) => v == null || v === '' ? '' : `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>` : '';
  const placementHTML = isScreen ? '' : `
    <div class="panel">
      <h3>Trail placement</h3>
      <div class="placement">
        <div class="mile-big">${mp ? fmtMi(mp.mile) : '—'} <span style="font-size:13px;color:var(--ink-soft)">mi</span></div>
        <div class="mile-est">${mp ? (mp.fixed ? 'Pinned mile.' : `Auto-estimated from ${fmtDate(p.date)} (linear date pace${state.checkins.some((c) => c.anchor) ? ', bent by your calibration anchors' : ''}).`) : 'No mile for this photo.'}</div>
        ${ci ? `<div><span class="chip">In check-in “${esc(ci.name)}”</span> <button class="link" onclick="detachFromCheckin('${p.id}')">remove</button></div>` : ''}
        ${ci ? '' : `<div><button class="ghost small" id="dtCheckin">Make a check-in here…</button></div>`}
        <p class="trail-note">Guide miles: 0 = Springer, ${fmtMi(state.hike.totalMiles)} ≈ Katahdin. Photos are placed automatically from their date.</p>
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
  <div class="drawer-random"><button class="primary" id="dtRandom">&#127922; Random photo</button></div>
  <div class="detail">
    <div class="photo-side">
      <img class="ph" src="${thumbUrl(p, 1600)}" alt="">
    </div>
    <div class="info-side">
      <h2>${isScreen ? 'Screenshot' : fmtDate(p.date)}</h2>
      <div class="sub">${p.summary ? esc(p.summary) : (p.make || 'no camera info')}${mp ? ` · ~ mile ${fmtMi(mp.mile)}` : ''}</div>
      ${placementHTML}
      <div class="panel"><h3>Comments</h3>
        <ul class="cmt-list" id="dtComments">${commentsHTML(p.id)}</ul>
        <div class="cmt-add">
          <textarea id="dtCommentBox" rows="2" placeholder="Leave a comment…"></textarea>
          <button class="primary small" id="dtAddComment">Add comment</button>
        </div>
      </div>
      ${exifPanel('Camera', cameraRows)}
      ${exifPanel('Exposure', exRows)}
      ${exifPanel('File &amp; date', fileRows)}
      ${isScreen ? '' : '<p class="trail-note">Like Pic2Map, this panel shows the EXIF data embedded by the phone. The GPS block is missing because location data was stripped from these files — that is why placement is by trail mile instead of coordinates.</p>'}
    </div>
  </div>`;
  const mk = $('#dtCheckin');
  if (mk) mk.addEventListener('click', () => { closeDrawer(); const m = mileForPhoto(p); openCheckinEditor(null, m ? m.mile : 0); if (m) $('#ciDate').value = p.date ? p.date.slice(0, 10) : ''; state.modalPhotoSelection.add(p.id); updateCiCounter(); $$('#ciPhotoGrid .pick').forEach((el) => el.classList.toggle('sel', state.modalPhotoSelection.has(el.dataset.id))); });
  const addBtn = $('#dtAddComment');
  const box = $('#dtCommentBox');
  if (addBtn && box) {
    const commit = () => {
      if (!addComment(p.id, box.value)) { toast('Write something first'); return; }
      box.value = '';
      $('#dtComments').innerHTML = commentsHTML(p.id);
      renderGallery(); renderTrailMarkers();
      toast('Comment added');
    };
    addBtn.addEventListener('click', commit);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); });
  }
  const rnd = $('#dtRandom');
  if (rnd) rnd.addEventListener('click', () => {
    let next = p;
    if (state.photos.length > 1) { while (next.id === p.id) next = state.photos[Math.floor(Math.random() * state.photos.length)]; }
    openDetail(next.id);
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
  'Georgia': 'Where every thru-hike starts: 78 miles of pure optimism, Blood Mountain’s staircase, and the last time your pack will feel light.',
  'North Carolina & Tennessee': 'Nearly four hundred miles of state-line hopscotch — the Smokies, Clingmans Dome, and balds that make you whisper “wait, this is the South?”',
  'Virginia': 'The long haul: the Triple Crown of views, all of Shenandoah, and enough ridgeline miles to make you question your hobbies.',
  'West Virginia': 'Four glorious miles wrapped around Harpers Ferry — the ATC HQ, the psychological halfway, and the best shower of your life.',
  'Maryland': '41 miles of “the friendliest state,” gently rolling and suspiciously easy. Enjoy it — Pennsylvania is loading.',
  'Pennsylvania': 'Rocksylvania: where boots go to die and the half-gallon at Pine Grove Furnace is the only medically approved coping mechanism.',
  'New Jersey': 'The Garden State’s party trick: glacial ponds, sneaky ridge views, and bears who have clearly read the hiker handbook.',
  'New York': '88 miles of rock, ridge and one dramatic river crossing at Bear Mountain — the trail’s lowest point and highest drama.',
  'Connecticut': 'Fifty-odd miles of gentle woods and small towns: the trail’s coffee break, with better snacks.',
  'Massachusetts': 'Ninety miles up Greylock and past the Cookie Lady, where “just one more” becomes an actual nutrition strategy.',
  'Vermont': 'One hundred fifty miles of Green Mountain charm and mud, sharing the path with the Long Trail and mosquitos with strong opinions.',
  'New Hampshire': 'The boss level: Franconia Ridge, the Presidentials, Mt. Washington, and 161 miles that will absolutely humble you.',
  'Maine': 'The last 280 — the 100-Mile Wilderness, Saddleback, the Bigelows, and Katahdin’s sign. Bring tissues and a large pizza.',
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
  img.src = thumbUrl(p, 1600);
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
    <img loading="lazy" src="${thumbUrl(p, 1600)}" alt="">
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

/* ================= campfire nights (from EXTRA INFO/caitlog.txt) ================= */
function campfireSVG(px = 16) {
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true">
    <path d="M12 2.6c2.6 3.3 4.2 5.3 4.2 7.7a4.2 4.2 0 0 1-8.4 0c0-2.4 1.6-4.4 4.2-7.7z" fill="#e8801f"/>
    <path d="M12 7.4c1.3 1.7 2.1 2.8 2.1 3.9a2.1 2.1 0 1 1-4.2 0c0-1.1.8-2.2 2.1-3.9z" fill="#ffd765"/>
    <path d="M6.4 16.9l11.2 3.3M17.6 16.9L6.4 20.2" stroke="#8a4d1d" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`;
}

/** Campfire position in the map's current mile domain (follows your Settings length). */
function campMile(c) {
  const total = Number(state.hike.totalMiles) || 2190.4;
  const m = Number(c.logCum) * (total / state.campLogTotal);
  return Math.min(Math.max(m, 0), total);
}

function campPopup(c) {
  const st = c.state ? `<span class="chip">${esc(stateFullName(c.state))}</span>` : '';
  return `<div style="width:236px">
    <p class="cf-head">${campfireSVG(15)}<span>Night ${c.day}</span></p>
    <p class="lp-name">${esc(c.name)}</p>
    <p><span class="lp-mile">mile ${fmtMi(campMile(c))}</span> ${st}</p>
    <p class="lp-date">${c.dayMiles ? `${fmtMi(c.dayMiles)} mi hiked that day` : 'no miles logged'}${c.exact ? '' : ' · mile estimated from the day chain'}</p>
    <p class="cf-src">campfire night from <b>caitlog.txt</b>${c.notes && c.notes.length ? ` · ${esc(c.notes.join(', '))}` : ''}</p>
  </div>`;
}

function stateFullName(abbr) {
  const map = { GA: 'Georgia', NC: 'North Carolina', TN: 'Tennessee', VA: 'Virginia', WV: 'West Virginia', MD: 'Maryland', PA: 'Pennsylvania', NJ: 'New Jersey', NY: 'New York', CT: 'Connecticut', MA: 'Massachusetts', VT: 'Vermont', NH: 'New Hampshire', ME: 'Maine' };
  return map[abbr] || abbr;
}

function renderCamps() {
  if (!state.campLayer) return;
  state.campLayer.clearLayers();
  let n = 0;
  for (const c of state.camps) {
    if (c.logCum == null) continue;
    const mk = L.marker(miToLatLng(campMile(c)), {
      icon: L.divIcon({ className: '', html: `<div class="campfire" title="Night ${c.day} — ${esc(c.name)}">${campfireSVG(36)}</div>`, iconSize: [40, 40], iconAnchor: [20, 28] }),
      riseOnHover: true, zIndexOffset: 250,
    });
    mk.bindPopup(campPopup(c), { maxWidth: 270 });
    mk.addTo(state.campLayer);
    n++;
  }
  const el = $('#campCount');
  if (el) el.textContent = n;
}

function toggleCamps() {
  if (!state.map || !state.campLayer) return;
  const btn = $('#btnToggleCamps');
  if (state.map.hasLayer(state.campLayer)) { state.map.removeLayer(state.campLayer); if (btn) btn.textContent = 'Show campfires'; }
  else { state.map.addLayer(state.campLayer); if (btn) btn.textContent = 'Hide campfires'; }
}
