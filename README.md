# Historical Storm Water-Level Viewer

A reusable static GitHub Pages viewer that synchronizes official NHC best tracks with verified hourly NOAA coastal water levels. The storm selector currently includes:

- Hurricane Barry — 2019
- Hurricane Ida — 2021

Barry remains the default so existing bookmarks without a query parameter behave as before. A selected storm can be linked directly with `?storm=barry-2019` or `?storm=ida-2021`.

## Viewer behavior

Changing the storm rebuilds the track, elapsed-track line, storm marker, gauge markers, permanent labels, timeline, chart, legend, date limits, map bounds, titles, and summary counts without reloading the page. The selected event opens at its configured landfall time, rounded to the nearest available hourly water-level observation.

Each available gauge has an independent visibility checkbox. Turning a gauge off hides its map marker and permanent label, full chart series, and highlighted current-hour chart point. **All** and **None** provide shortcuts; any individual combination remains supported.

The lower timeline always covers the storm's complete configured event period. The chart has a separate viewport that can show the full event or a 7-day, 5-day, 3-day, or 48-hour interval. **Earlier** and **Later** pan that chart-only window without moving the storm reconstruction; **Reset plot** restores the selected storm's configured default. Barry defaults to its full event, while Ida defaults to a five-day window centered on landfall. Moving the main timeline beyond the visible chart range automatically pans the limited chart window enough to include the selected hour.

The chart and timeline support:

- hourly slider movement and chart dragging
- Start and configured Landfall jumps
- ±1-hour and ±6-hour controls
- 1×, 2×, and 4× playback
- local date/time jumping
- left/right keyboard movement, Shift+left/right six-hour movement, and spacebar playback
- dynamically generated date ticks and storm-specific Y-axis scaling
- chart-window Y-axis rescaling based only on visible hours and enabled gauges

## Repository structure

```text
data/
  storms.js          Small browser-facing storm catalog
  barry-2019.js      Generated Barry dataset
  ida-2021.js        Generated Ida dataset
scripts/
  storms.json        Storm, station, threshold, and display configuration
  build_storm_data.py
app.js               Generic event-driven viewer
index.html           Static application shell
styles.css           Shared responsive design
```

Each generated storm file uses the same schema and registers itself in `window.STORM_DATASETS`. The full downloaded analysis window remains in the dataset. `metadata.eventWindow.displayStart` and `displayEnd` determine the normal interactive timeline. The browser catalog's optional `defaultChartWindowHours` only controls the chart viewport and never shortens the event timeline or source arrays.

## Data definitions

For New Canal, Grand Isle, Bay Waveland, and Port Fourchon:

- `observed` is the NOAA CO-OPS verified hourly height in feet relative to MHHW.
- `predicted` is the NOAA CO-OPS hourly astronomical tide prediction in feet relative to MHHW.
- `departure = observed - predicted`.

Missing observations remain `null`. They create visible gaps in a chart line and are never replaced with zero or silently interpolated.

NOAA does not provide MHHW or astronomical tide predictions for West Bank 1, Bayou Gauche (8762482). That gauge is retrieved in feet MSL and uses an event-specific baseline:

- **Barry:** the original viewer's fixed −0.212 ft MSL July 10 pre-storm mean is retained so Barry's displayed values remain unchanged.
- **Ida:** 0.184 ft MSL, the median of 48 verified hourly observations from 2021-08-22 16:00 UTC through 2021-08-24 15:00 UTC.

For a baseline station, `departure = observed - event baseline`.

## Hurricane Ida limitations

Port Fourchon (8762075) stops reporting verified hourly observations at 2021-08-29 16:00 UTC, 55 minutes before Ida's official 16:55 UTC landfall. The downloaded 338-hour period therefore contains 169 missing Port Fourchon hours. The chart ends that station's line at the final verified value and leaves the remainder blank.

The other four gauges have verified observations throughout Ida's configured download period. This does not imply that every observation is unaffected by local instrument or datum limitations; it only describes data availability returned by NOAA CO-OPS.

