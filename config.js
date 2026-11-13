// Locations come from environment variables (usually a .env file), never from the code.
// See README.md and .env.example for the format.
//
//   LOCATIONS=home,work                    ids, in display order
//   <ID>_NAME, <ID>_SUBTITLE               labels
//   <ID>_LAT, <ID>_LON                     centre point
//   <ID>_ARS                               Amtlicher Regionalschlüssel, district level (NINA)
//   <ID>_RADIUS_KM                         drop roadworks further away (default 15)
//   <ID>_AUTOBAHNS=A1,A2                   motorways queried via the Autobahn GmbH API
//   <ID>_VIZ=true                          include Berlin VIZ roadworks
//   <ID>_WMO_STATION                       optional DWD station for current weather
//   <ID>_POLLEN=region/part                DWD pollen region (part -1 = whole region)
//   <ID>_KEYWORDS=a,b,/re/                 words that mark an item as local
//   <ID>_POLICE, <ID>_NEWS                 feeds: "Name|url|keywords; Name|url"
//
// A feed's optional third field turns on local matching for it: a comma list of
// keywords, where `*` stands for <ID>_KEYWORDS. Keywords written as /…/ are regexes.

const env = process.env;

const list = (s, sep = ',') => (s || '').split(sep).map((x) => x.trim()).filter(Boolean);

function keyword(s) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : s;
}

function keywords(s, base = []) {
  return list(s).flatMap((k) => (k === '*' ? base : [keyword(k)]));
}

function number(key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`${key} is not set`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} is not a number: ${raw}`);
  return n;
}

function feeds(key, base) {
  return list(env[key], ';').map((entry) => {
    const [name, url, local] = entry.split('|').map((x) => x.trim());
    if (!name || !url) throw new Error(`${key}: expected "Name|url[|keywords]", got "${entry}"`);
    return local ? { name, url, local: keywords(local, base) } : { name, url };
  });
}

function location(id) {
  const p = id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_';
  const base = keywords(env[p + 'KEYWORDS']);
  const [region, part = -1] = list(env[p + 'POLLEN'], '/').map(Number);
  if (!env[p + 'ARS']) throw new Error(`${p}ARS is not set`);
  return {
    id,
    name: env[p + 'NAME'] || id,
    subtitle: env[p + 'SUBTITLE'] || '',
    lat: number(p + 'LAT'),
    lon: number(p + 'LON'),
    ars: env[p + 'ARS'],
    radiusKm: number(p + 'RADIUS_KM', 15),
    autobahns: list(env[p + 'AUTOBAHNS']).map((a) => a.toUpperCase()),
    viz: /^(1|true|yes)$/i.test(env[p + 'VIZ'] || ''),
    ...(env[p + 'WMO_STATION'] ? { wmoStation: env[p + 'WMO_STATION'] } : {}),
    pollen: region ? { region, part } : null,
    police: feeds(p + 'POLICE', base),
    news: feeds(p + 'NEWS', base),
  };
}

const ids = list(env.LOCATIONS).map((id) => id.toLowerCase());
if (!ids.length) {
  console.error('No locations configured: set LOCATIONS and the <ID>_* variables (see .env.example).');
  process.exit(1);
}

export const LOCATIONS = ids.map(location);
