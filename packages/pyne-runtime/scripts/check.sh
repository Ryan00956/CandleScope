#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -z "${PYTHON:-}" ]; then
  if [ -x "$ROOT/.venv/bin/python" ]; then
    PYTHON="$ROOT/.venv/bin/python"
  elif [ -f "$ROOT/.venv/Scripts/python.exe" ]; then
    PYTHON="$ROOT/.venv/Scripts/python.exe"
  else
    PYTHON="python"
  fi
fi
CHECK_TMP="${PYNE_CHECK_TMP:-$ROOT/.pyne-check-tmp}"
PYTEST_TMP="$CHECK_TMP/pytest"
DIST="$CHECK_TMP/dist"

cd "$ROOT"
rm -rf "$CHECK_TMP"
mkdir -p "$PYTEST_TMP"
export TMPDIR="$CHECK_TMP"
"$PYTHON" -m ruff check .
"$PYTHON" -m pytest -p no:cacheprovider --basetemp "$PYTEST_TMP/run"
"$PYTHON" scripts/strategy_capture_scaffold.py --check
"$PYTHON" scripts/strategy_capture_diff.py --assertion parity
"$PYTHON" scripts/ta_capture_diff.py --assertion parity
"$PYTHON" scripts/request_capture_diff.py --assertion parity
"$PYTHON" -m build --no-isolation --outdir "$DIST"
"$PYTHON" -m twine check "$DIST"/*
"$PYTHON" scripts/package_smoke.py --dist-dir "$DIST" --offline
