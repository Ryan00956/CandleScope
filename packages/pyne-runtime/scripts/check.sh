#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PYTHON="${PYTHON:-python}"
DIST="${TMPDIR:-/tmp}/pyne-runtime-dist-check"

cd "$ROOT"
"$PYTHON" -m ruff check .
"$PYTHON" -m pytest
rm -rf "$DIST"
"$PYTHON" -m build --outdir "$DIST"
"$PYTHON" -m twine check "$DIST"/*
