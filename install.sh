#!/bin/sh
# Hive installer.
#
# Short enough to audit, which is the only reason `curl | sh` is acceptable.
# Read this file before piping it to a shell.
#
# Downloads a published release, checks every artifact's SHA-256 against the
# release manifest, proves the binary runs, and only then points
# ~/.local/bin/hive at it. Never modifies an existing unmanaged binary.
#
# Releases without Hive manifest signature material are refused. Portable
# shell does not verify Ed25519; it preserves the exact manifest bytes and
# normalized signature so the installed binary can verify them before offline
# rollback.
set -eu

REPO="${HIVE_REPO:-scottdev1986/hive}"
BIN_DIR="${HIVE_BIN_DIR:-$HOME/.local/bin}"
VARIANT=prod
FROM_BUILD=""
REF=""
VERSION=latest

die() { printf 'install: %s\n' "$1" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant) [ "$#" -ge 2 ] || die "--variant requires a value"; VARIANT="$2"; shift 2 ;;
    --from-build) [ "$#" -ge 2 ] || die "--from-build requires a directory"; FROM_BUILD="$2"; shift 2 ;;
    --ref) [ "$#" -ge 2 ] || die "--ref requires a git ref"; REF="$2"; shift 2 ;;
    --*) die "unknown option $1" ;;
    *) [ "$VERSION" = latest ] || die "only one version may be specified"; VERSION="$1"; shift ;;
  esac
done
case "$VARIANT" in prod|dev|qa) ;; *) die "unknown variant $VARIANT" ;; esac
[ -z "$FROM_BUILD" ] || [ "$VARIANT" != prod ] || die "--from-build is not allowed for prod"
[ -z "$REF" ] || [ "$VARIANT" = qa ] || die "--ref is only allowed for qa"
BIN_NAME=hive
[ "$VARIANT" = prod ] || BIN_NAME="hive-$VARIANT"
ROOT="${HIVE_INSTALL_ROOT:-$HOME/.local/share/$BIN_NAME}"
BIN_LINK="${HIVE_BIN_LINK:-$BIN_DIR/$BIN_NAME}"

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

