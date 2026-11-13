# Locality

A local dashboard of official warnings, weather, roadworks, police reports, regional news and
pollen for the places you configure.

```sh
cp .env.example .env   # then set your locations
npm start              # or: node --env-file=.env server.js   (Node 22.9+, no dependencies)
# open http://localhost:8787
```

Set `PORT=…` to change the port, or `HOST=0.0.0.0` to reach it from your phone on the LAN.

## Configuration

Locations live **only** in environment variables (normally `.env`, which is gitignored); the
code contains none. `LOCATIONS` lists the ids in display order, and each id has a block of
`<ID>_*` variables:

| Variable | |
|---|---|
| `<ID>_NAME`, `<ID>_SUBTITLE` | Labels |
| `<ID>_LAT`, `<ID>_LON` | Centre point (weather, roadworks distance) |
| `<ID>_ARS` | Amtlicher Regionalschlüssel at district level, for NINA warnings |
| `<ID>_RADIUS_KM` | Roadworks further away are dropped (default 15) |
| `<ID>_AUTOBAHNS` | Motorways to query, e.g. `A1,A7` |
| `<ID>_VIZ` | `true` to include Berlin VIZ roadworks and closures |
| `<ID>_WMO_STATION` | Optional DWD station for current weather (default: nearest) |
| `<ID>_POLLEN` | DWD pollen `region/partregion` (`-1` = whole region) |
| `<ID>_KEYWORDS` | Comma list of words marking an item as local; `/…/` is a regex |
| `<ID>_POLICE`, `<ID>_NEWS` | RSS feeds: `Name\|url[\|keywords]`, separated by `;` |
| `<ID>_STATIONS` | Up to 2 stops for departure boards: `[Label\|]stop`, separated by `;` |
| `<ID>_TRANSIT` | Optional transit disruption/service RSS feeds, same format as `<ID>_NEWS` |

A station is a stop name, looked up near `<ID>_LAT`/`<ID>_LON` (e.g. `Darmstadt Hauptbahnhof`),
or a Transitous stop id (e.g. `de-DELFI_de:06411:4734`) when the name picks the wrong stop. The
dashboard shows the stop it resolved to next to your label. Departure boards refresh every minute.

A feed with a third field is matched against those keywords (`*` expands to `<ID>_KEYWORDS`),
and the UI's "Local only" switch shows just the matches. A feed without one counts as entirely
local. Quote values with spaces, backslashes or `|` in single quotes. See `.env.example`.

## Sources (all free, no API keys)

| Section | Source |
|---|---|
| Warnings | NINA dashboard API (BBK: MoWaS, KATWARN, BIWAPP, flood, police) + DWD municipal weather warnings via Bright Sky |
| Weather | DWD observations via Bright Sky |
| Roadworks | Autobahn GmbH API (roadworks, closures, warnings) · VIZ Berlin roadworks/closures (optional) |
| Police, News | Any RSS feeds you configure, e.g. state police, Presseportal Blaulicht, public broadcasters |
| Pollen | DWD pollen forecast |
| Public transport | [Transitous](https://transitous.org) (DELFI nationwide timetables with realtime delays and cancellations) · any disruption RSS feeds you configure |

## Gaps

- Public transport disruptions: the realtime data reports delays, cancellations and platform
  changes but no free-text service alerts, and no keyless disruption feeds were found for VBB,
  S-Bahn Berlin or RMV. The station summaries ("3 cancelled", "2 delayed 5+ min") stand in for them;
  add feeds via `<ID>_TRANSIT` if you have any.
- Outside Berlin, roadworks are motorway-only: no open data was found for state roads or city
  streets elsewhere.

## Docker

Every push to `main` builds `ghcr.io/cptn-cosmo/locality:latest` (amd64 + arm64).

```sh
docker run -d -p 8787:8787 --init --env-file .env ghcr.io/cptn-cosmo/locality:latest
```

`docker run --env-file` does not strip quotes; use Compose's `env_file:` instead if your
values are quoted.
