#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

source "$ROOT_DIR/scripts/dev-home.sh"

export PATH="$ROOT_DIR/node_modules/.bin:$PATH"
export ALP_LISTEN="${ALP_LISTEN:-127.0.0.1:6768}"
configure_dev_alp_home

DEV_ROOT="${ALP_DEV_ROOT:-$(default_dev_alp_root)}"
export ALP_DEV_ROOT="$DEV_ROOT"
export ALP_DEV_RUNTIME_FALLBACK_ROOT="$DEV_ROOT"
DEV_RUNTIME="$(node "$SCRIPT_DIR/dev-runtime.mjs")"
export ALP_ELECTRON_FLAGS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).electronFlags)' "$DEV_RUNTIME")"
export ALP_ELECTRON_USER_DATA_DIR="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userDataDir)' "$DEV_RUNTIME")"
unset ALP_DEV_RUNTIME_FALLBACK_ROOT
mkdir -p "$ALP_ELECTRON_USER_DATA_DIR"

if [ -z "${EXPO_PORT:-}" ]; then
  EXPO_PORT=$(NO_COLOR=1 FORCE_COLOR=0 "$ROOT_DIR/node_modules/.bin/get-port" 8082 8083 8084 8085 8086 8087 8088 8089)
fi
export EXPO_PORT
export EXPO_DEV_URL="http://localhost:${EXPO_PORT}"

DAEMON_ENDPOINT="$(resolve_dev_daemon_endpoint)"
export ALP_DAEMON_ENDPOINT="$DAEMON_ENDPOINT"

export ALP_CORS_ORIGINS="${ALP_CORS_ORIGINS:-*}"

npm --prefix "$DESKTOP_DIR" run build:main

echo "══════════════════════════════════════════════════════"
echo "  Alp Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:      ${EXPO_DEV_URL}"
echo "  Daemon:     ${ALP_LISTEN}"
echo "  Home:       ${ALP_HOME}"
echo "  userData:   ${ALP_ELECTRON_USER_DATA_DIR}"
echo "══════════════════════════════════════════════════════"

exec node "$SCRIPT_DIR/dev-runner.mjs"
