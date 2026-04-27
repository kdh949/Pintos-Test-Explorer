#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TARGET="$ROOT_DIR/tools/pintos-test-explorer/bundled/pintos-gdb-server.sh"

export PINTOS_WORKSPACE_ROOT="${PINTOS_WORKSPACE_ROOT:-$ROOT_DIR}"
exec bash "$TARGET" "$@"
