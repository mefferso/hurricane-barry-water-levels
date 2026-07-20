#!/usr/bin/env python3
"""Synchronize the browser storm catalog and dataset script tags from storms.json.

The NOAA/NHC data builder writes one JavaScript dataset per storm. This helper
removes the remaining hand-editing step: it rebuilds ``data/storms.js`` and the
storm-data script block in ``index.html`` from the same configuration file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = Path(__file__).with_name("storms.json")
DEFAULT_CATALOG = ROOT / "data" / "storms.js"
DEFAULT_INDEX = ROOT / "index.html"
START_MARKER = "  <!-- STORM_DATA_SCRIPTS_START -->"
END_MARKER = "  <!-- STORM_DATA_SCRIPTS_END -->"


def browser_catalog(config: dict[str, Any]) -> list[dict[str, Any]]:
    storms = sorted(
        config["storms"],
        key=lambda storm: (-int(storm["year"]), storm["display_title"])
    )

    return [
        {
            "id": storm["id"],
            "name": storm["display_title"],
            "year": storm["year"],
            "defaultChartWindowHours": storm.get("default_chart_window_hours"),
            "dataFile": f"data/{storm['id']}.js",
        }
        for storm in storms
    ]


def config_version(config_path: Path) -> str:
    return hashlib.sha256(config_path.read_bytes()).hexdigest()[:10]


def write_catalog(catalog_path: Path, entries: list[dict[str, Any]]) -> None:
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(entries, indent=2, ensure_ascii=False)
    catalog_path.write_text(f"window.STORM_CATALOG = {payload};\n", encoding="utf-8")


def update_index(index_path: Path, entries: list[dict[str, Any]], version: str) -> None:
    html = index_path.read_text(encoding="utf-8")
    if START_MARKER not in html or END_MARKER not in html:
        raise ValueError(
            f"{index_path} is missing the generated storm script markers: "
            f"{START_MARKER.strip()} and {END_MARKER.strip()}"
        )

    script_lines = [
        START_MARKER,
        f'  <script src="data/storms.js?v={version}"></script>',
        *[
            f'  <script src="{entry["dataFile"]}?v={version}"></script>'
            for entry in entries
        ],
        END_MARKER,
    ]
    start = html.index(START_MARKER)
    end = html.index(END_MARKER, start) + len(END_MARKER)
    updated = html[:start] + "\n".join(script_lines) + html[end:]
    index_path.write_text(updated, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    entries = browser_catalog(config)
    version = config_version(args.config)
    write_catalog(args.catalog, entries)
    update_index(args.index, entries, version)
    print(f"Wrote {args.catalog.relative_to(ROOT)} with {len(entries)} storms")
    print(f"Updated {args.index.relative_to(ROOT)} storm scripts (cache version {version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
