#!/bin/sh
# Hive installer.
#
# Short enough to audit, which is the only reason `curl | sh` is acceptable.
# Read it first: https://github.com/scottdev1986/hive/blob/main/install.sh
#
# It downloads a published release, checks every artifact's SHA-256 against the
# release manifest, proves the binary runs, and only then points ~/.local/bin/hive
# at it. It never touches a Homebrew-owned install.
#
# A signed and notarized release runs without a Gatekeeper prompt. An unsigned
# release (none of the signing secrets configured) is quarantined on first run;
# see docs/versioning-and-release.md.
set -eu

REPO="${HIVE_REPO:-scottdev1986/hive}"
ROOT="${HIVE_INSTALL_ROOT:-$HOME/.local/share/hive}"
BIN_DIR="${HIVE_BIN_DIR:-$HOME/.local/bin}"
VERSION="${1:-latest}"

die() { printf 'install: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Hive is macOS-only for now (found $(uname -s))."
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v shasum >/dev/null 2>&1 || die "shasum is required"

if [ "$VERSION" = "latest" ]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
else
  API="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'Resolving %s...\n' "$VERSION"
curl -fsSL -H 'Accept: application/vnd.github+json' "$API" > "$TMP/release.json" ||
  die "no published release for $VERSION"

TAG="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$TMP/release.json" | head -1)"
[ -n "$TAG" ] || die "release has no tag"
RESOLVED="${TAG#v}"
BASE="https://github.com/$REPO/releases/download/$TAG"

fetch() { curl -fsSL "$BASE/$1" -o "$TMP/$1" || die "could not download $1"; }

fetch hive-release.json
fetch "hive-darwin-$ARCH"
fetch HiveWorkspace.tar.gz

# Every artifact's digest must be the one the manifest names. The manifest is
# served over TLS from an immutable release; when a Hive release key exists,
# `hive update` additionally verifies its Ed25519 signature.
verify() {
  want="$(tr -d ' \n' < "$TMP/hive-release.json" |
    sed -n "s/.*\"name\":\"$1\",[^}]*\"sha256\":\"\([0-9a-f]\{64\}\)\".*/\1/p" | head -1)"
  [ -n "$want" ] || die "manifest names no sha256 for $1"
  got="$(shasum -a 256 "$TMP/$1" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || die "$1 sha256 mismatch (expected $want, got $got)"
}
verify "hive-darwin-$ARCH"
verify HiveWorkspace.tar.gz

VERSION_DIR="$ROOT/versions/$RESOLVED"
rm -rf "$VERSION_DIR"
mkdir -p "$VERSION_DIR" "$BIN_DIR"
mv "$TMP/hive-darwin-$ARCH" "$VERSION_DIR/hive"
chmod 755 "$VERSION_DIR/hive"
tar -xzf "$TMP/HiveWorkspace.tar.gz" -C "$VERSION_DIR"

# Run it before it can ever be `current`.
reported="$("$VERSION_DIR/hive" --version 2>/dev/null || true)"
case "$reported" in
  *"$RESOLVED"*) ;;
  *) rm -rf "$VERSION_DIR"; die "staged binary reported '$reported', expected $RESOLVED" ;;
esac

# Atomic activation: one rename over the `current` symlink.
PREVIOUS="$(readlink "$ROOT/current" 2>/dev/null | sed 's|^versions/||' || true)"
ln -sfn "versions/$RESOLVED" "$ROOT/current.tmp"
mv -f "$ROOT/current.tmp" "$ROOT/current"
ln -sfn "$ROOT/current/hive" "$BIN_DIR/hive.tmp"
mv -f "$BIN_DIR/hive.tmp" "$BIN_DIR/hive"

printf '{\n  "active": "%s",\n  "previous": %s\n}\n' "$RESOLVED" \
  "$([ -n "${PREVIOUS:-}" ] && printf '"%s"' "$PREVIOUS" || printf 'null')" \
  > "$ROOT/state.json"

printf '\nhive %s installed.\n' "$RESOLVED"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to your PATH.\n' "$BIN_DIR" ;;
esac
printf 'Run `hive start` in a project, then `hive` to open the Workspace.\n'
