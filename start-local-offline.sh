#!/usr/bin/env bash
# POSIX counterpart of start-local-offline.ps1.
# Listens on loopback only. Ctrl+C stops both processes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$ROOT/backend/data/local-data"
BACKEND_PORT=18080
FRONTEND_PORT=15173
NO_BROWSER=0
BACKEND_PID=""
FRONTEND_PID=""

usage() {
  cat <<'EOF'
Usage: ./start-local-offline.sh [options]

  --data-dir DIR         Local analysis directory (default: backend/data/local-data)
  --backend-port PORT    Backend port (default: 18080)
  --frontend-port PORT   Vite port (default: 15173)
  --no-browser           Do not open the local analysis page
  --help                 Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      DATA_DIR="${2:-}"
      shift 2
      ;;
    --backend-port)
      BACKEND_PORT="${2:-}"
      shift 2
      ;;
    --frontend-port)
      FRONTEND_PORT="${2:-}"
      shift 2
      ;;
    --no-browser)
      NO_BROWSER=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -x "$ROOT/backend/.venv/bin/python" ]]; then
  PYTHON="$ROOT/backend/.venv/bin/python"
elif [[ -x "$ROOT/backend/.venv/Scripts/python.exe" ]]; then
  PYTHON="$ROOT/backend/.venv/Scripts/python.exe"
else
  echo "Backend Python is missing: $ROOT/backend/.venv" >&2
  echo "Create it with: cd backend && python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt" >&2
  exit 1
fi

VITE_ENTRY="$ROOT/frontend/node_modules/vite/bin/vite.js"
if [[ ! -f "$VITE_ENTRY" ]]; then
  echo "Frontend dependencies are missing. Run npm install in $ROOT/frontend" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

export CANDLESCOPE_RUNTIME_MODE=LOCAL_OFFLINE
export CANDLESCOPE_LOCAL_DATA_DIR="$DATA_DIR"
export VITE_API_PROXY_TARGET="http://127.0.0.1:$BACKEND_PORT"
export VITE_DEV_PORT="$FRONTEND_PORT"
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

cleanup() {
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

(
  cd "$ROOT/backend"
  exec "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT"
) &
BACKEND_PID=$!

(
  cd "$ROOT/frontend"
  exec node "$VITE_ENTRY" --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort
) &
FRONTEND_PID=$!

HEALTH_URL="http://127.0.0.1:$BACKEND_PORT/health"
PAGE_URL="http://127.0.0.1:$FRONTEND_PORT/local.html"
SECONDS=0
READY=0
while [[ "$SECONDS" -lt 30 ]]; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "The LOCAL_OFFLINE backend exited before becoming ready." >&2
    exit 1
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "The local frontend exited before becoming ready." >&2
    exit 1
  fi
  if "$PYTHON" - "$HEALTH_URL" <<'PY'
import json
import sys
import urllib.error
import urllib.request

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=2) as response:
        payload = json.load(response)
except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
    sys.exit(1)
sys.exit(0 if payload.get("runtime_mode") == "LOCAL_OFFLINE" else 1)
PY
  then
    READY=1
    break
  fi
  sleep 0.25
done

if [[ "$READY" -ne 1 ]]; then
  echo "LOCAL_OFFLINE backend did not become ready within 30 seconds." >&2
  exit 1
fi

echo "CandleScope LOCAL_OFFLINE is ready: $PAGE_URL"
echo "Data directory: $DATA_DIR"
echo "Press Ctrl+C to stop both local processes."

if [[ "$NO_BROWSER" -eq 0 ]]; then
  if command -v open >/dev/null 2>&1; then
    open "$PAGE_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$PAGE_URL" >/dev/null 2>&1 || true
  fi
fi

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 0.5
done

if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "The LOCAL_OFFLINE backend stopped unexpectedly." >&2
  exit 1
fi
echo "The local frontend stopped unexpectedly." >&2
exit 1
