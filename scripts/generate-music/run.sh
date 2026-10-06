#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VENV="$ROOT/scripts/generate-music/.venv"
PY="$VENV/bin/python"
REQ="$ROOT/scripts/generate-music/requirements.txt"
STAMP="$VENV/.requirements-stamp"

if [ ! -x "$PY" ]; then
  PYTHON=""
  if command -v python3.12 >/dev/null 2>&1; then
    PYTHON="$(command -v python3.12)"
  elif [ -x /opt/homebrew/bin/python3.12 ]; then
    PYTHON="/opt/homebrew/bin/python3.12"
  fi
  if [ -z "$PYTHON" ]; then
    echo "Python 3.12 is required. Install it with: brew install python@3.12" >&2
    exit 1
  fi
  "$PYTHON" -m venv "$VENV"
fi

if [ ! -f "$STAMP" ] || [ "$REQ" -nt "$STAMP" ]; then
  "$PY" -m pip install --upgrade pip
  "$PY" -m pip install -r "$REQ"
  touch "$STAMP"
fi

export HF_HOME="$ROOT/scripts/generate-music/.cache/huggingface"
export PYTORCH_ENABLE_MPS_FALLBACK=1
export PYTHONUNBUFFERED=1
exec "$PY" "$ROOT/scripts/generate-music/generate.py" "$@"
