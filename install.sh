#!/bin/sh
# Installs ALP (t-1807) from a GitHub release: macOS and Linux (glibc), arm64 and x64. The release
# archive is the ALP bundle (ALP with the Node release it runs on); it goes to <root>/app/<version>,
# <root>/app/current points at it, and <bin>/alp links to <root>/app/current/bin/alp.
#
#   curl -fsSL https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.1.0 --system
#
# Options:
#   --version <v>      install release v<v> instead of the latest
#   --system           install to /usr/local/lib/alp with the command in /usr/local/bin (uses sudo when needed)
#                      instead of ~/.alp with the command in ~/.alp/bin
#   --dir <path>       put the alp command in <path>
#   --root <path>      put the bundle in <path>/app
#   --no-modify-path   never edit a shell profile; only print the PATH line
#   --base-url <url>   download from this release mirror (it holds SHA256SUMS and the archives)
#   -h, --help
#
# Environment: ALP_INSTALL_BASE_URL (as --base-url), ALP_INSTALL_REPO (owner/name, default phucanh08/alp).
# The archive is checked against the release's SHA256SUMS before anything is installed.
set -eu

# Everything runs from main, called on the last line: a download cut short by `curl | sh` runs nothing.
main() {

REPO="${ALP_INSTALL_REPO:-phucanh08/alp}"
VERSION=""
SYSTEM=0
DIR=""
ROOT=""
MODIFY_PATH=1
BASE_URL="${ALP_INSTALL_BASE_URL:-}"

say() { printf '%s\n' "alp-install: $*"; }
die() { printf '%s\n' "alp-install: error: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: install.sh [--version <v>] [--system] [--dir <path>] [--root <path>] [--no-modify-path] [--base-url <url>]
Installs ALP to ~/.alp/app/<version> with the alp command in ~/.alp/bin (or /usr/local/lib/alp and
/usr/local/bin with --system) after checking it against the release's SHA256SUMS. Rerun it to
upgrade an ALP 0.0.1-beta.5/6 single-file install. ALP_INSTALL_BASE_URL and ALP_INSTALL_REPO override the source.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) if [ $# -lt 2 ] || [ -z "${2#v}" ]; then die "--version needs a value"; fi; VERSION="${2#v}"; shift 2 ;;
    --version=*) VERSION="${1#--version=}"; VERSION="${VERSION#v}"; [ -n "$VERSION" ] || die "--version needs a value"; shift ;;
    --system) SYSTEM=1; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#--dir=}"; shift ;;
    --root) [ $# -ge 2 ] || die "--root needs a value"; ROOT="$2"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --base-url) [ $# -ge 2 ] || die "--base-url needs a value"; BASE_URL="$2"; shift 2 ;;
    --base-url=*) BASE_URL="${1#--base-url=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# The install directory is written into a shell profile: keep it to plain path characters.
case "$DIR" in *[!A-Za-z0-9._/@+\ -]*) die "unsupported characters in --dir: $DIR" ;; esac
case "$ROOT" in *[!A-Za-z0-9._/@+\ -]*) die "unsupported characters in --root: $ROOT" ;; esac
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
  *) die "unsupported operating system: $os (ALP builds exist for macOS and Linux; on Windows use install.ps1)" ;;
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
    die "musl libc (Alpine) is not supported yet; use a glibc distribution, or the JavaScript CLI on Node 22+: npm install -g @anhlp/alp-cli@beta"
  fi
fi

