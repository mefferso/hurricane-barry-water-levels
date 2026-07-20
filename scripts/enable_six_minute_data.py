#!/usr/bin/env python3
"""Idempotently upgrade the storm builder and viewer from hourly to 6-minute data.

The project originally used NOAA's verified ``hourly_height`` product and treated
one array index as one hour. This migration changes the generated timeline to a
6-minute grid, requests NOAA ``water_level`` observations and 6-minute tide
predictions, falls back to hourly verified heights when 6-minute data are not
available, and makes the browser convert hours to timeline samples.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build_storm_data.py"
APP = ROOT / "app.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"Could not locate expected {label} block")
    return text.replace(old, new, 1)


def patch_builder() -> None:
    text = BUILDER.read_text(encoding="utf-8")

    text = replace_once(
        text,
        '''def hourly_range(start: datetime, end: datetime) -> list[datetime]:
    hours = int((end - start).total_seconds() // 3600)
    return [start + timedelta(hours=i) for i in range(hours + 1)]
''',
        '''def interval_range(start: datetime, end: datetime, minutes: int) -> list[datetime]:
    step = timedelta(minutes=minutes)
    count = int((end - start) // step)
    return [start + step * i for i in range(count + 1)]
''',
        "timeline range",
    )

    text = replace_once(
        text,
        '''    if product == "predictions":
        params["interval"] = "h"
''',
        '''    if product == "predictions":
        params["interval"] = "6"
''',
        "prediction interval",
    )

    text = replace_once(
        text,
        '''    key = "data" if product == "hourly_height" else "predictions"
''',
        '''    key = "predictions" if product == "predictions" else "data"
''',
        "CO-OPS response key",
    )

    text = replace_once(
        text,
        '''def event_window(
    times: list[datetime],
    station_values: dict[str, list[list[float | None]]],
    landfall: datetime,
    settings: dict[str, Any],
    display_days_before: int,
    display_days_after: int,
    override: dict[str, Any] | None,
) -> dict[str, Any]:
    width = int(settings["rolling_median_hours"])
''',
        '''def event_window(
    times: list[datetime],
    station_values: dict[str, list[list[float | None]]],
    landfall: datetime,
    settings: dict[str, Any],
    display_days_before: int,
    display_days_after: int,
    override: dict[str, Any] | None,
    interval_minutes: int,
) -> dict[str, Any]:
    samples_per_hour = 60 // interval_minutes
    width = max(1, int(settings["rolling_median_hours"]) * samples_per_hour)
''',
        "event-window signature",
    )

    text = replace_once(
        text,
        '''    onset_index = first_true_run(onset_flags, int(settings["onset_consecutive_hours"]))
''',
        '''    onset_index = first_true_run(
        onset_flags,
        int(settings["onset_consecutive_hours"]) * samples_per_hour,
    )
''',
        "onset run length",
    )

    text = replace_once(
        text,
        '''        int(settings["recovery_consecutive_hours"]),
''',
        '''        int(settings["recovery_consecutive_hours"]) * samples_per_hour,
''',
        "recovery run length",
    )

    text = replace_once(
        text,
        '''        "periodEnd": iso_utc(period_end - timedelta(hours=1)),
            "sampleHours": len(sample),
''',
        '''        "periodEnd": iso_utc(period_end - timedelta(minutes=6)),
            "sampleCount": len(sample),
''',
        "baseline coverage",
    )

    text = replace_once(
        text,
        '''    times = hourly_range(download_start, download_end)
    timestamp_set = set(times)
''',
        '''    interval_minutes = int(storm.get("interval_minutes", defaults.get("interval_minutes", 6)))
    times = interval_range(download_start, download_end, interval_minutes)
    timestamp_set = set(times)
''',
        "storm timeline",
    )

    text = replace_once(
        text,
        '''        observations, metadata, observation_url, observation_error = coops_series(
            downloader, station, download_start, download_end, defaults["application"], "hourly_height"
        )
        source_requests.append(observation_url)
        if observation_error:
            warnings.append(f"{station_id} observations: {observation_error}")
        observations = {timestamp: value for timestamp, value in observations.items() if timestamp in timestamp_set}
''',
        '''        observations, metadata, observation_url, observation_error = coops_series(
            downloader, station, download_start, download_end, defaults["application"], "water_level"
        )
        source_requests.append(observation_url)
        observation_product = "water_level"
        if observation_error or not observations:
            fallback, fallback_metadata, fallback_url, fallback_error = coops_series(
                downloader, station, download_start, download_end, defaults["application"], "hourly_height"
            )
            source_requests.append(fallback_url)
            if fallback:
                observations = fallback
                metadata = fallback_metadata or metadata
                observation_error = None
                observation_product = "hourly_height"
                warnings.append(f"{station_id} has no usable 6-minute water levels; using verified hourly heights.")
            else:
                observation_error = observation_error or fallback_error
        if observation_error:
            warnings.append(f"{station_id} observations: {observation_error}")
        observations = {timestamp: value for timestamp, value in observations.items() if timestamp in timestamp_set}
''',
        "observation download",
    )

    text = replace_once(
        text,
        '''        if missing:
            warnings.append(f"{station_id} is missing {missing} of {len(times)} hourly observations.")
        if station.get("predictions", False) and prediction_count != len(times):
            warnings.append(f"{station_id} is missing {len(times) - prediction_count} hourly predictions.")
''',
        '''        if missing:
            warnings.append(f"{station_id} is missing {missing} of {len(times)} timeline samples.")
        if station.get("predictions", False) and prediction_count != len(times):
            warnings.append(f"{station_id} is missing {len(times) - prediction_count} 6-minute predictions.")
''',
        "coverage warnings",
    )

    text = replace_once(
        text,
        '''            "coverage": {
                "observationHours": observed_count,
                "predictionHours": prediction_count,
                "totalHours": len(times),
''',
        '''            "coverage": {
                "observationSamples": observed_count,
                "predictionSamples": prediction_count,
                "totalSamples": len(times),
                "intervalMinutes": interval_minutes,
                "observationProduct": observation_product,
''',
        "coverage metadata",
    )

    text = replace_once(
        text,
        '''        storm.get("display_window_override"),
    )
''',
        '''        storm.get("display_window_override"),
        interval_minutes,
    )
''',
        "event-window call",
    )

    text = replace_once(
        text,
        '''            "defaultChartWindowHours": storm.get("default_chart_window_hours"),
''',
        '''            "defaultChartWindowHours": storm.get("default_chart_window_hours"),
            "intervalMinutes": interval_minutes,
''',
        "interval metadata",
    )

    text = replace_once(
        text,
        '''                "water": "NOAA CO-OPS verified hourly heights",
                "predictions": "NOAA CO-OPS astronomical tide predictions",
''',
        '''                "water": "NOAA CO-OPS 6-minute water levels when available; verified hourly fallback",
                "predictions": "NOAA CO-OPS 6-minute astronomical tide predictions",
''',
        "source descriptions",
    )

    text = replace_once(
        text,
        '''        raise ValueError("Timeline must contain at least two hours")
''',
        '''        raise ValueError("Timeline must contain at least two samples")
''',
        "timeline validation",
    )

        text = replace_once(
        text,
        '''        raise ValueError("Timeline must contain at least two hours")
''',
        '''        raise ValueError("Timeline must contain at least two samples")
''',
        "timeline validation",
    )

    text = replace_once(
        text,
        '''        print(f"  wrote {path.relative_to(ROOT)} ({len(dataset['times'])} downloaded hours)")
''',
        '''        print(
            f"  wrote {path.relative_to(ROOT)} "
            f"({len(dataset['times'])} samples at {dataset['metadata']['intervalMinutes']}-minute intervals)"
        )
''',
        "build summary",
    )

    text = replace_once(
        text,
        '''        print(f"  wrote {path.relative_to(ROOT)} ({len(dataset['times'])} downloaded hours)")
''',
        '''        print(
            f"  wrote {path.relative_to(ROOT)} "
            f"({len(dataset['times'])} samples at {dataset['metadata']['intervalMinutes']}-minute intervals)"
        )
''',
        "build summary",
    )

    BUILDER.write_text(text, encoding="utf-8")


def patch_app() -> None:
    text = APP.read_text(encoding="utf-8")

    text = replace_once(
        text,
        '''  function colorForDeparture(value) {
''',
        '''  function sampleIntervalMinutes() {
    return Math.max(1, Number(data?.metadata?.intervalMinutes) || 60);
  }

  function samplesPerHour() {
    return Math.max(1, Math.round(60 / sampleIntervalMinutes()));
  }

  function hourStep(hours) {
    return Math.max(1, Math.round(hours * 60 / sampleIntervalMinutes()));
  }

  function colorForDeparture(value) {
''',
        "sample interval helpers",
    )

    text = replace_once(
        text,
        '''      hour: "numeric"
    }).format(value);
''',
        '''      hour: "numeric",
      minute: "2-digit"
    }).format(value);
''',
        "chart time formatting",
    )

    text = replace_once(
        text,
        '''    els.hourCount.textContent = `${times.length} hours`;
''',
        '''    const durationHours = Math.round(((times.length - 1) * sampleIntervalMinutes()) / 60);
    els.hourCount.textContent = `${durationHours} hours · ${sampleIntervalMinutes()}-min data`;
''',
        "header interval label",
    )

    text = replace_once(
        text,
        '''    els.slider.max = String(times.length - 1);
''',
        '''    els.slider.max = String(times.length - 1);
    els.date.step = String(sampleIntervalMinutes() * 60);
''',
        "date input step",
    )

    text = replace_once(
        text,
        '''    const fullSpan = Math.max(0, times.length - 1);
    if (!Number.isFinite(hours) || hours <= 0 || hours >= fullSpan) return null;
''',
        '''    const fullSpanHours = Math.max(0, ((times.length - 1) * sampleIntervalMinutes()) / 60);
    if (!Number.isFinite(hours) || hours <= 0 || hours >= fullSpanHours) return null;
''',
        "chart window normalization",
    )

    text = replace_once(
        text,
        '''    const span = Math.min(chartWindowHours, last);
''',
        '''    const span = Math.min(hourStep(chartWindowHours), last);
''',
        "chart window sample span",
    )

    text = replace_once(
        text,
        '''    const formatter = span <= 72 ? formatDateTimeTick : formatDateTick;
''',
        '''    const spanHours = (span * sampleIntervalMinutes()) / 60;
    const formatter = spanHours <= 72 ? formatDateTimeTick : formatDateTick;
''',
        "chart tick span",
    )

    text = replace_once(
        text,
        '''      <div class="storm-note">${storm.exact ? "Official best-track fix" : "Hourly interpolation between official fixes"}</div>`;
''',
        '''      <div class="storm-note">${storm.exact ? "Official best-track fix" : "Interpolation between official fixes"}</div>`;
''',
        "track interpolation wording",
    )

    text = replace_once(
        text,
        '''    els.chart.setAttribute("aria-label", `Hourly verified water levels for ${data.metadata.displayTitle}. Visible range: ${formatLocal(times[chartStartIndex])} through ${formatLocal(times[chartEndIndex])}. Selected time: ${formatLocal(times[i])}.`);
''',
        '''    els.chart.setAttribute("aria-label", `${sampleIntervalMinutes()}-minute water levels for ${data.metadata.displayTitle}. Visible range: ${formatLocal(times[chartStartIndex])} through ${formatLocal(times[chartEndIndex])}. Selected time: ${formatLocal(times[i])}.`);
''',
        "chart accessibility label",
    )

    text = replace_once(
        text,
        '''  document.getElementById("back-6").addEventListener("click", () => setIndex(index - 6));
  document.getElementById("back-1").addEventListener("click", () => setIndex(index - 1));
  document.getElementById("forward-1").addEventListener("click", () => setIndex(index + 1));
  document.getElementById("forward-6").addEventListener("click", () => setIndex(index + 6));
''',
        '''  document.getElementById("back-6").addEventListener("click", () => setIndex(index - hourStep(6)));
  document.getElementById("back-1").addEventListener("click", () => setIndex(index - hourStep(1)));
  document.getElementById("forward-1").addEventListener("click", () => setIndex(index + hourStep(1)));
  document.getElementById("forward-6").addEventListener("click", () => setIndex(index + hourStep(6)));
''',
        "transport controls",
    )

    text = replace_once(
        text,
        '''      setIndex(index - (event.shiftKey ? 6 : 1));
''',
        '''      setIndex(index - hourStep(event.shiftKey ? 6 : 1));
''',
        "left keyboard control",
    )

    text = replace_once(
        text,
        '''      setIndex(index + (event.shiftKey ? 6 : 1));
''',
        '''      setIndex(index + hourStep(event.shiftKey ? 6 : 1));
''',
        "right keyboard control",
    )

    APP.write_text(text, encoding="utf-8")


def main() -> int:
    patch_builder()
    patch_app()
    print("Six-minute water-level support is enabled.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