## Automatic event-analysis window

The builder initially downloads landfall minus seven days through landfall plus seven days. The default displayed period is landfall minus five days through landfall plus five days, with configurable expansion.

Current defaults in `scripts/storms.json` are:

- 3-hour rolling median of water-level departures
- possible onset when departures exceed +0.35 ft for at least three consecutive hours at two or more available gauges
- possible recovery when departures are within ±0.25 ft for at least 18 consecutive hours at two or more gauges and at least 75% of gauges reporting that hour

If onset occurs before the default start, the beginning expands. If a confirmed recovery occurs after the default end, the ending expands through the 18-hour confirmation period. If no recovery is confirmed, the display extends through the downloaded period. These thresholds identify an event-analysis window based on water-level departures; they do **not** prove that every departure was caused exclusively by the tropical cyclone.

Ida's calculated onset is 2021-08-24 20:00 UTC. No confirmed recovery occurred before the end of the downloaded period, so its display runs from 2021-08-24 16:00 UTC through 2021-09-05 17:00 UTC. Barry uses a documented display override to preserve the original 264-hour July 10–20 timeline; its overlapping station rows were checked against the previous `data.js` and match exactly.

## Generate or regenerate storm data

Python 3.10+ is sufficient; no third-party packages are required.

```bash
python3 scripts/build_storm_data.py --storm all
```

Build one event:

```bash
python3 scripts/build_storm_data.py --storm ida-2021
```

Downloaded source responses are cached under `.cache/storm-data/`. To regenerate without network requests after the cache exists:

```bash
python3 scripts/build_storm_data.py --storm all --offline
```

The builder:

1. reads storm and station configuration from `scripts/storms.json`;
2. downloads verified hourly observations and supported tide predictions from NOAA CO-OPS;
3. normalizes timestamps to UTC and aligns every station to one hourly grid;
4. preserves missing values as `null`;
5. calculates predicted-tide departures or a documented pre-event baseline departure;
6. downloads and parses the official NHC HURDAT2 record, including non-synoptic landfall points;
7. calculates the candidate event-analysis window;
8. validates every station array against the timeline length;
9. prints missing-period, prediction, datum, landfall, and coverage warnings; and
10. writes one independent static JavaScript dataset per storm.

## Add another storm

1. Add a storm entry to `scripts/storms.json` with its unique ID, Atlantic basin ID, official UTC landfall time, title, local timezone, map bounds, and source links.
2. Add or override station configuration only when its datum, prediction support, label direction, or baseline method differs.
3. Add the storm to the small browser catalog in `data/storms.js`, including an optional `defaultChartWindowHours` (`null` means the full event).
4. Add the generated script tag to `index.html`.
5. Run `python3 scripts/build_storm_data.py --storm <storm-id>`.
6. Review every warning and document material outages or datum limitations here.
7. Test switching repeatedly between all events before deployment.

Thresholds, download lengths, display lengths, baseline hours, map bounds, tooltip directions, and optional display overrides are configuration values rather than hard-coded application logic.

## Official sources

- [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/)
- [NHC HURDAT2 archive](https://www.nhc.noaa.gov/data/hurdat/)
- [NHC Hurricane Barry Tropical Cyclone Report](https://www.nhc.noaa.gov/data/tcr/AL022019_Barry.pdf)
- [NHC Hurricane Ida Tropical Cyclone Report](https://www.nhc.noaa.gov/data/tcr/AL092021_Ida.pdf)

## Local preview

Serve the repository root with any static web server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Test the direct links `?storm=barry-2019` and `?storm=ida-2021` as well as in-page switching.

## GitHub Pages deployment

The existing `.github/workflows/pages.yml` workflow deploys the repository root whenever `main` receives a push. No server, database, Streamlit app, paid API, or build service is required at runtime. If the Pages site appears stale after repository changes, confirm that the change reached `main` and that the Pages workflow completed successfully.
