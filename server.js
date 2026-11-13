// Locality — local news, warnings and roadworks from official/free sources.
// Zero dependencies: `node server.js` (Node 18+).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCATIONS } from './config.js';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const UA = 'locality/1.0 (personal local-news dashboard)';

// ---------------------------------------------------------------- fetching

const cache = new Map(); // url -> { t, value } | { promise }

async function fetchRaw(url, { ttl = 5 * 60_000, timeout = 20_000 } = {}) {
  const hit = cache.get(url);
  if (hit?.value !== undefined && Date.now() - hit.t < ttl) return hit.value;
  if (hit?.promise) return hit.promise;

  const promise = (async () => {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const value = decode(buf, res.headers.get('content-type'));
    cache.set(url, { t: Date.now(), value });
    return value;
  })();

  cache.set(url, { ...hit, promise });
  try {
    return await promise;
  } catch (err) {
    // Serve stale data on failure if we have any.
    if (hit?.value !== undefined) { cache.set(url, hit); return hit.value; }
    cache.delete(url);
    throw err;
  }
}

function decode(buf, contentType = '') {
  let charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 200));
    charset = /encoding=["']([\w-]+)["']/i.exec(head)?.[1] || 'utf-8';
  }
  try { return new TextDecoder(charset).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

const fetchJson = async (url, opts) => JSON.parse(await fetchRaw(url, opts));

// ---------------------------------------------------------------- helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function cleanText(s = '') {
  return decodeEntities(
    s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m) => decodeEntities(m)) // double-encoded feeds
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' …' : s);

function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1] : '';
}

function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const link = cleanText(tag(b, 'link')) || /<link[^>]*href="([^"]+)"/i.exec(b)?.[1] || '';
    const date = cleanText(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'updated') || tag(b, 'published'));
    const d = date ? new Date(date) : null;
    return {
      title: cleanText(tag(b, 'title')),
      link: decodeEntities(link),
      summary: truncate(cleanText(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')), 420),
      date: d && !isNaN(d) ? d.toISOString() : null,
    };
  });
}

function matchesAny(text, keywords) {
  return keywords.some((k) =>
    k instanceof RegExp ? k.test(text) : text.toLowerCase().includes(k.toLowerCase()));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// All [lon, lat] positions of a GeoJSON geometry.
function positions(g) {
  if (!g) return [];
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'MultiPoint': case 'LineString': return g.coordinates;
    case 'MultiLineString': case 'Polygon': return g.coordinates.flat();
    case 'MultiPolygon': return g.coordinates.flat(2);
    case 'GeometryCollection': return g.geometries.flatMap(positions);
    default: return [];
  }
}

function minDistanceKm(loc, geometry) {
  let best = Infinity;
  for (const [lon, lat] of positions(geometry)) best = Math.min(best, haversineKm(loc.lat, loc.lon, lat, lon));
  return best;
}

// "dd.mm.yyyy HH:MM" (Europe/Berlin local time) -> Date
function parseGermanDate(s) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
}

// ---------------------------------------------------------------- sources

async function ninaWarnings(loc) {
  const list = await fetchJson(`https://warnung.bund.de/api31/dashboard/${loc.ars}.json`, { ttl: 2 * 60_000 });
  return Promise.all(list.map(async (w) => {
    const data = w.payload?.data || {};
    let description = '', instruction = '', expires = null;
    try {
      const detail = await fetchJson(`https://warnung.bund.de/api31/warnings/${encodeURIComponent(w.id)}.json`, { ttl: 10 * 60_000 });
      const info = detail.info?.find((i) => i.language?.startsWith('de')) || detail.info?.[0] || {};
      description = cleanText(info.description || '');
      instruction = cleanText(info.instruction || '');
      expires = info.expires || null;
    } catch { /* detail is optional */ }
    return {
      id: w.id,
      provider: data.provider || 'NINA',
      title: w.i18nTitle?.de || data.headline || 'Warnung',
      severity: (data.severity || 'Unknown').toLowerCase(),
      sent: w.sent || null,
      expires,
      description: truncate(description, 1200),
      instruction: truncate(instruction, 800),
      link: `https://warnung.bund.de/meldungen/${encodeURIComponent(w.id)}`,
      source: 'NINA (BBK)',
    };
  }));
}

async function dwdAlerts(loc) {
  const d = await fetchJson(`https://api.brightsky.dev/alerts?lat=${loc.lat}&lon=${loc.lon}`, { ttl: 5 * 60_000 });
  return {
    cell: d.location?.name || null,
    alerts: (d.alerts || []).map((a) => ({
      id: a.alert_id,
      provider: 'DWD',
      title: a.headline_de || a.event_de,
      severity: a.severity || 'unknown',
      sent: a.onset || a.effective,
      expires: a.expires,
      description: a.description_de || '',
      instruction: a.instruction_de || '',
      link: 'https://www.dwd.de/DE/wetter/warnungen_gemeinden/warnWetter_node.html',
      source: 'Deutscher Wetterdienst',
    })),
  };
}

