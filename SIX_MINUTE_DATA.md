# Six-minute water-level data

This branch upgrades generated storm datasets from hourly observations to a 6-minute timeline.

- NOAA CO-OPS `water_level` is requested first for each station.
- If 6-minute data are unavailable, the builder falls back to verified `hourly_height` values for that station and leaves the intervening 6-minute samples missing.
- Tide predictions are requested at 6-minute intervals.
- Plot-window durations and ±1/±6-hour controls remain expressed in hours; the viewer converts them to the appropriate number of timeline samples.
- Event-window thresholds remain configured in hours and are converted to 6-minute sample counts by the builder.

After this branch is merged, the `Build configured storm data` workflow rebuilds all configured storms so existing Barry, Ida, Isaac, and Sally datasets use the new schema. The workflow also commits the migrated builder, viewer, and generated data back to `main`, after which GitHub Pages deploys the updated site.
