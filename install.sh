#!/bin/sh
# Installs the ALP executable (t-1e02) from a GitHub release: macOS and Linux (glibc), arm64 and x64.
#
#   curl -fsSL https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.1.0 --system
#
# Options:
#   --version <v>      install release v<v> instead of the latest
#   --system           install to /usr/local/bin (uses sudo when needed) instead of ~/.alp/bin
#   --dir <path>       install to <path>
#   --no-modify-path   never edit a shell profile; only print the PATH line
#   --base-url <url>   download from this release mirror (it holds SHA256SUMS and the archives)
#   -h, --help
#
# Environment: ALP_INSTALL_BASE_URL (as --base-url), ALP_INSTALL_REPO (owner/name, default phucanh08/alp).
# The archive is checked against the release's SHA256SUMS before anything is installed.
set -eu

REPO="${ALP_INSTALL_REPO:-phucanh08/alp}"
VERSION=""
SYSTEM=0
DIR=""
MODIFY_PATH=1
BASE_URL="${ALP_INSTALL_BASE_URL:-}"

say() { printf '%s\n' "alp-install: $*"; }
die() { printf '%s\n' "alp-install: error: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: install.sh [--version <v>] [--system | --dir <path>] [--no-modify-path] [--base-url <url>]
Installs the ALP executable to ~/.alp/bin (or /usr/local/bin with --system) after checking it
against the release's SHA256SUMS. ALP_INSTALL_BASE_URL and ALP_INSTALL_REPO override the source.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="${2#v}"; shift 2 ;;
    --version=*) VERSION="${1#--version=}"; VERSION="${VERSION#v}"; shift ;;
    --system) SYSTEM=1; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#--dir=}"; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --base-url) [ $# -ge 2 ] || die "--base-url needs a value"; BASE_URL="$2"; shift 2 ;;
    --base-url=*) BASE_URL="${1#--base-url=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

case "$VERSION" in
  ''|[0-9]*) ;;
  *) die "invalid version: $VERSION" ;;
esac
case "$VERSION" in *[!0-9A-Za-z.+-]*) die "invalid version: $VERSION" ;; esac

# --- platform -------------------------------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported operating system: $os (ALP binaries exist for macOS and Linux; on Windows use npm)" ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported architecture: $arch" ;;
esac
# A shell translated by Rosetta 2 reports x86_64 on an Apple silicon Mac: install the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ]; then
  if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
    die "musl libc (Alpine) is not supported yet; use a glibc distribution or npm install -g @anhlp/alp"
  fi
fi

# --- tools ----------------------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch() { curl --proto '=https,file' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "curl or wget is required"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is required"
fi
command -v tar >/dev/null 2>&1 || die "tar is required"

if [ -z "$BASE_URL" ]; then
  if [ -n "$VERSION" ]; then BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
  else BASE_URL="https://github.com/$REPO/releases/latest/download"; fi
fi
BASE_URL="${BASE_URL%/}"
# A local mirror directory (an absolute path) is read through file://.
case "$BASE_URL" in /*) BASE_URL="file://$BASE_URL" ;; esac

if [ -n "$DIR" ]; then :
elif [ "$SYSTEM" = 1 ]; then DIR=/usr/local/bin
else DIR="$HOME/.alp/bin"; fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t alp-install)
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- download and verify --------------------------------------------------------------------
say "downloading SHA256SUMS from $BASE_URL"
fetch "$BASE_URL/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download $BASE_URL/SHA256SUMS"
# SHA256SUMS names each archive (alp-<version>-<os>-<arch>.tar.gz), so the latest release's version
# comes from it and no API call is needed.
suffix="-$os-$arch.tar.gz"
if [ -n "$VERSION" ]; then
  asset="alp-$VERSION$suffix"
  line=$(awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == a) print }' "$tmp/SHA256SUMS")
else
  line=$(awk -v s="$suffix" '{ n = $2; sub(/^\*/, "", n); if (n ~ /^alp-[0-9]/ && substr(n, length(n) - length(s) + 1) == s) print }' "$tmp/SHA256SUMS")
