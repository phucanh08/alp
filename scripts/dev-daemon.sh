#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export ALP_LISTEN="${ALP_LISTEN:-127.0.0.1:6768}"
configure_dev_alp_home

if [ -z "${ALP_LOCAL_MODELS_DIR}" ]; then
  export ALP_LOCAL_MODELS_DIR="$HOME/.alp/models/local-speech"
  mkdir -p "$ALP_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Alp Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${ALP_HOME}"
echo "  Models:  ${ALP_LOCAL_MODELS_DIR}"
echo "  Listen:  ${ALP_LISTEN}"
echo "══════════════════════════════════════════════════════"

export ALP_CORS_ORIGINS="${ALP_CORS_ORIGINS:-*}"
export ALP_NODE_INSPECT="${ALP_NODE_INSPECT:---inspect=0}"

if [ "${ALP_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
