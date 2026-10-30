#!/bin/sh
# The ALP executable on a machine without Node (t-1e02 P1): CI runs this in debian:bookworm-slim on
# Linux and under `env -i PATH=/usr/bin:/bin` on macOS. scripts/binary-smoke.mjs (which needs Node
# for its fake provider and WebSocket client) covers the rest on the same runner.
#
#   sh scripts/binary-smoke-nodeless.sh path/to/alp
set -eu
binary="$1"
case "$binary" in /*) ;; *) binary="$(pwd)/$binary" ;; esac
[ -x "$binary" ] || { echo "binary-smoke-nodeless: $binary is not executable" >&2; exit 1; }
log() { printf '[binary-smoke-nodeless] %s\n' "$*"; }
fail() { printf '[binary-smoke-nodeless] FAIL: %s\n' "$*" >&2; exit 1; }

if command -v node >/dev/null 2>&1 || command -v bun >/dev/null 2>&1; then fail "node or bun is on PATH ($PATH); this smoke must run without them"; fi
log "ok: no node or bun on PATH"

work=$(mktemp -d)
export ALP_HOME="$work/home" HOME="$work/user" SHELL=/bin/sh
mkdir -m 700 "$ALP_HOME"; mkdir "$HOME"
cleanup() { "$binary" daemon stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT INT TERM

version=$("$binary" --version)
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' || fail "alp --version printed '$version'"
log "ok: alp --version ($version)"

mkdir "$work/project"
"$binary" init "$work/project" >/dev/null
{ [ -f "$work/project/.alp/ALP.md" ] || [ -f "$work/project/ALP.md" ]; } || fail "alp init did not write the embedded templates"
log "ok: alp init writes the embedded templates"

"$binary" daemon start | grep -Eq 'running \(pid [0-9]+\)' || fail "alp daemon start"
log "ok: alp daemon start"
"$binary" daemon status | grep -q ready || fail "alp daemon status"
log "ok: alp daemon status"
[ -d "$ALP_HOME/cache/$version" ] || fail "the assets were not extracted to \$ALP_HOME/cache/$version"
log "ok: assets extracted to the cache"

url=$(cd "$work/project" && "$binary" web --print)
case "$url" in http://127.0.0.1:*'#token='*) ;; *) fail "alp web --print printed '$url'" ;; esac
log "ok: alp web --print"
if command -v curl >/dev/null 2>&1; then
  base="${url%%/#*}"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$base/")" = 200 ] || fail "alp web does not serve its app"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/v1/tickets")" = 401 ] || fail "a ticket without a token was not refused"
  log "ok: alp web serves the app and gates tickets"
fi
web_pid=$(sed -n 's/.*"pid":[ ]*\([0-9][0-9]*\).*/\1/p' "$ALP_HOME/web.json" 2>/dev/null | head -n 1)
if [ -n "$web_pid" ]; then kill "$web_pid" 2>/dev/null || true; fi

"$binary" daemon stop | grep -q stopped || fail "alp daemon stop"
log "ok: alp daemon stop"
log ok
