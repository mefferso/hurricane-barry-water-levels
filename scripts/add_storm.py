#!/usr/bin/env python3
"""Add a Gulf Coast storm to storms.json from a simple name/year input.

Example:
    python3 scripts/add_storm.py "Katrina 2005"

The script resolves the official Atlantic basin ID and relevant landfall point
from NHC HURDAT2, then appends a standard project configuration entry. It is
intentionally conservative: if no HURDAT2 landfall falls inside the configured
northern Gulf Coast box, it stops instead of guessing.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = Path(__file__).with_name("storms.json")
DEFAULT_BOUNDS = [[26.0, -93.5], [32.0, -87.0]]

# Include the upper Texas coast because storms making landfall near Galveston
# can still produce important water-level impacts across Louisiana and
# Mississippi. The previous -93.5 western limit incorrectly rejected Ike.
LANDFALL_BOX = {"south": 27.0, "north": 31.5, "west": -95.5, "east": -87.0}


def parse_request(value: str) -> tuple[str, int]:
    match = re.fullmatch(r"\s*(.+?)\s+(\d{4})\s*", value)
    if not match:
        raise ValueError('Enter the storm name and four-digit year, for example "Katrina 2005".')
    return match.group(1).strip(), int(match.group(2))


def slugify(name: str, year: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not slug:
        raise ValueError("Storm name did not produce a valid ID.")
    return f"{slug}-{year}"


def parse_coord(value: str) -> float:
    direction = value[-1]
    number = float(value[:-1])
    return -number if direction in {"S", "W"} else number


def fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "LIXHistoricalWaterViewer/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read().decode("utf-8", errors="replace")


def find_storm(text: str, requested_name: str, year: int) -> tuple[str, str, list[list[str]]]:
    lines = text.splitlines()
    wanted = requested_name.upper().replace("HURRICANE ", "").replace("TROPICAL STORM ", "").strip()
    matches: list[tuple[str, str, list[list[str]]]] = []
    for index, line in enumerate(lines):
        fields = [part.strip() for part in line.split(",")]
        if len(fields) < 3 or not re.fullmatch(r"AL\d{2}\d{4}", fields[0]):
            continue
        basin_id, official_name, count_text = fields[:3]
        if int(basin_id[-4:]) != year or official_name.upper() != wanted:
            continue
        count = int(count_text)
        rows = [[part.strip() for part in raw.split(",")] for raw in lines[index + 1 : index + 1 + count]]
        matches.append((basin_id, official_name.title(), rows))
    if not matches:
        raise ValueError(f"No Atlantic HURDAT2 storm matched {requested_name!r} in {year}.")
    if len(matches) > 1:
        ids = ", ".join(item[0] for item in matches)
        raise ValueError(f"Multiple HURDAT2 storms matched; basin IDs: {ids}")
    return matches[0]


def relevant_landfalls(rows: list[list[str]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for row in rows:
        if len(row) < 8 or row[2] != "L":
            continue
        timestamp = datetime.strptime(row[0] + row[1], "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        lat = parse_coord(row[4])
        lon = parse_coord(row[5])
        if (
            LANDFALL_BOX["south"] <= lat <= LANDFALL_BOX["north"]
            and LANDFALL_BOX["west"] <= lon <= LANDFALL_BOX["east"]
        ):
            candidates.append(
                {
                    "time": timestamp,
                    "lat": lat,
                    "lon": lon,
                    "status": row[3],
                    "wind": int(row[6]),
                }
            )
    return sorted(candidates, key=lambda item: item["time"])


def display_type(rows: list[list[str]]) -> str:
    max_wind = max((int(row[6]) for row in rows if len(row) > 6 and row[6].lstrip("-").isdigit()), default=0)
    if max_wind >= 64:
        return "Hurricane"
    if max_wind >= 34:
        return "Tropical Storm"
    return "Tropical Depression"


def subtitle_for(landfall: datetime) -> str:
    start = landfall - timedelta(days=7)
    end = landfall + timedelta(days=7)
    if start.month == end.month:
        period = start.strftime("%B %Y")
    else:
        period = f"{start.strftime('%B')}–{end.strftime('%B %Y')}"
    return f"Historical event reconstruction · {period}"


def add_storm(config_path: Path, request: str) -> tuple[str, bool, dict[str, Any]]:
    requested_name, year = parse_request(request)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    hurdat_url = config["defaults"]["hurdat_url"]
    basin_id, official_name, rows = find_storm(fetch_text(hurdat_url), requested_name, year)
    storm_id = slugify(official_name, year)

    existing = next((storm for storm in config["storms"] if storm["id"] == storm_id), None)
    if existing:
        return storm_id, False, existing

    landfalls = relevant_landfalls(rows)
    if not landfalls:
        all_landfalls = []
        for row in rows:
            if len(row) >= 6 and row[2] == "L":
                all_landfalls.append(f"{row[0]} {row[1]} at {row[4]}, {row[5]}")
        detail = "; ".join(all_landfalls) if all_landfalls else "no HURDAT2 landfall records"
        raise ValueError(
            "No northern Gulf Coast-area HURDAT2 landfall was found. "
            f"Available landfalls: {detail}. Add this storm manually if it is still relevant."
        )

    primary = landfalls[0]
    title = display_type(rows)
    entry = {
        "id": storm_id,
        "name": official_name,
        "year": year,
        "basin_id": basin_id,
        "display_title": f"{title} {official_name}",
        "subtitle": subtitle_for(primary["time"]),
        "default_chart_window_hours": 120,
        "landfall_time_utc": primary["time"].isoformat(timespec="seconds").replace("+00:00", "Z"),
        "local_timezone": "America/Chicago",
        "map_bounds": DEFAULT_BOUNDS,
        "sources": {
            "hurdat_storm": f"{hurdat_url}#{basin_id}",
            "auto_configuration": "Storm identity and primary regional landfall selected from NHC HURDAT2.",
        },
        "auto_selected_landfall": {
            "latitude": primary["lat"],
            "longitude": primary["lon"],
            "available_regional_landfalls": [
                {
                    "time_utc": item["time"].isoformat(timespec="seconds").replace("+00:00", "Z"),
                    "latitude": item["lat"],
                    "longitude": item["lon"],
                    "wind_kt": item["wind"],
                }
                for item in landfalls
            ],
        },
    }
    config["storms"].append(entry)
    config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return storm_id, True, entry


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("storm", help='Storm name and year, such as "Katrina 2005"')
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    try:
        storm_id, created, entry = add_storm(args.config, args.storm)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    action = "Added" if created else "Already configured"
    print(f"{action}: {entry['display_title']} ({entry['basin_id']})", file=sys.stderr)
    print(f"Primary regional landfall: {entry['landfall_time_utc']}", file=sys.stderr)
    print(storm_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
