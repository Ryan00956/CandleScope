#!/usr/bin/env bash
# POSIX entrypoint for the live FastAPI process on Linux/macOS.
# Watch mode uses watchfiles (not uvicorn --reload) so sidecar shutdown
# still runs before the next process starts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WATCH=0

usage() {
  cat <<'EOF'
Usage: ./dev-server.sh [--watch]

Start the CandleScope backend on 127.0.0.1:18080.
Requires backend/.venv (bin/python on Unix).
EOF
}

for argument in "$@"; do
  case "$argument" in
    --watch|-w)
      WATCH=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON="$ROOT/.venv/bin/python"
elif [[ -x "$ROOT/.venv/Scripts/python.exe" ]]; then
  PYTHON="$ROOT/.venv/Scripts/python.exe"
else
  echo "CandleScope backend virtual environment is missing: $ROOT/.venv" >&2
  echo "Create it with: python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt" >&2
  exit 1
fi

export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1
cd "$ROOT"

if [[ "$WATCH" -eq 1 ]]; then
  echo "[dev] Watching $ROOT/app for Python changes; restart with Ctrl+C."
  exec "$PYTHON" -m watchfiles \
    --filter python \
    --sigint-timeout 20 \
    --target-type command \
    "$PYTHON -m uvicorn app.main:app --host 127.0.0.1 --port 18080" \
    "$ROOT/app"
fi

exec "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 18080