# --- tools ----------------------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch() { curl --proto '=https,file' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  # wget reads no file:// mirror; https only.
  fetch() { case "$1" in https://*) wget -q -O "$2" "$1" ;; *) echo "wget cannot read $1; install curl" >&2; return 1 ;; esac; }
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
case "$BASE_URL" in https://*|file://*) ;; *) die "the release mirror must be https:// or file:// ($BASE_URL)" ;; esac

if [ -n "$DIR" ]; then :
elif [ "$SYSTEM" = 1 ]; then DIR=/usr/local/bin
else DIR="$HOME/.alp/bin"; fi
if [ -n "$ROOT" ]; then :
elif [ "$SYSTEM" = 1 ]; then ROOT=/usr/local/lib/alp
else ROOT="$HOME/.alp"; fi
case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac
case "$ROOT" in /*) ;; *) ROOT="$(pwd)/$ROOT" ;; esac
APP="$ROOT/app"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t alp-install)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

name="${asset%.tar.gz}"
version="${name#alp-}"
version="${version%"-$os-$arch"}"

# --- install --------------------------------------------------------------------------------
SUDO=""
writable() { # $1 exists and is writable, or can be created
  if [ -d "$1" ]; then [ -w "$1" ]; else mkdir -p "$1" 2>/dev/null; fi
}
if ! writable "$APP" || ! writable "$DIR"; then
  [ "$SYSTEM" = 1 ] || die "$APP or $DIR is not writable"
  command -v sudo >/dev/null 2>&1 || die "$APP or $DIR is not writable and sudo is unavailable"
  SUDO=sudo
  say "installing to $APP and $DIR with sudo"
  sudo mkdir -p "$APP" "$DIR"
fi
[ ! -e "$APP/current" ] || [ -L "$APP/current" ] || die "$APP/current exists and is not a symlink; move it away and rerun"
previous=$(readlink "$APP/current" 2>/dev/null || true)

# Unpack beside the versions, then move into place: no half-written version is ever current.
stage=$($SUDO mktemp -d "$APP/.alp-update-XXXXXX") || die "could not create a directory in $APP"
cleanup_stage() { $SUDO rm -rf "$stage"; }
if ! $SUDO tar -xzf "$tmp/$asset" -C "$stage"; then cleanup_stage; die "could not extract $asset"; fi
if [ ! -f "$stage/$name/alp-bundle.json" ] || [ ! -x "$stage/$name/bin/alp" ]; then cleanup_stage; die "$asset does not contain an ALP bundle ($name/bin/alp)"; fi
reported=$("$stage/$name/bin/alp" --version 2>/dev/null || true)
if [ "$reported" != "$version" ]; then cleanup_stage; die "the downloaded ALP reports version '$reported', not $version"; fi
if [ -e "$APP/$version" ]; then
  if [ "$previous" = "$version" ]; then
    # Reinstalling the running version: keep its files for the processes that use them.
    aside="$APP/.alp-old-${stage##*.alp-update-}"
    $SUDO mv "$APP/$version" "$aside" || { cleanup_stage; die "could not move $APP/$version aside"; }
  else
    $SUDO rm -rf "$APP/$version"
  fi
fi
$SUDO mv "$stage/$name" "$APP/$version" || { cleanup_stage; die "could not install $APP/$version"; }
cleanup_stage
# A relative link, so the whole root can move. ln -n replaces the old link instead of entering it.
$SUDO ln -sfn "$version" "$APP/current" || die "could not point $APP/current at $version"
say "installed ALP $version in $APP/$version"

# The alp command: a symlink renamed over the old one (a 0.0.1-beta.5/6 single-file alp included);
# a running alp keeps its file.
link="$DIR/.alp.install.$$"
$SUDO rm -f "$link"
if ! { $SUDO ln -s "$APP/current/bin/alp" "$link" && $SUDO mv -f "$link" "$DIR/alp"; }; then
  $SUDO rm -f "$link"
  die "could not install $DIR/alp"
fi
say "installed $DIR/alp -> $APP/current/bin/alp"

# Older versions go; the previous one stays until the next install, for an alpd still running it.
for old in "$APP"/*; do
  [ -d "$old" ] || continue
  base=$(basename "$old")
  case "$base" in current|"$version"|"$previous") continue ;; [0-9]*) $SUDO rm -rf "$old" ;; esac
done

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
}

main "$@"