if [ -z "$FROM_BUILD" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v shasum >/dev/null 2>&1 || die "shasum is required"
fi

if [ -z "$FROM_BUILD" ] && [ "$VERSION" = "latest" ]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
elif [ -z "$FROM_BUILD" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"
fi

TMP="$(mktemp -d)"
STAGING_DIR=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$STAGING_DIR" ] || rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

if [ -z "$FROM_BUILD" ]; then
  printf 'Resolving %s...\n' "$VERSION"
  curl -fsSL -H 'Accept: application/vnd.github+json' "$API" > "$TMP/release.json" ||
    die "no published release for $VERSION"
  TAG="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$TMP/release.json" | head -1)"
  [ -n "$TAG" ] || die "release has no tag"
  RESOLVED="${TAG#v}"
  BASE="https://github.com/$REPO/releases/download/$TAG"
else
  [ -d "$FROM_BUILD" ] || die "build directory does not exist: $FROM_BUILD"
  RESOLVED="$VERSION"
  [ "$RESOLVED" != latest ] || RESOLVED="0.0.0-$VARIANT"
  printf 'Installing unverified local %s build from %s.\n' "$VARIANT" "$FROM_BUILD"
fi

fetch() { curl -fsSL "$BASE/$1" -o "$TMP/$1" || die "could not download $1"; }
fetch_optional() { curl -fsSL "$BASE/$1" -o "$TMP/$1"; }

if [ -z "$FROM_BUILD" ]; then
  fetch hive-release.json
  fetch_optional hive-release.json.sig 2>/dev/null || die "release has no Hive manifest signature"
  signature="$(tr -d '[:space:]' < "$TMP/hive-release.json.sig")"
  [ -n "$signature" ] || die "release manifest signature is empty"
  fetch "hive-darwin-$ARCH"
  fetch "hive-sessiond-darwin-$ARCH"
  fetch HiveWorkspace.tar.gz
  fetch hive-terminfo.tar.gz
else
  cp "$FROM_BUILD/hive-darwin-$ARCH" "$TMP/hive-darwin-$ARCH" || die "build has no hive-darwin-$ARCH"
  cp "$FROM_BUILD/hive-sessiond-darwin-$ARCH" "$TMP/hive-sessiond-darwin-$ARCH" || die "build has no hive-sessiond-darwin-$ARCH"
  cp "$FROM_BUILD/HiveWorkspace.tar.gz" "$TMP/HiveWorkspace.tar.gz" || die "build has no HiveWorkspace.tar.gz"
  cp "$FROM_BUILD/hive-terminfo.tar.gz" "$TMP/hive-terminfo.tar.gz" || die "build has no hive-terminfo.tar.gz"
fi

# Every artifact digest must match the manifest. The manifest arrives over TLS;
# `hive update` also verifies its Ed25519 signature against the embedded key.
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
if [ -z "$FROM_BUILD" ]; then
  verify "hive-darwin-$ARCH"
  verify "hive-sessiond-darwin-$ARCH"
  verify HiveWorkspace.tar.gz
  verify hive-terminfo.tar.gz
fi

VERSION_DIR="$ROOT/versions/$RESOLVED"
mkdir -p "$ROOT/versions" "$BIN_DIR"
STAGING_DIR="$(mktemp -d "$ROOT/versions/.hive-stage.XXXXXX")"
mv "$TMP/hive-darwin-$ARCH" "$STAGING_DIR/hive"
chmod 755 "$STAGING_DIR/hive"
mv "$TMP/hive-sessiond-darwin-$ARCH" "$STAGING_DIR/hive-sessiond"
chmod 755 "$STAGING_DIR/hive-sessiond"
tar -xzf "$TMP/HiveWorkspace.tar.gz" -C "$STAGING_DIR"
# Same layout hive update stages: resources/terminfo next to hive-sessiond.
# Queen cannot launch without it; a missing bundle is a broken install, not a
# degraded one.
tar -xzf "$TMP/hive-terminfo.tar.gz" -C "$STAGING_DIR" ||
  die "could not extract hive-terminfo.tar.gz"
[ -f "$STAGING_DIR/resources/terminfo/x/xterm-ghostty" ] ||
  die "staged install is missing resources/terminfo/x/xterm-ghostty"

# Exact manifest bytes + normalized signature for offline rollback. This shell
# does not verify Ed25519; the installed binary does before rollback.
if [ -z "$FROM_BUILD" ]; then
  manifest_base64="$(base64 < "$TMP/hive-release.json" | tr -d '\n')"
  printf '{\n  "schema": 1,\n  "manifestBase64": "%s",\n  "signature": "%s"\n}\n' "$manifest_base64" "$signature" > "$STAGING_DIR/release-verification.json"
fi

# Prove the staged binary runs before it can become `current`.
reported="$("$STAGING_DIR/hive" --version 2>/dev/null || true)"
case "$reported" in
  *"$RESOLVED"*) ;;
  *) die "staged binary reported '$reported', expected $RESOLVED" ;;
esac

# Full replacement is proven before any existing version is touched.
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
replace_symlink "$ROOT/current/hive" "$BIN_LINK"

printf '{\n  "active": "%s",\n  "previous": %s\n}\n' "$RESOLVED" \
  "$([ -n "${PREVIOUS:-}" ] && printf '"%s"' "$PREVIOUS" || printf 'null')" \
  > "$ROOT/state.json"

# Embedding runtime cannot ship inside the single-file binary (native napi).
# Install it here with the same manifest SHA-256 check into the machine-level
# tools dir the daemon loads from. Failure is loud but not fatal — the binary
# is already installed and `hive init` provisions again — because keyword-only
# memory is degraded product, not a broken install. Silent gap is never OK.
EMBEDDINGS_DIR="${HIVE_EMBEDDINGS_HOME:-${HIVE_HOME:-$HOME/.hive}/tools/embeddings}"
embeddings_note=""
if [ -n "$FROM_BUILD" ]; then
  embeddings_note="local builds provision embeddings through hive init"
elif ! printf 'Fetching the embedding runtime...\n' || ! fetch_optional embeddings-runtime.tar.gz 2>/dev/null; then
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
