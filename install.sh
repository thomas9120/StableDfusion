#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

APP_NAME="StableDfusion"

echo
echo "$APP_NAME macOS/Linux installer"
echo "================================"
echo

if command -v python3 >/dev/null 2>&1; then
	PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
	PY_CMD="python"
else
	echo "ERROR: Python was not found. Install Python 3.11+ and try again."
	exit 1
fi

"$PY_CMD" - <<'PY'
import sys

if sys.version_info < (3, 11):
    raise SystemExit("ERROR: Python 3.11+ is required.")
PY

if [ ! -x ".venv/bin/python" ]; then
	echo "Creating local Python environment in .venv..."
	"$PY_CMD" -m venv .venv
fi

echo "Upgrading pip..."
".venv/bin/python" -m pip install --upgrade pip

echo "Installing Python dependencies..."
".venv/bin/python" -m pip install -r requirements.txt

if command -v npm >/dev/null 2>&1; then
	echo "Installing frontend test dependencies..."
	npm install
else
	echo "npm was not found; skipping optional frontend test dependencies."
fi

echo
echo "Install complete."
echo "Run ./start.sh to launch $APP_NAME."
echo
