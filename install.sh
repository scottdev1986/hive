#!/bin/sh
# Hive installer.
#
# Short enough to audit, which is the only reason `curl | sh` is acceptable.
# Read it first: https://github.com/scottdev1986/hive/blob/main/install.sh
#
# It downloads a published release, checks every artifact's SHA-256 against the
# release manifest, proves the binary runs, and only then points ~/.local/bin/hive
# at it. It never modifies an existing unmanaged binary.
#
# Releases without Hive manifest signature material are refused. Portable shell
# does not verify Ed25519; it preserves the exact manifest bytes and normalized
# signature for Hive to verify before offline rollback. See the release docs.
set -eu

REPO="${HIVE_REPO:-scottdev1986/hive}"
ROOT="${HIVE_INSTALL_ROOT:-$HOME/.local/share/hive}"
BIN_DIR="${HIVE_BIN_DIR:-$HOME/.local/bin}"
VERSION="${1:-latest}"

die() { printf 'install: %s\n' "$1" >&2; exit 1; }

# This installer is Darwin-only. BSD mv's -h is the no-follow half of the
# atomic rename: without it, a `current` symlink to a directory is followed and
# the temporary link is moved inside the old version while mv exits zero.
replace_symlink() {
  target="$1"
  link="$2"
  temporary="$link.tmp"
  rm -f "$temporary"
  ln -s "$target" "$temporary" || die "could not stage symlink $link"
  /bin/mv -fh "$temporary" "$link" || die "could not replace symlink $link"
  actual="$(readlink "$link" 2>/dev/null || true)"
  [ "$actual" = "$target" ] ||
    die "symlink $link points to '${actual:-nothing}', expected '$target'"
}

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
STAGING_DIR=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$STAGING_DIR" ] || rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

printf 'Resolving %s...\n' "$VERSION"
curl -fsSL -H 'Accept: application/vnd.github+json' "$API" > "$TMP/release.json" ||
  die "no published release for $VERSION"

TAG="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$TMP/release.json" | head -1)"
[ -n "$TAG" ] || die "release has no tag"
RESOLVED="${TAG#v}"
BASE="https://github.com/$REPO/releases/download/$TAG"

fetch() { curl -fsSL "$BASE/$1" -o "$TMP/$1" || die "could not download $1"; }
fetch_optional() { curl -fsSL "$BASE/$1" -o "$TMP/$1"; }

fetch hive-release.json
fetch_optional hive-release.json.sig 2>/dev/null ||
  die "release has no Hive manifest signature"
signature="$(tr -d '[:space:]' < "$TMP/hive-release.json.sig")"
[ -n "$signature" ] || die "release manifest signature is empty"
fetch "hive-darwin-$ARCH"
fetch "hive-sessiond-darwin-$ARCH"
fetch HiveWorkspace.tar.gz

# Every artifact's digest must be the one the manifest names. The manifest is
# served over TLS from GitHub Release hosting; `hive update` additionally
# verifies its Ed25519 signature against the embedded release key.
digest_in_manifest() {
  tr -d ' \n' < "$TMP/hive-release.json" |
    sed -n "s/.*\"name\":\"$1\",[^}]*\"sha256\":\"\([0-9a-f]\{64\}\)\".*/\1/p" | head -1
}
verify() {
  want="$(digest_in_manifest "$1")"
  [ -n "$want" ] || die "manifest names no sha256 for $1"
  got="$(shasum -a 256 "$TMP/$1" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || die "$1 sha256 mismatch (expected $want, got $got)"
}
verify "hive-darwin-$ARCH"
verify "hive-sessiond-darwin-$ARCH"
verify HiveWorkspace.tar.gz

VERSION_DIR="$ROOT/versions/$RESOLVED"
mkdir -p "$ROOT/versions" "$BIN_DIR"
STAGING_DIR="$(mktemp -d "$ROOT/versions/.hive-stage.XXXXXX")"
mv "$TMP/hive-darwin-$ARCH" "$STAGING_DIR/hive"
chmod 755 "$STAGING_DIR/hive"
mv "$TMP/hive-sessiond-darwin-$ARCH" "$STAGING_DIR/hive-sessiond"
chmod 755 "$STAGING_DIR/hive-sessiond"
tar -xzf "$TMP/HiveWorkspace.tar.gz" -C "$STAGING_DIR"

