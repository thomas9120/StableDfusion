#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

APP_NAME="StableDfusion"
HOST=${SD_GUI_HOST:-127.0.0.1}
PORT=${SD_GUI_PORT:-5250}
URL="http://$HOST:$PORT"

if [ -x ".venv/bin/python" ]; then
	PYTHON_EXE=".venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
	PYTHON_EXE="python3"
elif command -v python >/dev/null 2>&1; then
	PYTHON_EXE="python"
else
	echo "ERROR: Python was not found. Run ./install.sh first or install Python 3.11+."
	exit 1
fi

echo
echo "Starting $APP_NAME..."
echo "URL: $URL"
echo

if command -v open >/dev/null 2>&1; then
	open "$URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
	xdg-open "$URL" >/dev/null 2>&1 || true
else
	echo "Open $URL in your browser."
fi

"$PYTHON_EXE" server.py
