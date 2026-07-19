# Hurricane Barry Water-Level Timeline

An interactive, hourly reconstruction of Hurricane Barry (July 10–20, 2019) alongside verified water levels at five NOAA gauges:

- New Canal Station (8761927)
- Grand Isle (8761724)
- Bay Waveland Yacht Club (8747437)
- Port Fourchon, Belle Pass (8762075)
- West Bank 1, Bayou Gauche (8762482)

The map shows observed water level, departure from the predicted astronomical tide, Hurricane Barry's NHC best-track position and intensity, timeline playback, direct hourly stepping, and CDT/UTC timestamps. A synchronized five-series chart plots the full hourly water-level history and marks the selected time; clicking or dragging the chart moves the timeline.

## Data definitions

For New Canal, Grand Isle, Bay Waveland, and Port Fourchon, heights are verified hourly observations in feet relative to MHHW. Departure from normal is observed minus the NOAA astronomical tide prediction.

NOAA does not provide an MHHW datum or astronomical tide predictions for Bayou Gauche station 8762482. Its water level is shown in feet MSL, and its anomaly is relative to the mean observed level on July 10, 2019.

Hurricane positions, wind, and pressure are taken from Table 1 of the [NHC Tropical Cyclone Report for Barry](https://www.nhc.noaa.gov/data/tcr/AL022019_Barry.pdf). Values between official fixes are linearly interpolated to the hourly gauge timestamps and labeled as such in the interface.

## Sources

- [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/)
- [NHC Tropical Cyclone Report: Hurricane Barry (AL022019)](https://www.nhc.noaa.gov/data/tcr/AL022019_Barry.pdf)

## Local preview

Serve the repository root with any static web server. For example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.
