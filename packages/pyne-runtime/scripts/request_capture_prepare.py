"""Prepare TradingView Pine scripts and a capture manifest for request fixtures."""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
from pathlib import Path
from typing import Any

from request_capture_status import DEFAULT_GOLDEN_DIR, PRIORITY_FIXTURES, REQUEST_FIXTURE_GLOB


CAPTURE_INDEX_TITLE = "Pyne Capture Index"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Write Pine scripts and a manifest for TradingView request capture.",
    )
    parser.add_argument("--golden-dir", type=Path, default=DEFAULT_GOLDEN_DIR)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--fixture", action="append", default=[])
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args(argv)

    if args.clean and args.out_dir.exists():
        ensure_safe_clean_target(args.out_dir, args.golden_dir)
        shutil.rmtree(args.out_dir)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    entries = prepare_capture_files(
        golden_dir=args.golden_dir,
        out_dir=args.out_dir,
        include_all=args.all,
        fixture_filter=set(args.fixture),
    )
    manifest = {
        "capture_type": "request",
        "default_scope": "all" if args.all else "priority",
        "fixture_count": len(entries),
        "entries": entries,
    }
    (args.out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.out_dir / "README.md").write_text(render_readme(entries), encoding="utf-8")
    print(f"prepared {len(entries)} request capture script(s) in {args.out_dir}")
    return 0


def prepare_capture_files(
    *,
    golden_dir: Path,
    out_dir: Path,
    include_all: bool,
    fixture_filter: set[str],
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for fixture_path in sorted(golden_dir.glob(REQUEST_FIXTURE_GLOB), key=fixture_sort_key):
        if fixture_filter and fixture_path.name not in fixture_filter:
            continue
        if not fixture_filter and not include_all and fixture_path.name not in PRIORITY_FIXTURES:
            continue
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        entry = build_entry(fixture_path, fixture, len(entries) + 1)
        (out_dir / entry["pine_file"]).write_text(
            str(fixture["pine_script"]).rstrip() + "\n",
            encoding="utf-8",
        )
        write_bars_csv(out_dir / entry["bars_file"], fixture.get("chart_bars", []))
        entries.append(entry)
    return entries


def build_entry(fixture_path: Path, fixture: dict[str, Any], index: int) -> dict[str, Any]:
    fixture_name = fixture_path.name
    capture = fixture.get("external_capture", {})
    diff_assertion = capture_diff_assertion(capture)
    pine_file = f"{index:02d}_{slugify(fixture_path.stem)}.pine"
    bars_file = f"{Path(pine_file).stem}_bars.csv"
    export_file = f"{Path(pine_file).stem}.csv"
    return {
        "fixture": fixture_name,
        "name": fixture.get("name", fixture_path.stem),
        "priority": fixture_name in PRIORITY_FIXTURES,
        "status": capture.get("status", "missing"),
        "pine_file": pine_file,
        "bars_file": bars_file,
        "expected_export_file": export_file,
        "time_alignment_required": False,
        "bar_count": len(fixture.get("chart_bars", [])),
        "plot_titles": list(fixture.get("expected_series", {})),
        "capture_index_title": CAPTURE_INDEX_TITLE,
        "import_command": (
            "python scripts/request_capture_import.py "
            f"tests/golden/{fixture_name} "
            f"--values <export-dir>/{export_file} "
            f"--tolerance 1e-9 --assertion {diff_assertion} "
            '--note "TradingView export YYYY-MM-DD"'
        ),
        "diff_command": (
            "python scripts/request_capture_diff.py "
            f"--assertion {diff_assertion} tests/golden/{fixture_name}"
        ),
    }


def capture_diff_assertion(capture: dict[str, Any]) -> str:
    if capture.get("status") == "captured":
        return capture.get("assertion", "parity")
    if capture.get("assertion") in {"parity", "reference"}:
        return capture["assertion"]
    return "reference"


def write_bars_csv(path: Path, bars: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["time", "open", "high", "low", "close", "volume"],
        )
        writer.writeheader()
        for bar in bars:
            writer.writerow(
                {
                    "time": bar["time"],
                    "open": bar["open"],
                    "high": bar["high"],
                    "low": bar["low"],
                    "close": bar["close"],
                    "volume": bar.get("volume", 0.0),
                }
            )


def render_readme(entries: list[dict[str, Any]]) -> str:
    lines = [
        "# TradingView Request Capture Export Pack",
        "",
        "Copy each `.pine` file into TradingView Pine Editor, export the declared plots,",
        "then import the CSV back into the matching request golden fixture.",
        "",
        f"Keep the `{CAPTURE_INDEX_TITLE}` plot in the export.",
        "",
        "## Fixtures",
        "",
        "| # | Fixture | Pine file | Bars file | Plots | Bars |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for index, entry in enumerate(entries, start=1):
        plots = ", ".join(f"`{title}`" for title in entry["plot_titles"])
        lines.append(
            f"| {index} | `{entry['fixture']}` | `{entry['pine_file']}` | "
            f"`{entry['bars_file']}` | {plots} | {entry['bar_count']} |"
        )
    lines.extend(
        [
            "",
            "## Next Task",
            "",
            "```powershell",
            "python scripts/request_capture_next.py --manifest <pack-dir>/manifest.json",
            "python scripts/request_capture_next.py --manifest <pack-dir>/manifest.json --json",
            "```",
            "",
        ]
    )
    return "\n".join(lines)


def ensure_safe_clean_target(out_dir: Path, golden_dir: Path) -> None:
    resolved_out = out_dir.resolve()
    resolved_golden = golden_dir.resolve()
    if resolved_out == resolved_golden or resolved_golden in resolved_out.parents:
        raise SystemExit(f"refusing to clean golden fixture directory: {out_dir}")


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return slug or "capture"


def fixture_sort_key(path: Path) -> tuple[int, str]:
    try:
        priority = PRIORITY_FIXTURES.index(path.name)
    except ValueError:
        priority = len(PRIORITY_FIXTURES)
    return priority, path.name


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
