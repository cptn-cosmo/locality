// Locality frontend — vanilla JS, Leaflet for the map.

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 10 * 60_000;

/** Tiny DOM helper; children strings become text nodes (never HTML). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function relTime(iso) {
  if (!iso) return '';
  const diff = (new Date(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, s] of units) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
  return 'just now';
}
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '';

// ------------------------------------------------------------------ state

const state = {
  locations: [],
  current: null,
  data: null,
  rwFilter: store.get('rwFilter', 'now'),
  policeLocal: store.get('policeLocal', true),
  newsLocal: store.get('newsLocal', true),
  loading: false,
};

// ------------------------------------------------------------------ map

const KIND_COLOR = { closure: '#dc2626', incident: '#ea580c', roadworks: '#d97706' };
const KIND_LABEL = { closure: 'Closure', incident: 'Incident', roadworks: 'Roadworks' };

const map = L.map('map', { scrollWheelZoom: false });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);
let radiusCircle = null;
const markers = new Map();

function popupFor(item) {
  const el = h('div', {},
    h('b', {}, item.title || KIND_LABEL[item.kind]),
    item.subtitle && h('div', {}, item.subtitle),
    h('div', { style: 'margin-top:4px;white-space:pre-line;max-height:160px;overflow:auto' }, item.description || ''),
    h('div', { class: 'muted', style: 'margin-top:4px' }, item.source),
  );
  return el;
}

function drawMap(loc, items) {
  layer.clearLayers();
  markers.clear();
  if (radiusCircle) radiusCircle.remove();
  radiusCircle = L.circle([loc.lat, loc.lon], {
    radius: loc.radiusKm * 1000, color: '#2563eb', weight: 1, fillOpacity: 0.03, dashArray: '4 6', interactive: false,
  }).addTo(map);
  L.circleMarker([loc.lat, loc.lon], { radius: 5, color: '#2563eb', fillOpacity: 1 }).addTo(layer).bindTooltip(loc.name);

  for (const item of items) {
    if (!item.geometry) continue;
    const color = item.future ? '#6b7280' : KIND_COLOR[item.kind];
    const gj = L.geoJSON(item.geometry, {
      style: { color, weight: 5, opacity: 0.85, dashArray: item.future ? '6 6' : null },
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, {
        radius: 7, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.95,
      }),
    }).bindPopup(() => popupFor(item), { maxWidth: 320 });
    gj.addTo(layer);
    markers.set(item.id, gj);
  }
  map.fitBounds(radiusCircle.getBounds(), { padding: [10, 10] });
}

function focusItem(item) {
  const m = markers.get(item.id);
  if (!m) return;
  const b = m.getBounds();
  if (b.isValid()) map.fitBounds(b, { maxZoom: 15, padding: [40, 40] });
  m.openPopup();
  $('map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ------------------------------------------------------------------ renderers

const WEATHER_ICON = {
  'clear-day': '☀️', 'clear-night': '🌙', 'partly-cloudy-day': '⛅', 'partly-cloudy-night': '☁️',
  cloudy: '☁️', fog: '🌫️', wind: '💨', rain: '🌧️', sleet: '🌨️', snow: '❄️', hail: '🌨️', thunderstorm: '⛈️',
};
const CONDITION = { dry: 'Dry', fog: 'Fog', rain: 'Rain', sleet: 'Sleet', snow: 'Snow', hail: 'Hail', thunderstorm: 'Thunderstorm' };

function renderWeather(w) {
  const el = $('weather');
  el.replaceChildren();
  if (!w?.ok) { el.append(h('span', { class: 'muted small' }, 'Weather unavailable')); return; }
  const round = (x) => (x == null ? '–' : Math.round(x));
  el.append(
    h('span', { class: 'icon' }, WEATHER_ICON[w.icon] || '🌡️'),
    h('span', { class: 'temp' }, `${w.temperature == null ? '–' : w.temperature.toFixed(1)}°C`),
    h('div', { class: 'meta' },
      h('div', {}, `${CONDITION[w.condition] || w.condition || ''} · Wind ${round(w.windSpeed)} km/h${w.windGust ? `, gusts ${round(w.windGust)}` : ''}`),
      h('div', {}, `Humidity ${round(w.humidity)}% · ${w.station || ''}`),
    ),
  );
}

function renderWarnings(sec) {
  const el = $('warnings');
  el.replaceChildren();
  if (!sec?.ok) {
    el.append(h('div', { class: 'warning' }, h('span', { class: 'error' }, `Warnings unavailable: ${sec?.error || 'unknown error'}`)));
    return;
  }
  if (!sec.items.length) {
    el.append(h('div', { class: 'warning ok' },
      h('strong', {}, '✓ No active official warnings'),
      h('span', { class: 'muted small' }, ` · NINA (civil protection, police, floods) and DWD weather${sec.cell ? ` for ${sec.cell}` : ''}`)));
  }
  for (const w of sec.items) {
    el.append(h('details', { class: `warning ${w.severity}` },
      h('summary', {},
        h('span', { class: `badge ${w.severity}` }, w.severity),
        h('h3', {}, w.title),
        h('span', { class: 'muted small' }, [w.provider, w.expires && `until ${fmtDate(w.expires)}`].filter(Boolean).join(' · ')),
      ),
      w.description && h('p', {}, w.description),
      w.instruction && h('p', {}, h('strong', {}, 'What to do: '), w.instruction),
      h('p', { class: 'small' }, h('a', { href: w.link, target: '_blank', rel: 'noopener' }, `Source: ${w.source} ↗`)),
    ));
  }
  for (const e of sec.errors || []) el.append(h('div', { class: 'error small' }, `Partial outage — ${e}`));
}

function renderRoadworks(sec, loc) {
  const filters = $('rw-filters');
  const list = $('roadworks');
  filters.replaceChildren();
  list.replaceChildren();
  if (!sec?.ok) {
    list.append(h('li', { class: 'error' }, `Roadworks unavailable: ${sec?.error}`));
    drawMap(loc, []);
    return;
  }
  const all = sec.items;
  const defs = [
    ['now', 'Current', (i) => !i.future],
    ['closure', 'Closures', (i) => !i.future && (i.kind === 'closure' || i.blocked)],
    ['future', 'Upcoming', (i) => i.future],
    ['all', 'All', () => true],
  ];
  for (const [key, label, fn] of defs) {
    filters.append(h('button', {
      class: 'chip', 'aria-pressed': String(state.rwFilter === key),
      onclick: () => { state.rwFilter = key; store.set('rwFilter', key); renderRoadworks(sec, loc); },
    }, `${label} (${all.filter(fn).length})`));
  }
  const items = all.filter(defs.find((d) => d[0] === state.rwFilter)?.[3] || (() => true));
  drawMap(loc, items);
  if (!items.length) list.append(h('li', { class: 'empty' }, 'Nothing reported in this category.'));
  for (const it of items) {
    list.append(h('li', { class: 'rw', onclick: (e) => { if (e.target.tagName !== 'SUMMARY') focusItem(it); } },
      h('div', { class: 'meta' },
        h('span', { class: `badge ${it.kind}` }, KIND_LABEL[it.kind]),
        it.blocked && h('span', { class: 'badge closure' }, 'blocked'),
        it.future && h('span', { class: 'badge future' }, it.start ? `from ${fmtDate(it.start)}` : 'upcoming'),
        h('span', {}, `${it.distanceKm} km`),
        h('span', {}, it.source),
      ),
      h('span', { class: 'title' }, it.title),
      it.subtitle && h('div', { class: 'small muted' }, it.subtitle),
      it.description && h('details', {},
        h('summary', { class: 'small', style: 'color:var(--accent)' }, 'Details'),
        h('p', { class: 'summary' }, it.description)),
    ));
  }
  for (const e of sec.errors || []) list.append(h('li', { class: 'error' }, `Partial outage — ${e}`));
}

function renderFeed(listId, sec, localOnly, setLocal) {
  const list = $(listId);
  list.replaceChildren();
  if (!sec?.ok) { list.append(h('li', { class: 'error' }, `Unavailable: ${sec?.error}`)); return; }
  const localCount = sec.items.filter((i) => i.local).length;
  let items = localOnly ? sec.items.filter((i) => i.local) : sec.items;
  if (localOnly && !items.length && sec.items.length) {
    list.append(h('li', { class: 'notice' }, 'No items mentioning this area right now. ',
      h('button', { onclick: () => setLocal(false) }, `Show all ${sec.items.length} regional items`)));
    return;
  }
  if (!items.length) list.append(h('li', { class: 'empty' }, 'No items.'));
  const showLocalBadge = !localOnly && localCount < sec.items.length;
  for (const it of items) {
    list.append(h('li', {},
      h('div', { class: 'meta' },
        showLocalBadge && it.local && h('span', { class: 'badge local' }, 'local'),
        h('span', {}, it.source),
        it.date && h('span', { title: fmtDate(it.date) }, relTime(it.date)),
      ),
      h('a', { class: 'title', href: it.link, target: '_blank', rel: 'noopener' }, it.title),
      it.summary && h('p', { class: 'summary' }, it.summary),
    ));
  }
  for (const e of sec.errors || []) list.append(h('li', { class: 'error' }, `Partial outage — ${e}`));
}

const POLLEN_DE = {
  Hasel: 'Hazel', Erle: 'Alder', Esche: 'Ash', Birke: 'Birch', Graeser: 'Grass', Roggen: 'Rye', Beifuss: 'Mugwort', Ambrosia: 'Ragweed',
};
function renderPollen(sec) {
  const el = $('pollen');
  el.replaceChildren();
  $('pollen-region').textContent = sec?.ok ? sec.region : '';
  if (!sec?.ok) { el.append(h('div', { class: 'error' }, `Unavailable: ${sec?.error}`)); return; }
  const active = sec.types.filter((t) => (t.today || 0) + (t.tomorrow || 0) + (t.dayAfter || 0) > 0);
  if (!active.length) { el.append(h('div', { class: 'notice' }, 'No pollen load expected for the next days.')); return; }
  const grid = h('div', { class: 'pollen' }, h('span'), h('span', { class: 'h' }, 'Today'), h('span', { class: 'h' }, 'Tomorrow'), h('span', { class: 'h' }, 'Day after'));
  for (const t of active) {
    grid.append(h('span', {}, POLLEN_DE[t.name] || t.name));
    for (const v of [t.today, t.tomorrow, t.dayAfter]) {
      grid.append(h('div', { class: 'bar', title: v == null ? 'n/a' : `${v} / 3` }, h('span', { style: `width:${((v || 0) / 3) * 100}%` })));
    }
  }
  el.append(grid);
}

function render() {
  const loc = state.current;
  const d = state.data;
  $('loc-name').textContent = loc.name;
  $('loc-sub').textContent = loc.subtitle;
  document.title = `${loc.name} · Locality`;
  for (const b of $('tabs').children) b.setAttribute('aria-current', String(b.dataset.id === loc.id));
  if (!d) return;
  $('updated').textContent = `Updated ${new Date(d.fetchedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  renderWeather(d.weather);
  renderWarnings(d.warnings);
  renderRoadworks(d.roadworks, loc);
  renderFeed('police', d.police, state.policeLocal, (v) => { $('police-local').checked = v; setPref('policeLocal', v); });
  renderFeed('news', d.news, state.newsLocal, (v) => { $('news-local').checked = v; setPref('newsLocal', v); });
  renderPollen(d.pollen);
}

function setPref(key, v) {
  state[key] = v;
  store.set(key, v);
  render();
}

function showLoading() {
  for (const id of ['roadworks', 'police', 'news']) $(id).replaceChildren(h('li', { class: 'skeleton' }, 'Loading…'));
  $('warnings').replaceChildren(h('div', { class: 'warning skeleton' }, 'Checking official warnings…'));
  $('weather').replaceChildren();
  $('pollen').replaceChildren();
}

// ------------------------------------------------------------------ loading

let loadSeq = 0;
async function load(showSkeleton = true) {
  const seq = ++loadSeq;
  const loc = state.current;
  state.loading = true;
  $('refresh').classList.add('spinning');
  if (showSkeleton) { state.data = null; render(); showLoading(); }
  try {
    const res = await fetch(`/api/location/${loc.id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== loadSeq) return; // a newer request superseded this one
    state.data = data;
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    $('warnings').replaceChildren(h('div', { class: 'warning severe' }, `Could not reach the Locality server: ${err.message}`));
  } finally {
    if (seq === loadSeq) { state.loading = false; $('refresh').classList.remove('spinning'); }
  }
}

function selectLocation(id) {
  const loc = state.locations.find((l) => l.id === id) || state.locations[0];
  state.current = loc;
  store.set('location', loc.id);
  if (location.hash !== `#${loc.id}`) history.replaceState(null, '', `#${loc.id}`);
  map.setView([loc.lat, loc.lon], 11);
  load();
}

async function init() {
  $('police-local').checked = state.policeLocal;
  $('news-local').checked = state.newsLocal;
  $('police-local').addEventListener('change', (e) => setPref('policeLocal', e.target.checked));
  $('news-local').addEventListener('change', (e) => setPref('newsLocal', e.target.checked));
  $('refresh').addEventListener('click', () => load(false));

  state.locations = await (await fetch('/api/locations')).json();
  $('tabs').replaceChildren(...state.locations.map((l) =>
    h('button', { class: 'tab', 'data-id': l.id, onclick: () => selectLocation(l.id) }, l.name)));

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && id !== state.current?.id) selectLocation(id);
  });
  selectLocation(location.hash.slice(1) || store.get('location', state.locations[0].id));
  setInterval(() => { if (!document.hidden) load(false); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.data && Date.now() - new Date(state.data.fetchedAt) > REFRESH_MS) load(false);
  });
}

init().catch((err) => {
  $('warnings').replaceChildren(h('div', { class: 'warning severe' }, `Failed to start: ${err.message}`));
});
