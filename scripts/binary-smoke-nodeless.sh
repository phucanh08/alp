#!/bin/sh
# The ALP bundle on a machine without a system Node (t-1807): CI runs this in debian:bookworm-slim on
# Linux and under `env -i PATH=/usr/bin:/bin` on macOS; the bundle's own Node runs ALP.
# scripts/binary-smoke.mjs (which needs Node for its fake provider and WebSocket client) covers the rest.
#
#   sh scripts/binary-smoke-nodeless.sh path/to/alp-<version>-<platform>/bin/alp
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
{ [ -f "$work/project/.alp/ALP.md" ] || [ -f "$work/project/ALP.md" ]; } || fail "alp init did not write its templates"
log "ok: alp init writes its templates"

"$binary" daemon start | grep -Eq 'running \(pid [0-9]+\)' || fail "alp daemon start"
log "ok: alp daemon start"
"$binary" daemon status | grep -q ready || fail "alp daemon status"
log "ok: alp daemon status"
# The native alpd (t-81b0.9), where the bundle ships one, is what alp started.
bin_dir=$(cd "$(dirname "$binary")" && pwd -P)
if [ -x "$bin_dir/alpd" ]; then
  grep -q "\"entry\":\"$bin_dir/alpd\"" "$ALP_HOME/alpd.json" || fail "alp did not start the native alpd: $(cat "$ALP_HOME/alpd.json")"
  log "ok: the running alpd is the native alpd"
fi

url=$(cd "$work/project" && "$binary" dashboard --print)
case "$url" in http://127.0.0.1:*'#token='*) ;; *) fail "alp dashboard --print printed '$url'" ;; esac
log "ok: alp dashboard --print"
if command -v curl >/dev/null 2>&1; then
  base="${url%%/#*}"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$base/")" = 200 ] || fail "alp dashboard does not serve its app"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/v1/tickets")" = 401 ] || fail "a ticket without a token was not refused"
  log "ok: alp dashboard serves the app and gates tickets"
fi
web_pid=$(sed -n 's/.*"pid":[ ]*\([0-9][0-9]*\).*/\1/p' "$ALP_HOME/dashboard.json" 2>/dev/null | head -n 1)
if [ -n "$web_pid" ]; then kill "$web_pid" 2>/dev/null || true; fi

"$binary" daemon stop | grep -q stopped || fail "alp daemon stop"
log "ok: alp daemon stop"
log ok
