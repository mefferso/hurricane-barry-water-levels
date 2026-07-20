#!/usr/bin/env python3
"""Build per-storm static datasets from official NOAA and NHC sources.

The script uses only the Python standard library. Source responses are cached so
regeneration can avoid repeated API calls. Generated files register themselves
in ``window.STORM_DATASETS`` and can be served directly by GitHub Pages.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
import time
import urllib.parse
import urllib.request
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = Path(__file__).with_name("storms.json")
DEFAULT_OUTPUT = ROOT / "data"
DEFAULT_CACHE = ROOT / ".cache" / "storm-data"
COOPS_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"

STATUS_NAMES = {
    "DB": "Disturbance",
    "LO": "Remnant Low",
    "WV": "Tropical Wave",
    "TD": "Tropical Depression",
    "TS": "Tropical Storm",
    "HU": "Hurricane",
    "EX": "Extratropical",
    "SD": "Subtropical Depression",
    "SS": "Subtropical Storm",
}


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def floor_hour(value: datetime) -> datetime:
    return value.replace(minute=0, second=0, microsecond=0)


def ceil_hour(value: datetime) -> datetime:
    floored = floor_hour(value)
    return floored if value == floored else floored + timedelta(hours=1)


def hourly_range(start: datetime, end: datetime) -> list[datetime]:
    hours = int((end - start).total_seconds() // 3600)
    return [start + timedelta(hours=i) for i in range(hours + 1)]


def finite_number(value: Any) -> float | None:
    if value in (None, "", "null"):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number <= -999:
        return None
    return number


def rounded(value: float | None) -> float | None:
    return None if value is None else round_like_javascript(value, 3)


def round_like_javascript(value: float, digits: int) -> float:
    """Match the Math.round behavior used by the original Barry data build."""
    factor = 10**digits
    return math.floor(value * factor + 0.5) / factor


@dataclass
class Downloader:
    cache_dir: Path
    offline: bool = False
    pause_seconds: float = 0.25

    def get_bytes(self, url: str) -> bytes:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(urllib.parse.urlparse(url).path).suffix or ".dat"
        cache_path = self.cache_dir / f"{hashlib.sha256(url.encode()).hexdigest()}{suffix}"
        if cache_path.exists():
            return cache_path.read_bytes()
        if self.offline:
            raise RuntimeError(f"No cached response for {url}")
        request = urllib.request.Request(url, headers={"User-Agent": "LIXHistoricalWaterViewer/1.0"})
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    body = response.read()
                cache_path.write_bytes(body)
                time.sleep(self.pause_seconds)
                return body
            except Exception as exc:  # pragma: no cover - network retry path
                last_error = exc
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"Unable to download {url}: {last_error}")

    def get_json(self, url: str) -> dict[str, Any]:
        return json.loads(self.get_bytes(url).decode("utf-8"))

    def get_text(self, url: str) -> str:
        return self.get_bytes(url).decode("utf-8", errors="replace")


def api_url(params: dict[str, Any]) -> str:
    return f"{COOPS_URL}?{urllib.parse.urlencode(params)}"


def coops_series(
    downloader: Downloader,
    station: dict[str, Any],
    start: datetime,
    end: datetime,
    application: str,
    product: str,
) -> tuple[dict[datetime, float], dict[str, Any] | None, str, str | None]:
    params: dict[str, Any] = {
        "begin_date": start.strftime("%Y%m%d"),
        "end_date": end.strftime("%Y%m%d"),
        "station": station["id"],
        "product": product,
        "datum": station["datum"],
        "time_zone": "gmt",
        "units": "english",
        "application": application,
        "format": "json",
    }
    if product == "predictions":
        params["interval"] = "h"
    url = api_url(params)
    try:
        payload = downloader.get_json(url)
    except Exception as exc:
        return {}, None, url, str(exc)
    if payload.get("error"):
        return {}, payload.get("metadata"), url, payload["error"].get("message", "Unknown NOAA API error")
    key = "data" if product == "hourly_height" else "predictions"
    rows = payload.get(key, [])
    result: dict[datetime, float] = {}
    for row in rows:
        value = finite_number(row.get("v"))
        if value is None:
            continue
        timestamp = datetime.strptime(row["t"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
        result[timestamp] = value
    return result, payload.get("metadata"), url, None


def parse_coordinate(value: str) -> float:
    direction = value[-1]
    number = float(value[:-1])
    return -number if direction in {"S", "W"} else number


def parse_hurdat_track(text: str, basin_id: str) -> list[list[Any]]:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        fields = [part.strip() for part in line.split(",")]
        if fields and fields[0] == basin_id:
            count = int(fields[2])
            track: list[list[Any]] = []
            for raw in lines[index + 1 : index + 1 + count]:
                row = [part.strip() for part in raw.split(",")]
                timestamp = datetime.strptime(row[0] + row[1], "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                status = STATUS_NAMES.get(row[3], row[3])
                pressure = int(row[7]) if int(row[7]) > 0 else None
                wind = int(row[6]) if int(row[6]) >= 0 else None
                track.append(
                    [
                        iso_utc(timestamp),
                        parse_coordinate(row[4]),
                        parse_coordinate(row[5]),
                        pressure,
                        wind,
                        status,
                        row[2] or None,
                    ]
                )
            return track
    raise ValueError(f"Storm {basin_id} was not found in HURDAT2")


def merge_station_config(base: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    merged = deepcopy(base)
    if override:
        for key, value in override.items():
            merged[key] = deepcopy(value)
    return merged


def rolling_median(values: list[float | None], width: int) -> list[float | None]:
    radius = width // 2
    minimum = max(1, math.ceil(width / 2))
    filtered: list[float | None] = []
    for index in range(len(values)):
        sample = [v for v in values[max(0, index - radius) : index + radius + 1] if v is not None]
        filtered.append(statistics.median(sample) if len(sample) >= minimum else None)
    return filtered


def first_true_run(flags: Iterable[bool], run_length: int, start_index: int = 0) -> int | None:
    run = 0
    for index, flag in enumerate(flags):
        if index < start_index:
            continue
        run = run + 1 if flag else 0
        if run >= run_length:
            return index - run_length + 1
    return None


def event_window(
    times: list[datetime],
    station_values: dict[str, list[list[float | None]]],
    landfall: datetime,
    settings: dict[str, Any],
    display_days_before: int,
    display_days_after: int,
    override: dict[str, Any] | None,
) -> dict[str, Any]:
    width = int(settings["rolling_median_hours"])
    departures = {
        station_id: rolling_median([row[2] for row in values], width)
        for station_id, values in station_values.items()
        if any(row[2] is not None for row in values)
    }
    onset_flags: list[bool] = []
    recovery_flags: list[bool] = []
    for index in range(len(times)):
        valid = [series[index] for series in departures.values() if series[index] is not None]
        onset_count = sum(value > settings["onset_threshold_ft"] for value in valid)
        near_count = sum(abs(value) <= settings["recovery_threshold_ft"] for value in valid)
        onset_flags.append(onset_count >= settings["onset_min_gauges"])
        recovery_flags.append(
            len(valid) >= settings["recovery_min_gauges"]
            and near_count >= settings["recovery_min_gauges"]
            and near_count / len(valid) >= settings["recovery_required_fraction"]
        )

    onset_index = first_true_run(onset_flags, int(settings["onset_consecutive_hours"]))
    landfall_index = min(range(len(times)), key=lambda i: abs(times[i] - landfall))
    recovery_index = first_true_run(
        recovery_flags,
        int(settings["recovery_consecutive_hours"]),
        start_index=max(landfall_index, (onset_index or 0)),
    )

    onset = times[onset_index] if onset_index is not None else None
    recovery = times[recovery_index] if recovery_index is not None else None
    default_start = floor_hour(landfall - timedelta(days=display_days_before))
    default_end = ceil_hour(landfall + timedelta(days=display_days_after))
    display_start = min(default_start, onset) if onset else default_start
    display_end = max(default_end, recovery + timedelta(hours=int(settings["recovery_consecutive_hours"]) - 1)) if recovery else times[-1]
    mode = "automatic"
    if recovery:
        reason = "Expanded from the default landfall ±5 day period when onset or the confirmed recovery period required it."
    else:
        reason = "No confirmed recovery occurred within the downloaded period, so the display extends through the end of that period."
    if override:
        display_start = parse_utc(override["start_utc"])
        display_end = parse_utc(override["end_utc"])
        mode = "configured_override"
        reason = override.get("reason", "Configured display-window override.")

    display_start = max(times[0], floor_hour(display_start))
    display_end = min(times[-1], ceil_hour(display_end))
    return {
        "method": mode,
        "description": "Event-analysis window based on water-level departures; it does not by itself attribute the departures exclusively to the storm.",
        "reason": reason,
        "automaticOnset": iso_utc(onset) if onset else None,
        "automaticRecovery": iso_utc(recovery) if recovery else None,
        "displayStart": iso_utc(display_start),
        "displayEnd": iso_utc(display_end),
        "thresholds": settings,
    }


def baseline_for_station(
    station: dict[str, Any],
    observations: dict[datetime, float],
    download_start: datetime,
) -> dict[str, Any]:
    baseline = deepcopy(station.get("baseline", {"method": "median_pre_event", "hours_from_download_start": 48}))
    if baseline["method"] == "fixed":
        baseline["value"] = rounded(float(baseline["value"]))
        return baseline
    hours = int(baseline.get("hours_from_download_start", 48))
    period_end = download_start + timedelta(hours=hours)
    sample = [value for timestamp, value in observations.items() if download_start <= timestamp < period_end]
    if not sample:
        raise ValueError(f"No observations available for baseline at station {station['id']}")
    baseline.update(
        {
            "method": "median_pre_event",
            "value": rounded(statistics.median(sample)),
            "periodStart": iso_utc(download_start),
            "periodEnd": iso_utc(period_end - timedelta(hours=1)),
            "sampleHours": len(sample),
            "label": f"median of first {hours} pre-event hours",
        }
    )
    return baseline


def build_storm(
    storm: dict[str, Any],
    common_stations: list[dict[str, Any]],
    defaults: dict[str, Any],
    downloader: Downloader,
) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    landfall = parse_utc(storm["landfall_time_utc"])
    before = int(storm.get("download_days_before", defaults["download_days_before"]))
    after = int(storm.get("download_days_after", defaults["download_days_after"]))
    download_start = floor_hour(landfall - timedelta(days=before))
    download_end = ceil_hour(landfall + timedelta(days=after))
    times = hourly_range(download_start, download_end)
    timestamp_set = set(times)

    hurdat_text = downloader.get_text(defaults["hurdat_url"])
    track = parse_hurdat_track(hurdat_text, storm["basin_id"])
    if not any(point[6] == "L" and abs(parse_utc(point[0]) - landfall) <= timedelta(minutes=5) for point in track):
        warnings.append("Configured landfall time does not match a HURDAT2 landfall point within five minutes.")

    station_order: list[str] = []
    stations: dict[str, Any] = {}
    raw_values: dict[str, list[list[float | None]]] = {}
    source_requests: list[str] = []
    overrides = storm.get("station_overrides", {})

    for common in common_stations:
        station = merge_station_config(common, overrides.get(common["id"]))
        station_id = station["id"]
        station_order.append(station_id)
        observations, metadata, observation_url, observation_error = coops_series(
            downloader, station, download_start, download_end, defaults["application"], "hourly_height"
        )
        source_requests.append(observation_url)
        if observation_error:
            warnings.append(f"{station_id} observations: {observation_error}")
        observations = {timestamp: value for timestamp, value in observations.items() if timestamp in timestamp_set}
        observation_digits = storm.get("observation_rounding_decimals")
        if observation_digits is not None:
            observations = {
                timestamp: round_like_javascript(value, int(observation_digits))
                for timestamp, value in observations.items()
            }

        predictions: dict[datetime, float] = {}
        prediction_error: str | None = None
        prediction_url: str | None = None
        if station.get("predictions", False):
            predictions, _, prediction_url, prediction_error = coops_series(
                downloader, station, download_start, download_end, defaults["application"], "predictions"
            )
            source_requests.append(prediction_url)
            predictions = {timestamp: value for timestamp, value in predictions.items() if timestamp in timestamp_set}
            if prediction_error:
                warnings.append(f"{station_id} predictions: {prediction_error}")

        baseline: dict[str, Any] | None = None
        if not station.get("predictions", False):
            try:
                baseline = baseline_for_station(station, observations, download_start)
            except ValueError as exc:
                warnings.append(str(exc))

        values: list[list[float | None]] = []
        for timestamp in times:
            observed = observations.get(timestamp)
            predicted = predictions.get(timestamp)
            if observed is None:
                departure = None
            elif station.get("predictions", False):
                departure = observed - predicted if predicted is not None else None
            else:
                departure = observed - baseline["value"] if baseline else None
            values.append([rounded(observed), rounded(predicted), rounded(departure)])

        observed_count = sum(row[0] is not None for row in values)
        prediction_count = sum(row[1] is not None for row in values)
        missing = len(times) - observed_count
        if missing:
            warnings.append(f"{station_id} is missing {missing} of {len(times)} hourly observations.")
        if station.get("predictions", False) and prediction_count != len(times):
            warnings.append(f"{station_id} is missing {len(times) - prediction_count} hourly predictions.")

        lat = finite_number(metadata.get("lat")) if metadata else None
        lon = finite_number(metadata.get("lon")) if metadata else None
        station_name = metadata.get("name", station["name"]) if metadata else station["name"]
        normal = "NOAA astronomical tide prediction" if station.get("predictions", False) else baseline.get("label", "pre-event baseline") if baseline else "unavailable"
        stations[station_id] = {
            "name": station_name,
            "lat": lat,
            "lon": lon,
            "datum": station["datum"],
            "normal": normal,
            "baseline": baseline,
            "predictionsAvailable": bool(station.get("predictions", False) and prediction_count),
            "available": observed_count > 0,
            "tooltipDirection": station.get("tooltip_direction", "auto"),
            "tooltipOffset": station.get("tooltip_offset", [0, 0]),
            "coverage": {
                "observationHours": observed_count,
                "predictionHours": prediction_count,
                "totalHours": len(times),
                "firstObservation": iso_utc(min(observations)) if observations else None,
                "lastObservation": iso_utc(max(observations)) if observations else None,
                "observationError": observation_error,
                "predictionError": prediction_error,
            },
            "values": values,
        }
        raw_values[station_id] = values

    settings = deepcopy(defaults["event_window"])
    settings.update(storm.get("event_window", {}))
    window = event_window(
        times,
        raw_values,
        landfall,
        settings,
        int(storm.get("display_days_before", defaults["display_days_before"])),
        int(storm.get("display_days_after", defaults["display_days_after"])),
        storm.get("display_window_override"),
    )

    dataset = {
        "schemaVersion": 1,
        "metadata": {
            "id": storm["id"],
            "name": storm["name"],
            "year": storm["year"],
            "basinId": storm["basin_id"],
            "displayTitle": storm["display_title"],
            "subtitle": storm["subtitle"],
            "defaultChartWindowHours": storm.get("default_chart_window_hours"),
            "landfallTime": iso_utc(landfall),
            "downloadStart": iso_utc(times[0]),
            "downloadEnd": iso_utc(times[-1]),
            "localTimezone": storm["local_timezone"],
            "mapBounds": storm["map_bounds"],
            "generated": date.today().isoformat(),
            "eventWindow": window,
            "sources": {
                "water": "NOAA CO-OPS verified hourly heights",
                "predictions": "NOAA CO-OPS astronomical tide predictions",
                "track": "NHC HURDAT2 official best track",
                "coopsApi": "https://api.tidesandcurrents.noaa.gov/api/prod/",
                "hurdat": defaults["hurdat_url"],
                **storm.get("sources", {}),
            },
            "sourceRequests": source_requests,
            "warnings": warnings,
        },
        "times": [iso_utc(timestamp) for timestamp in times],
        "stationOrder": station_order,
        "stations": stations,
        "track": track,
    }
    return dataset, warnings


def write_dataset(dataset: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    storm_id = dataset["metadata"]["id"]
    path = output_dir / f"{storm_id}.js"
    encoded = json.dumps(dataset, separators=(",", ":"), ensure_ascii=False)
    path.write_text(
        "// Generated by scripts/build_storm_data.py; do not edit by hand.\n"
        "window.STORM_DATASETS = window.STORM_DATASETS || {};\n"
        f"window.STORM_DATASETS[{json.dumps(storm_id)}] = {encoded};\n",
        encoding="utf-8",
    )
    return path


def validate_dataset(dataset: dict[str, Any]) -> None:
    length = len(dataset["times"])
    if length < 2:
        raise ValueError("Timeline must contain at least two hours")
    for station_id in dataset["stationOrder"]:
        values = dataset["stations"][station_id]["values"]
        if len(values) != length:
            raise ValueError(f"{station_id} has {len(values)} rows for a {length}-hour timeline")
    if not dataset["track"]:
        raise ValueError("Best track is empty")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--storm", default="all", help="Storm ID from storms.json, or 'all'")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--offline", action="store_true", help="Use cached source responses only")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    storms = config["storms"]
    if args.storm != "all":
        storms = [storm for storm in storms if storm["id"] == args.storm]
        if not storms:
            print(f"Unknown storm ID: {args.storm}", file=sys.stderr)
            return 2

    downloader = Downloader(args.cache_dir, offline=args.offline)
    for storm in storms:
        print(f"Building {storm['id']}…")
        dataset, warnings = build_storm(storm, config["stations"], config["defaults"], downloader)
        validate_dataset(dataset)
        path = write_dataset(dataset, args.output_dir)
        window = dataset["metadata"]["eventWindow"]
        print(f"  wrote {path.relative_to(ROOT)} ({len(dataset['times'])} downloaded hours)")
        print(f"  display window: {window['displayStart']} to {window['displayEnd']} ({window['method']})")
        for warning in warnings:
            print(f"  WARNING: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
