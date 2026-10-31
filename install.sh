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
#   --root <path>      put the bundle in <path>/app; without --dir or --system the command goes to
#                      <path>/bin, and no shell profile is edited unless --modify-path is given
#   --no-modify-path   never edit a shell profile; only print the PATH line
#   --modify-path      edit the shell profile even with --root
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
MODIFY_PATH=""
BASE_URL="${ALP_INSTALL_BASE_URL:-}"

say() { printf '%s\n' "alp-install: $*"; }
die() { printf '%s\n' "alp-install: error: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: install.sh [--version <v>] [--system] [--dir <path>] [--root <path>] [--no-modify-path | --modify-path] [--base-url <url>]
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
    --modify-path) MODIFY_PATH=1; shift ;;
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

# --root alone (no --dir, no --system) keeps the install self-contained: the command in <root>/bin
# and no shell profile edit unless --modify-path.
SELF_CONTAINED=0
if [ -n "$ROOT" ] && [ -z "$DIR" ] && [ "$SYSTEM" != 1 ]; then SELF_CONTAINED=1; fi
if [ -z "$MODIFY_PATH" ]; then
  if [ "$SELF_CONTAINED" = 1 ]; then MODIFY_PATH=0; else MODIFY_PATH=1; fi
fi
if [ -n "$DIR" ]; then :
elif [ "$SELF_CONTAINED" = 1 ]; then DIR="$ROOT/bin"
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

# The version a running alpd uses (its lock names it): its files must stay.
lock="${ALP_HOME:-$HOME/.alp}/alpd.lock"
alpd_version=""
if [ -f "$lock" ]; then
  alpd_pid=$(sed -n 's/.*"pid":[ ]*\([0-9][0-9]*\).*/\1/p' "$lock" | head -n 1)
  if [ -n "$alpd_pid" ] && kill -0 "$alpd_pid" 2>/dev/null; then
    alpd_version=$(sed -n 's/.*"version":[ ]*"\([0-9A-Za-z.+-]*\)".*/\1/p' "$lock" | head -n 1)
  fi
fi

# Unpack and check as this user, then move into place beside the versions: no half-written
# version is ever current.
mkdir "$tmp/x"
tar -xzf "$tmp/$asset" -C "$tmp/x" || die "could not extract $asset"
if [ ! -f "$tmp/x/$name/alp-bundle.json" ] || [ ! -x "$tmp/x/$name/bin/alp" ]; then die "$asset does not contain an ALP bundle ($name/bin/alp)"; fi
stage=$($SUDO mktemp -d "$APP/.alp-update-XXXXXX") || die "could not create a directory in $APP"
cleanup_stage() { $SUDO rm -rf "$stage"; }
if ! $SUDO cp -R "$tmp/x/$name" "$stage/$name"; then cleanup_stage; die "could not copy the bundle into $APP"; fi
[ -n "$SUDO" ] && $SUDO chmod 755 "$stage"
# Checked on the copy that is installed (not in TMPDIR, which may be noexec).
reported=$("$stage/$name/bin/alp" --version 2>/dev/null || true)
if [ "$reported" != "$version" ]; then cleanup_stage; die "the downloaded ALP reports version '$reported', not $version"; fi
aside=""
if [ -e "$APP/$version" ]; then
  if [ "$previous" = "$version" ] || [ "$alpd_version" = "$version" ]; then
    # Reinstalling a version in use: keep its files for the processes that use them.
    aside=".alp-old-${stage##*.alp-update-}"
    $SUDO mv "$APP/$version" "$APP/$aside" || { cleanup_stage; die "could not move $APP/$version aside"; }
  else
    $SUDO rm -rf "$APP/$version"
  fi
fi
if ! $SUDO mv "$stage/$name" "$APP/$version"; then
  [ -n "$aside" ] && $SUDO mv "$APP/$aside" "$APP/$version"
  cleanup_stage
  die "could not install $APP/$version"
fi
cleanup_stage
# A relative link, so the whole root can move, renamed over the old one in one step (GNU mv -T,
# BSD mv -h: replace the link instead of entering the directory it points at).
if mv --version 2>/dev/null | grep -q GNU; then over="-fT"; else over="-fh"; fi
$SUDO rm -f "$APP/.current.$$"
if ! { $SUDO ln -s "$version" "$APP/.current.$$" && $SUDO mv $over "$APP/.current.$$" "$APP/current"; }; then
  $SUDO rm -f "$APP/.current.$$"
  die "could not point $APP/current at $version"
fi
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

# Older versions and leftovers of earlier installs go. Kept: the previous version and the copy just
# moved aside (for processes still running them) and the version a running alpd uses.
for old in "$APP"/* "$APP"/.alp-old-* "$APP"/.alp-update-*; do
  [ -d "$old" ] || continue
  base=$(basename "$old")
  case "$base" in current|"$version"|"$previous"|"$alpd_version"|"$aside") continue ;; esac
  # A running alpd may run from a copy an earlier reinstall moved aside: keep those while it runs.
  case "$base" in .alp-old-*) [ -n "$alpd_version" ] && continue ;; esac
  case "$base" in [0-9]*|.alp-old-*|.alp-update-*) $SUDO rm -rf "$old" ;; esac
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