async function warnings(loc) {
  const [nina, dwd] = await Promise.allSettled([ninaWarnings(loc), dwdAlerts(loc)]);
  const items = [];
  const errors = [];
  if (dwd.status === 'fulfilled') items.push(...dwd.value.alerts);
  else errors.push(`DWD: ${dwd.reason.message}`);
  if (nina.status === 'fulfilled') {
    // DWD warnings arrive via both NINA (district level) and Bright Sky (municipality
    // level, more precise). Prefer the latter when it's available.
    items.push(...nina.value.filter((w) => dwd.status !== 'fulfilled' || !/^dwd/i.test(w.provider + w.id)));
  } else errors.push(`NINA: ${nina.reason.message}`);
  if (!items.length && errors.length === 2) throw new Error(errors.join('; '));
  const rank = { extreme: 0, severe: 1, moderate: 2, minor: 3 };
  items.sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
  return { items, errors, cell: dwd.value?.cell };
}

async function weather(loc) {
  const q = loc.wmoStation ? `wmo_station_id=${loc.wmoStation}` : `lat=${loc.lat}&lon=${loc.lon}`;
  const d = await fetchJson(`https://api.brightsky.dev/current_weather?${q}`, { ttl: 10 * 60_000 });
  const w = d.weather || {};
  return {
    time: w.timestamp,
    temperature: w.temperature,
    condition: w.condition,
    icon: w.icon,
    windSpeed: w.wind_speed_10 ?? w.wind_speed_30 ?? w.wind_speed_60,
    windGust: w.wind_gust_speed_10 ?? w.wind_gust_speed_30 ?? w.wind_gust_speed_60,
    windDirection: w.wind_direction_10 ?? w.wind_direction_30 ?? w.wind_direction_60,
    humidity: w.relative_humidity,
    cloudCover: w.cloud_cover,
    precipitation: w.precipitation_60 ?? w.precipitation_30 ?? w.precipitation_10,
    station: d.sources?.[0]?.station_name || null,
    source: 'DWD via Bright Sky',
  };
}

const AUTOBAHN_SERVICES = ['roadworks', 'closure', 'warning'];

async function autobahnRoad(road, service) {
  const d = await fetchJson(`https://verkehr.autobahn.de/o/autobahn/${road}/services/${service}`, { ttl: 10 * 60_000 });
  return (d[service] || []).map((r) => ({ ...r, _road: road, _service: service }));
}

async function autobahnItems(loc) {
  const jobs = loc.autobahns.flatMap((road) => AUTOBAHN_SERVICES.map((s) => autobahnRoad(road, s)));
  const results = await Promise.allSettled(jobs);
  const seen = new Set();
  const items = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const x of r.value) {
      if (seen.has(x.identifier)) continue;
      seen.add(x.identifier);
      const geometry = x.geometry || (x.coordinate ? { type: 'Point', coordinates: [+x.coordinate.long, +x.coordinate.lat] } : null);
      const distanceKm = minDistanceKm(loc, geometry);
      if (!(distanceKm <= loc.radiusKm)) continue;
      const kind = x._service === 'closure' ? 'closure' : x._service === 'warning' ? 'incident' : 'roadworks';
      const desc = (x.description || []).filter(Boolean);
      items.push({
        id: x.identifier,
        kind,
        road: x._road,
        title: x.title?.trim(),
        subtitle: x.subtitle?.trim(),
        description: desc.join('\n'),
        blocked: x.isBlocked === 'true' || x.isBlocked === true,
        future: !!x.future,
        start: x.startTimestamp || null,
        geometry,
        distanceKm: Math.round(distanceKm * 10) / 10,
        source: 'Autobahn GmbH',
        link: 'https://www.autobahn.de/verkehr',
      });
    }
  }
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed === results.length && results.length) throw new Error('Autobahn API unreachable');
  return items;
}

