#!/usr/bin/env python3
"""Idempotently add Shell Beach NOAA and French Settlement USGS support.

This migration is executed by the storm-data workflow before datasets are built.
It patches the active configuration, builder, viewer labels, and source-aware popup
text without changing any existing storm timelines or observations.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "scripts" / "storms.json"
BUILDER = ROOT / "scripts" / "build_storm_data.py"
APP = ROOT / "app.js"
INDEX = ROOT / "index.html"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"Could not locate expected {label} block")
    return text.replace(old, new, 1)


def patch_config() -> None:
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    stations = config["stations"]
    existing = {station["id"] for station in stations}
    additions = [
        {
            "id": "8761305",
            "name": "Shell Beach",
            "source": "coops",
            "datum": "MHHW",
            "predictions": True,
            "tooltip_direction": "left",
            "tooltip_offset": [-12, 0],
        },
        {
            "id": "07380200",
            "name": "Amite River near French Settlement",
            "source": "usgs",
            "parameter_code": "00065",
            "datum": "Gage height",
            "predictions": False,
            "baseline": {"method": "median_pre_event", "hours_from_download_start": 48},
            "latitude": 30.2754733015704,
            "longitude": -90.779261561707,
            "tooltip_direction": "left",
            "tooltip_offset": [-12, 0],
        },
    ]
    for station in additions:
        if station["id"] not in existing:
            stations.append(station)
    CONFIG.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def patch_builder() -> None:
    text = BUILDER.read_text(encoding="utf-8")
    text = replace_once(
        text,
        'COOPS_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"\n',
        'COOPS_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"\nUSGS_IV_URL = "https://waterservices.usgs.gov/nwis/iv/"\n',
        "USGS endpoint",
    )

    usgs_functions = '''\n\ndef usgs_series(\n    downloader: Downloader,\n    station: dict[str, Any],\n    start: datetime,\n    end: datetime,\n) -> tuple[dict[datetime, float], dict[str, Any] | None, str, str | None]:\n    params = {\n        "format": "json",\n        "sites": station["id"],\n        "parameterCd": station.get("parameter_code", "00065"),\n        "startDT": iso_utc(start),\n        "endDT": iso_utc(end),\n        "siteStatus": "all",\n    }\n    url = f"{USGS_IV_URL}?{urllib.parse.urlencode(params)}"\n    try:\n        payload = downloader.get_json(url)\n    except Exception as exc:\n        return {}, None, url, str(exc)\n    series_list = payload.get("value", {}).get("timeSeries", [])\n    if not series_list:\n        return {}, None, url, "No USGS instantaneous-value time series returned"\n    selected = None\n    parameter_code = station.get("parameter_code", "00065")\n    for series in series_list:\n        codes = [item.get("value") for item in series.get("variable", {}).get("variableCode", [])]\n        if parameter_code in codes:\n            selected = series\n            break\n    selected = selected or series_list[0]\n    result: dict[datetime, float] = {}\n    for block in selected.get("values", []):\n        for row in block.get("value", []):\n            value = finite_number(row.get("value"))\n            if value is None:\n                continue\n            timestamp = datetime.fromisoformat(row["dateTime"].replace("Z", "+00:00")).astimezone(timezone.utc)\n            result[timestamp] = value\n    source_info = selected.get("sourceInfo", {})\n    geo = source_info.get("geoLocation", {}).get("geogLocation", {})\n    metadata = {\n        "name": source_info.get("siteName", station["name"]),\n        "lat": geo.get("latitude", station.get("latitude")),\n        "lon": geo.get("longitude", station.get("longitude")),\n    }\n    return result, metadata, url, None\n\n\ndef align_nearest_series(\n    observations: dict[datetime, float],\n    targets: list[datetime],\n    tolerance_minutes: int = 8,\n) -> dict[datetime, float]:\n    if not observations:\n        return {}\n    source_times = sorted(observations)\n    aligned: dict[datetime, float] = {}\n    cursor = 0\n    tolerance = timedelta(minutes=tolerance_minutes)\n    for target in targets:\n        while cursor + 1 < len(source_times) and source_times[cursor + 1] <= target:\n            cursor += 1\n        candidates = [source_times[cursor]]\n        if cursor + 1 < len(source_times):\n            candidates.append(source_times[cursor + 1])\n        nearest = min(candidates, key=lambda item: abs(item - target))\n        if abs(nearest - target) <= tolerance:\n            aligned[target] = observations[nearest]\n    return aligned\n'''
    marker = '\n\ndef parse_coordinate(value: str) -> float:\n'
    if 'def usgs_series(' not in text:
        if marker not in text:
            raise RuntimeError("Could not locate builder insertion point")
        text = text.replace(marker, usgs_functions + marker, 1)

    old_download = '''        observations, metadata, observation_url, observation_error = coops_series(\n            downloader, station, download_start, download_end, defaults["application"], "water_level"\n        )\n        source_requests.append(observation_url)\n        observation_product = "water_level"\n        if observation_error or not observations:\n            fallback, fallback_metadata, fallback_url, fallback_error = coops_series(\n                downloader, station, download_start, download_end, defaults["application"], "hourly_height"\n            )\n            source_requests.append(fallback_url)\n            if fallback:\n                observations = fallback\n                metadata = fallback_metadata or metadata\n                observation_error = None\n                observation_product = "hourly_height"\n                warnings.append(f"{station_id} has no usable 6-minute water levels; using verified hourly heights.")\n            else:\n                observation_error = observation_error or fallback_error\n        if observation_error:\n            warnings.append(f"{station_id} observations: {observation_error}")\n        observations = {timestamp: value for timestamp, value in observations.items() if timestamp in timestamp_set}\n'''
    new_download = '''        station_source = station.get("source", "coops")\n        if station_source == "usgs":\n            observations, metadata, observation_url, observation_error = usgs_series(\n                downloader, station, download_start, download_end\n            )\n            source_requests.append(observation_url)\n            observation_product = f"usgs_iv_{station.get('parameter_code', '00065')}"\n            observations = align_nearest_series(observations, times)\n        else:\n            observations, metadata, observation_url, observation_error = coops_series(\n                downloader, station, download_start, download_end, defaults["application"], "water_level"\n            )\n            source_requests.append(observation_url)\n            observation_product = "water_level"\n            if observation_error or not observations:\n                fallback, fallback_metadata, fallback_url, fallback_error = coops_series(\n                    downloader, station, download_start, download_end, defaults["application"], "hourly_height"\n                )\n                source_requests.append(fallback_url)\n                if fallback:\n                    observations = fallback\n                    metadata = fallback_metadata or metadata\n                    observation_error = None\n                    observation_product = "hourly_height"\n                    warnings.append(f"{station_id} has no usable 6-minute water levels; using verified hourly heights.")\n                else:\n                    observation_error = observation_error or fallback_error\n            observations = {timestamp: value for timestamp, value in observations.items() if timestamp in timestamp_set}\n        if observation_error:\n            warnings.append(f"{station_id} observations: {observation_error}")\n'''
    text = replace_once(text, old_download, new_download, "source-aware observation download")

    text = replace_once(
        text,
        '        if station.get("predictions", False):\n',
        '        if station.get("predictions", False) and station_source == "coops":\n',
        "prediction source guard",
    )
    text = replace_once(
        text,
        '            "name": station_name,\n            "lat": lat,\n',
        '            "name": station_name,\n            "source": station_source,\n            "lat": lat if lat is not None else finite_number(station.get("latitude")),\n',
        "station source metadata",
    )
    text = replace_once(
        text,
        '            "lon": lon,\n',
        '            "lon": lon if lon is not None else finite_number(station.get("longitude")),\n',
        "station longitude fallback",
    )
    text = replace_once(
        text,
        '                "coopsApi": "https://api.tidesandcurrents.noaa.gov/api/prod/",\n',
        '                "coopsApi": "https://api.tidesandcurrents.noaa.gov/api/prod/",\n                "usgsIvApi": "https://waterservices.usgs.gov/nwis/iv/",\n',
        "USGS source metadata",
    )
    BUILDER.write_text(text, encoding="utf-8")


def patch_viewer() -> None:
    app = APP.read_text(encoding="utf-8")
    app = app.replace(
        '<br><small>NOAA station ${id}</small>',
        '<br><small>${station.source === "usgs" ? "USGS site" : "NOAA station"} ${id}</small>',
    )
    APP.write_text(app, encoding="utf-8")

    index = INDEX.read_text(encoding="utf-8")
    index = index.replace('<span>NOAA verified</span>', '<span>Official observations</span>')
    index = index.replace('<span>Verified height (ft)</span>', '<span>Observed height (ft)</span>')
    index = index.replace('<option value="observed">Verified height</option>', '<option value="observed">Observed height</option>')
    INDEX.write_text(index, encoding="utf-8")


def main() -> None:
    patch_config()
    patch_builder()
    patch_viewer()
    print("Shell Beach and French Settlement support is active.")


if __name__ == "__main__":
    main()
