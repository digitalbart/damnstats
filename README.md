# damn stats

<img width="2927" height="2552" alt="image" src="https://github.com/user-attachments/assets/d5aeb22d-3c1c-4054-80c9-68fdeb8df08c" />

## Radar
<img width="2927" height="2552" alt="image" src="https://github.com/user-attachments/assets/a0954c5f-4b79-4e93-920d-99367b4b0e4d" />

# Michigan Dam Watch

Michigan Dam Watch is a single-page monitoring dashboard for comparing Michigan dams against nearby gauge context, NWS alerts, public camera feeds, and live radar.

The working page is:

`public/dams.html`

## What It Does

- Shows a curated Michigan dam watch list on an interactive map.
- Ranks dams by concern, gauge proximity, camera availability, or closeness to flood level.
- Draws a danger bar across each dam result so flood proximity is scannable.
- Links each selected dam to nearby gauge data, flood level estimate, NWS alerts, public cameras, and radar.
- Adds a live radar mode over the main map.
- Adds a small local radar preview in the selected dam panel.
- Fetches selected-dam NWS alerts, USGS gauge stage, and NWS weather forecast data with local one-hour caching.

## Screenshots

Add current screenshots here when updating the page:

- `docs/screenshots/dam-watch-map.png`
- `docs/screenshots/dam-watch-radar.png`
- `docs/screenshots/dam-watch-camera.png`

Suggested captures:

- Map mode with the selected dam panel open.
- Radar mode during visible precipitation.
- Camera mode or a dam with a live camera feed.

## How To Use

Open `public/dams.html` in a browser.

The app is plain HTML, CSS, and JavaScript. It does not need a build step for the dam dashboard.

Main controls:

- Search: filter by dam, county, owner, river, gauge, or camera name.
- View: switch between watch list, live cameras, gauge-linked dams, or all configured dams.
- Sort: rank by most concerning, closest to flood level, nearest gauge, or name.
- Map / Radar / Cameras: change the main viewport without leaving the page.

Selected dam panel:

- Shows dam identity, hazard rank, data freshness, live camera if available, local radar, gauge/flood numbers, and source links.
- Freshness dots show the age of gauge, NWS alert, and weather data.

Telemetry panel:

- Shows observed stage, forecast stage, estimated flood level, and difference.
- The chart includes observed stage plus an estimated flood level reference line.

NWS panel:

- Shows active NWS alerts and watches for the selected dam point.

## Data Sources

The dashboard currently combines local configured data with public live services:

- OpenStreetMap tiles through Leaflet.
- NWS active alerts API.
- NWS point forecast API.
- USGS instantaneous values API for gauge stage.
- Iowa Environmental Mesonet NEXRAD WMS radar mosaic.
- EGLE dam inventory source links.
- Public camera feeds where a verified embeddable stream is configured.

## Current Limits

This is not the full Michigan dam inventory yet. The current list is a curated watch list, not every dam in the state.

Known limits:

- Dam points are only as accurate as the configured latitude/longitude values.
- Gauge matching is nearest-gauge context, not an official dam-specific gauge assignment.
- Flood level is an estimate derived from nearby gauge context in this prototype.
- Radar is a public mosaic layer and should be treated as situational context.
- This is not an emergency alerting system.

For a statewide production version, the next major upgrade should load the official EGLE Dam Inventory as the base dataset and then filter/rank by hazard, condition, gauge proximity, flood context, and camera availability.

## File Map

- `public/dams.html`: page shell.
- `public/dams/styles.css`: layout, night-mode UI, map/radar/camera styling.
- `public/dams/data.js`: configured dams, cameras, links, and fallback gauge data.
- `public/dams/components.js`: UI rendering helpers.
- `public/dams/app.js`: map, filtering, sorting, live fetches, caching, charts, and event wiring.

## Development Notes

No compile step is required for the dam dashboard