async function vizItems(loc) {
  const d = await fetchJson('https://api.viz.berlin.de/daten/baustellen_sperrungen.json', { ttl: 10 * 60_000, timeout: 40_000 });
  const now = new Date();
  const items = [];
  for (const f of d.features || []) {
    const p = f.properties || {};
    const to = parseGermanDate(p.validity?.to);
    if (to && to < now) continue;
    const distanceKm = minDistanceKm(loc, f.geometry);
    if (!(distanceKm <= loc.radiusKm)) continue;
    const from = parseGermanDate(p.validity?.from);
    const sub = p.subtype || '';
    const kind = /Unfall|Gefahr|Störung/i.test(sub) ? 'incident'
      : /Sperrung/i.test(sub) && !/Fahrstreifen/i.test(sub) ? 'closure' : 'roadworks';
    items.push({
      id: `viz-${p.id}`,
      kind,
      road: null,
      title: p.street || sub,
      subtitle: [sub, p.severity, p.direction].filter(Boolean).join(' · '),
      description: [p.section, p.content, p.validity?.from && `Gültig: ${p.validity.from} – ${p.validity.to || 'offen'}`]
        .filter(Boolean).join('\n'),
      blocked: /Vollsperrung/i.test(p.severity || ''),
      future: from ? from > now : !!p.is_future,
      start: from?.toISOString() || null,
      end: to?.toISOString() || null,
      geometry: f.geometry,
      distanceKm: Math.round(distanceKm * 10) / 10,
      source: 'VIZ Berlin',
      link: 'https://viz.berlin.de/',
    });
  }
  return items;
}

async function roadworks(loc) {
  const jobs = [autobahnItems(loc)];
  if (loc.viz) jobs.push(vizItems(loc));
  const results = await Promise.allSettled(jobs);
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (errors.length === results.length) throw new Error(errors.join('; '));
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  items.sort((a, b) => (a.future - b.future) || (a.distanceKm - b.distanceKm));
  return { items, errors };
}