# Preserve the exact manifest bytes and normalized signature for a future
# offline rollback. The shell installer requires this material but does not
# verify Ed25519 itself; the installed binary does so before rollback.
manifest_base64="$(base64 < "$TMP/hive-release.json" | tr -d '\n')"
printf '{\n  "schema": 1,\n  "manifestBase64": "%s",\n  "signature": "%s"\n}\n' "$manifest_base64" "$signature" > "$STAGING_DIR/release-verification.json"

# Run it before it can ever be `current`.
reported="$("$STAGING_DIR/hive" --version 2>/dev/null || true)"
case "$reported" in
  *"$RESOLVED"*) ;;
  *) die "staged binary reported '$reported', expected $RESOLVED" ;;
esac

# The complete replacement is proven before an existing version is touched.
rm -rf "$VERSION_DIR"
mv "$STAGING_DIR" "$VERSION_DIR"
STAGING_DIR=""

# Atomic activation: one rename over the `current` symlink.
PREVIOUS="$(readlink "$ROOT/current" 2>/dev/null | sed 's|^versions/||' || true)"
replace_symlink "versions/$RESOLVED" "$ROOT/current"
active_dir="$(cd "$ROOT/current" 2>/dev/null && pwd -P || true)"
intended_dir="$(cd "$VERSION_DIR" 2>/dev/null && pwd -P || true)"
[ -n "$active_dir" ] || die "current does not resolve to an installed version"
[ -n "$intended_dir" ] || die "staged version $VERSION_DIR does not resolve"
[ "$active_dir" = "$intended_dir" ] ||
  die "current resolved to '${active_dir:-nothing}', expected '$intended_dir'"
replace_symlink "$ROOT/current/hive" "$BIN_DIR/hive"

printf '{\n  "active": "%s",\n  "previous": %s\n}\n' "$RESOLVED" \
  "$([ -n "${PREVIOUS:-}" ] && printf '"%s"' "$PREVIOUS" || printf 'null')" \
  > "$ROOT/state.json"

# Semantic memory needs an embedding runtime that cannot live inside the
# single-file binary (native napi graph), so installing Hive installs it too:
# there is no separate command to run. It is fetched with the same manifest
# SHA-256 check as everything above and unpacked into the machine-level tools
# dir the daemon loads from. A failure here is loud but not fatal — the binary
# is already installed and `hive init` provisions (and load-verifies) the
# runtime again — because keyword-only memory is a worse product, not a broken
# one. What is never acceptable is a silent gap.
EMBEDDINGS_DIR="${HIVE_EMBEDDINGS_HOME:-${HIVE_HOME:-$HOME/.hive}/tools/embeddings}"
embeddings_note=""
printf 'Fetching the embedding runtime...\n'
if ! fetch_optional embeddings-runtime.tar.gz 2>/dev/null; then
  embeddings_note="the release publishes no embeddings-runtime.tar.gz, or it could not be downloaded"
elif [ "$(digest_in_manifest embeddings-runtime.tar.gz)" != \
  "$(shasum -a 256 "$TMP/embeddings-runtime.tar.gz" | cut -d' ' -f1)" ]; then
  embeddings_note="embeddings-runtime.tar.gz does not match the SHA-256 in the release manifest"
else
  EMBEDDINGS_STAGE="$TMP/embeddings-stage"
  if mkdir -p "$EMBEDDINGS_STAGE" &&
    tar -xzf "$TMP/embeddings-runtime.tar.gz" -C "$EMBEDDINGS_STAGE" --strip-components 1 &&
    [ -f "$EMBEDDINGS_STAGE/dist/entry.js" ] &&
    mkdir -p "$(dirname "$EMBEDDINGS_DIR")" &&
    rm -rf "$EMBEDDINGS_DIR.old" &&
    { [ ! -d "$EMBEDDINGS_DIR" ] || mv "$EMBEDDINGS_DIR" "$EMBEDDINGS_DIR.old"; } &&
    mv "$EMBEDDINGS_STAGE" "$EMBEDDINGS_DIR"; then
    rm -rf "$EMBEDDINGS_DIR.old"
  else
    embeddings_note="the runtime tarball could not be unpacked into $EMBEDDINGS_DIR"
  fi
fi

printf '\nhive %s installed.\n' "$RESOLVED"
if [ -n "$embeddings_note" ]; then
  printf '\n! EMBEDDING RUNTIME NOT INSTALLED: %s.\n' "$embeddings_note"
  printf '  Hive memory will be keyword-only until it lands. `hive init` retries it.\n'
else
  printf 'Embedding runtime installed at %s.\n' "$EMBEDDINGS_DIR"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to your PATH.\n' "$BIN_DIR" ;;
esac
printf 'Run `hive init` in a project, then `hive` to open the Workspace.\n'
