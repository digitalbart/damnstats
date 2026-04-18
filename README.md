# damn stats

## Screenshots

# Warnings
<img width="1871" height="1045" alt="image" src="https://github.com/user-attachments/assets/88f64bd7-fe8f-435d-8634-d2df48877218" />


## Radar
<img width="1670" height="881" alt="image" src="https://github.com/user-attachments/assets/f5d462af-ee33-44f2-ac0c-ec29819465db" />

# Michigan Dam Watch

Michigan Dam Watch is a single-page demo dashboard for exploring Michigan dams with nearby gauge context, NOAA/NWPS hydrographs, USGS water levels, NWS alerts, public camera feeds, live radar, and hydrography map layers.

This is for demonstration and situational awareness only. It is not an official monitoring product, not an emergency alerting system, and should not be used for public safety decisions.

The working page is:

`dams.html`

## What It Does

- Shows a curated Michigan dam watch list on an interactive map.
- Ranks dams by concern, gauge proximity, camera availability, hydro sites, or closeness to flood level.
- Draws a danger bar across each dam result so flood proximity is scannable.
- Links each selected dam to nearby gauge data, NOAA/NWPS gauge pages, estimated flood level context, NWS alerts, public cameras, local radar, and source links.
- Shows selected-dam labels on the map when choosing from the sidebar.
- Shows active NWS alert shapes on the map when NWS provides alert geometry.
- Shows USGS RT-FI flood impact locations when available.
- Adds a live radar mode over the main map.
- Adds a small local radar preview in the selected dam panel.
- Supports OpenStreetMap, USGS topo, imagery, and hydrography map layers.
- Fetches selected-dam NWS alerts, USGS gauge stage, NOAA/NWPS gauge data, NOAA/NWPS stageflow, and NWS weather forecast data with local one-hour caching.

## How To Use

Open `dams.html` in a browser.

The app is plain HTML, CSS, and JavaScript. It does not need a build step for the dam dashboard.

Main controls:

- **Search:** filter by dam, county, owner, river, gauge, or camera name.
- **View:** switch between watch list, hydro sites, live cameras, gauge-linked dams, or all configured dams.
- **Sort:** rank by most concerning, closest to flood level, nearest gauge, or name.
- **Hide no-gauge dams:** remove dams that do not have a linked gauge.
- **Map / Radar / Cameras:** change the main viewport without leaving the page.
- **Map layer control:** switch between OpenStreetMap, USGS topo, imagery, and hydrography overlay.

Selected dam panel:

- Shows dam identity, hazard rank, data freshness, live camera if available, local radar, gauge/flood numbers, impact context, and source links.
- Freshness dots show the age of gauge, NWS alert, and weather data.
- Camera embeds are only shown for verified public streams.
- NOAA, USGS, EGLE, and camera links open the relevant source pages when available.

Telemetry panel:

- Shows observed stage, forecast stage, and flood level when available.
- Uses NOAA/NWPS hydrograph data when a linked NOAA gauge exists.
- Includes a **Dots** chart tab for the local dark-mode chart.
- Includes a **NOAA** tab for the official NOAA hydrograph image when available.
- The dots chart includes observed stage, forecast stage, and flood level reference lines.
- Hovering the dots chart shows the stage values at each time point.

Forecast panel:

- Shows a simple trend estimate using recent gauge movement and nearby NWS weather forecast text.
- This is a lightweight heuristic, not a hydrologic forecast.

NWS panel:

- Shows active NWS alerts and watches for the selected dam point.
- Alert geometry is drawn on the map when available from NWS.
- If an alert has no geometry, the app may show a small local fallback ring near the selected dam.

## Data Sources

The dashboard currently combines local configured data with public live services:

- OpenStreetMap tiles through Leaflet.
- USGS National Map topo, imagery, and hydrography layers.
- NWS active alerts API.
- NWS point forecast API.
- USGS instantaneous values API for gauge stage.
- USGS latest continuous values OGC API for statewide observed stage context.
- USGS Real-Time Flood Impact API for flood impact locations where available.
- NOAA/NWPS gauge API for gauge metadata, official hydrograph images, flood categories, forecasts, and tabular links.
- Iowa Environmental Mesonet NEXRAD WMS radar mosaic.
- EGLE dam inventory source links.
- Public YouTube camera feeds where a verified embeddable stream is configured.

## Caching

The dashboard uses browser local storage to avoid repeatedly hitting public services.

Current behavior:

- Most live data is cached for about one hour.
- Dam inventory enrichment is cached longer.
- NOAA/NWPS misses are cached so unavailable gauges are not repeatedly requested.
- Cached data is local to the browser and can be cleared by clearing site data.

## Current Limits

This is not the full Michigan dam inventory. The current list is a curated demo/watch list, not every dam in the state.

Known limits:

- Dam points are only as accurate as the configured latitude/longitude values.
- Gauge matching is nearby-gauge context, not an official dam-specific gauge assignment.
- NOAA/NWPS gauge context may represent a nearby river forecast point, not the dam structure itself.
- Some dams have observed gauge levels but no known flood level.
- Some NOAA/NWPS gauges have official hydrographs but no defined flood stage.
- Radar is a public mosaic layer and should be treated as general weather context.
- NWS alert geometry depends on what the NWS API returns for the selected point.
- Public camera availability can change without notice.
- This is not an emergency alerting system.

For a statewide production version, the next major upgrade should load the official EGLE Dam Inventory as the base dataset and then filter/rank by hazard, condition, gauge proximity, NOAA/NWPS forecast context, USGS observed levels, flood impact context, and camera availability.

## File Map

- `dams.html`: page shell.
- `dams/styles.css`: layout, dark UI, map/radar/camera styling.
- `dams/data.js`: configured dams, cameras, source links, and fallback gauge data.
- `dams/components.js`: UI rendering helpers.
- `dams/app.js`: map, filtering, sorting, live fetches, caching, charts, and event wiring.

## Development Notes

No compile step is required for the dam dashboard.

For quick syntax checks:

```bash
node --check dams/data.js
node --check dams/components.js
node --check dams/app.js