async function feeds(list) {
  const results = await Promise.allSettled(list.map(async (f) => {
    const items = parseFeed(await fetchRaw(f.url, { ttl: 10 * 60_000 }));
    return items.map((it) => ({
      ...it,
      source: f.name,
      // Feeds without keywords are already area-specific.
      local: f.local ? matchesAny(`${it.title}\n${it.summary}`, f.local) : true,
    }));
  }));
  const errors = results.map((r, i) => r.status === 'rejected' && `${list[i].name}: ${r.reason.message}`).filter(Boolean);
  if (errors.length === results.length && results.length) throw new Error(errors.join('; '));
  const seen = new Set();
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((it) => {
      const k = (it.link || it.title).replace(/^https?:\/\//, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 80);
  return { items, errors };
}

const POLLEN_LEVEL = { '0': 0, '0-1': 0.5, '1': 1, '1-2': 1.5, '2': 2, '2-3': 2.5, '3': 3 };

async function pollen(loc) {
  if (!loc.pollen) throw new Error('no pollen region configured');
  const d = await fetchJson('https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json', { ttl: 60 * 60_000 });
  const c = d.content.find((x) => x.region_id === loc.pollen.region && x.partregion_id === loc.pollen.part)
    || d.content.find((x) => x.region_id === loc.pollen.region);
  if (!c) throw new Error('region not found');
  return {
    region: [c.region_name, c.partregion_name].filter(Boolean).join(' · '),
    updated: d.last_update,
    types: Object.entries(c.Pollen).map(([name, v]) => ({
      name,
      today: POLLEN_LEVEL[v.today] ?? null,
      tomorrow: POLLEN_LEVEL[v.tomorrow] ?? null,
      dayAfter: POLLEN_LEVEL[v.dayafter_to] ?? null,
    })),
    source: 'Deutscher Wetterdienst',
  };
}

// Public transport via Transitous (MOTIS): Europe-wide GTFS incl. DELFI (all of Germany)
// with realtime. Free, no key; https://transitous.org/api/ asks for a sensible UA and caching.

const TRANSITOUS = 'https://api.transitous.org/api';
const STOP_ID = /^[a-z]{2}-[\w-]+_\S+$/;
const BOARD_SIZE = 60;
const BOARD_WINDOW_MS = 2 * 60 * 60_000;

async function resolveStop(loc, station) {
  if (STOP_ID.test(station.query)) return { id: station.query, name: null };
  const q = new URLSearchParams({ text: station.query, type: 'STOP', place: `${loc.lat},${loc.lon}` });
  const results = await fetchJson(`${TRANSITOUS}/v1/geocode?${q}`, { ttl: 24 * 60 * 60_000 });
  // Results are ranked with a bias towards the location's centre, but fuzzy matching can
  // still return stops abroad: keep only nearby stops with scheduled service.
  const maxKm = Math.max(loc.radiusKm * 2, 30);
  const best = results.find((r) => r.type === 'STOP' && r.modes?.length
    && haversineKm(loc.lat, loc.lon, r.lat, r.lon) <= maxKm);
  if (!best) throw new Error(`no stop matching "${station.query}" within ${maxKm} km`);
  return { id: best.id, name: best.name };
}

const minutesBetween = (a, b) => (a && b ? Math.round((new Date(a) - new Date(b)) / 60_000) : null);

async function departureBoard(loc, station) {
  const stop = await resolveStop(loc, station);
  const q = new URLSearchParams({ stopId: stop.id, n: BOARD_SIZE });
  const d = await fetchJson(`${TRANSITOUS}/v5/stoptimes?${q}`, { ttl: 60_000 });
  const until = Date.now() + BOARD_WINDOW_MS;
  const departures = (d.stopTimes || [])
    .filter((st) => st.place?.departure && st.place.pickupType !== 'NOT_ALLOWED')
    .map((st) => {
      const p = st.place;
      return {
        line: st.displayName || st.routeShortName || st.tripShortName || '',
        mode: st.mode,
        color: st.routeColor ? `#${st.routeColor}` : null,
        textColor: st.routeTextColor ? `#${st.routeTextColor}` : null,
        headsign: st.headsign || st.tripTo?.name || '',
        scheduled: p.scheduledDeparture || p.departure,
        expected: p.departure,
        delay: st.realTime ? minutesBetween(p.departure, p.scheduledDeparture) : null,
        realtime: !!st.realTime,
        cancelled: !!(st.cancelled || st.tripCancelled || p.cancelled),
        track: p.track || p.scheduledTrack || null,
        trackChanged: !!(p.track && p.scheduledTrack && p.track !== p.scheduledTrack),
        agency: st.agencyName || null,
        alerts: (st.alerts || p.alerts || []).map((a) => a.headerText || a.descriptionText).filter(Boolean),
      };
    })
    .filter((x) => new Date(x.scheduled) <= until)
    .sort((a, b) => new Date(a.expected) - new Date(b.expected));

  const live = departures.filter((x) => x.realtime && !x.cancelled);
  return {
    label: station.label || d.place?.name || stop.name || station.query,
    name: d.place?.name || stop.name,
    stopId: stop.id,
    departures,
    summary: {
      count: departures.length,
      until: departures.at(-1)?.scheduled || null,
      cancelled: departures.filter((x) => x.cancelled).length,
      delayed: live.filter((x) => x.delay >= 5).length,
      maxDelay: Math.max(0, ...live.map((x) => x.delay || 0)),
      realtime: live.length,
    },
  };
}

async function transit(loc) {
  if (!loc.stations.length && !loc.transit.length) throw new Error('no stations or transit feeds configured');
  const [boards, news] = await Promise.all([
    Promise.allSettled(loc.stations.map((s) => departureBoard(loc, s))),
    loc.transit.length ? section(feeds(loc.transit)) : null,
  ]);
  const stations = boards.map((r, i) => (r.status === 'fulfilled'
    ? { ok: true, ...r.value }
    : { ok: false, label: loc.stations[i].label || loc.stations[i].query, error: r.reason.message }));
  if (stations.length && stations.every((s) => !s.ok) && !news?.ok) {
    throw new Error(stations.map((s) => `${s.label}: ${s.error}`).concat(news ? [news.error] : []).join('; '));
  }
  return { stations, news, source: 'Transitous (DELFI timetable + realtime)' };
}

async function section(p) {
  try { return { ok: true, ...(await p) }; }
  catch (err) { return { ok: false, error: err.message }; }
}

async function locationReport(loc) {
  const sections = {
    warnings: warnings(loc),
    weather: weather(loc),
    roadworks: roadworks(loc),
    police: feeds(loc.police),
    news: feeds(loc.news),
    pollen: pollen(loc),
    transit: transit(loc),
  };
  const out = { fetchedAt: new Date().toISOString() };
  await Promise.all(Object.entries(sections).map(async ([k, p]) => { out[k] = await section(p); }));
  return out;
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/locations') {
      return send(res, 200, LOCATIONS.map(({ id, name, subtitle, lat, lon, radiusKm, stations, transit }) =>
        ({ id, name, subtitle, lat, lon, radiusKm, transit: stations.length + transit.length > 0 })));
    }
    const m = /^\/api\/location\/([\w-]+)(\/transit)?$/.exec(url.pathname);
    if (m) {
      const loc = LOCATIONS.find((l) => l.id === m[1]);
      if (!loc) return send(res, 404, { error: 'unknown location' });
      if (m[2]) return send(res, 200, { fetchedAt: new Date().toISOString(), transit: await section(transit(loc)) });
      return send(res, 200, await locationReport(loc));
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden', 'text/plain');
    const body = await readFile(file);
    return send(res, 200, body, MIME[extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return send(res, 404, 'not found', 'text/plain');
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Locality running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