fi
[ -n "$line" ] || die "this release has no build for $os-$arch"
[ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" = 1 ] || die "SHA256SUMS lists more than one $os-$arch archive"
expected=$(printf '%s\n' "$line" | awk '{ print $1 }')
asset=$(printf '%s\n' "$line" | awk '{ n = $2; sub(/^\*/, "", n); print n }')
case "$asset" in *[!0-9A-Za-z.+_-]*|'') die "unexpected archive name in SHA256SUMS: $asset" ;; esac
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || die "malformed checksum for $asset"

say "downloading $asset"
fetch "$BASE_URL/$asset" "$tmp/$asset" || die "could not download $BASE_URL/$asset"
actual=$(sha256 "$tmp/$asset")
[ "$actual" = "$expected" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"
say "checksum verified ($expected)"

mkdir "$tmp/x"
tar -xzf "$tmp/$asset" -C "$tmp/x"
name="${asset%.tar.gz}"
binary="$tmp/x/$name/alp"
[ -f "$binary" ] || die "$asset does not contain $name/alp"

# --- install --------------------------------------------------------------------------------
SUDO=""
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR" 2>/dev/null || { [ "$SYSTEM" = 1 ] && SUDO=sudo; }
fi
if [ -z "$SUDO" ] && [ ! -w "$DIR" ]; then
  [ "$SYSTEM" = 1 ] || die "$DIR is not writable"
  SUDO=sudo
fi
if [ -n "$SUDO" ]; then
  command -v sudo >/dev/null 2>&1 || die "$DIR is not writable and sudo is unavailable"
  say "installing to $DIR with sudo"
  sudo mkdir -p "$DIR"
fi
# Copy beside the target, then rename: a running alp keeps its old file, and no half-written binary is ever on PATH.
$SUDO cp "$binary" "$DIR/.alp.install.$$"
$SUDO chmod 755 "$DIR/.alp.install.$$"
$SUDO mv -f "$DIR/.alp.install.$$" "$DIR/alp"
# The licence files ride along under <prefix>/share/doc/alp (or ~/.alp/share/doc/alp).
doc="$(dirname "$DIR")/share/doc/alp"
if $SUDO mkdir -p "$doc" 2>/dev/null; then
  for file in LICENSE NOTICE THIRD-PARTY-NOTICES.txt; do
    [ -f "$tmp/x/$name/$file" ] && $SUDO cp "$tmp/x/$name/$file" "$doc/$file"
  done
fi
say "installed $DIR/alp"

# --- PATH -----------------------------------------------------------------------------------
on_path=0
case ":${PATH:-}:" in *":$DIR:"*) on_path=1 ;; esac
if [ "$on_path" = 0 ]; then
  shown="$DIR"
  case "$DIR" in "$HOME"/*) shown="\$HOME${DIR#"$HOME"}" ;; esac
  line="export PATH=\"$shown:\$PATH\""
  profile=""
  case "$(basename "${SHELL:-sh}")" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$os" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
    fish) profile="$HOME/.config/fish/conf.d/alp.fish"; line="fish_add_path \"$shown\"" ;;
    *) profile="$HOME/.profile" ;;
  esac
  if [ "$MODIFY_PATH" = 1 ]; then
    if [ -f "$profile" ] && grep -Fqx "$line" "$profile"; then
      say "$profile already adds $DIR to PATH; open a new shell to use alp"
    else
      mkdir -p "$(dirname "$profile")"
      printf '\n# Added by the ALP installer\n%s\n' "$line" >> "$profile"
      say "added $DIR to PATH in $profile; open a new shell (or run: $line)"
    fi
  else
    say "$DIR is not on PATH; add it with:"
    printf '  %s\n' "$line"
  fi
fi

"$DIR/alp" --version || die "$DIR/alp --version failed"
