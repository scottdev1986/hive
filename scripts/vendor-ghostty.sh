#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
VENDOR="$ROOT/vendor/ghostty"
PATCH_DIR="$ROOT/native/ghostty-patches"
SERIES="$PATCH_DIR/series"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}
UPSTREAM_REPO="$CACHE/ghostty-upstream"
EXPECTED_COMMIT=$(/usr/bin/plutil -extract ghostty.commit raw -o - "$LOCK")
EXPECTED_TREE=$(/usr/bin/plutil -extract ghostty.upstreamTree raw -o - "$LOCK")
EXPECTED_PATCHED_TREE=$(/usr/bin/plutil -extract ghostty.patchedTree raw -o - "$LOCK")

usage() {
  echo "usage: $0 fetch|verify|patch-series-sha256" >&2
  exit 2
}

series_entries() {
  /usr/bin/awk 'NF && $1 !~ /^#/ { print $1 }' "$SERIES"
}

patch_series_sha256() {
  payload=$(mktemp "${TMPDIR:-/tmp}/hive-ghostty-series.XXXXXX")
  : >"$payload"
  series_entries | while IFS= read -r patch; do
    if [ ! -f "$PATCH_DIR/$patch" ]; then
      echo "patch series entry is missing: $patch" >&2
      exit 1
    fi
    printf '%s\000' "$patch" >>"$payload"
    /bin/cat "$PATCH_DIR/$patch" >>"$payload"
    printf '\000' >>"$payload"
  done
  digest=$(/usr/bin/shasum -a 256 "$payload" | /usr/bin/awk '{ print $1 }')
  /bin/rm -f "$payload"
  printf '%s\n' "$digest"
}

apply_series() {
  target=$1
  series_entries | while IFS= read -r patch; do
    echo "applying Ghostty patch: $patch"
    git -C "$target" apply --whitespace=error-all "$PATCH_DIR/$patch"
  done
}

verify_vendor() {
  if [ ! -d "$VENDOR" ]; then
    echo "vendored Ghostty tree is missing; run scripts/vendor-ghostty.sh fetch" >&2
    exit 1
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-verify.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  /usr/bin/rsync -a --exclude .git "$VENDOR/" "$tmp/"

  reverse=$(series_entries | /usr/bin/awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }')
  if [ -n "$reverse" ]; then
    printf '%s\n' "$reverse" | while IFS= read -r patch; do
      git -C "$tmp" apply --reverse --whitespace=error-all "$PATCH_DIR/$patch"
    done
  fi

  git -C "$tmp" init -q
  git -C "$tmp" add -f .
  actual_tree=$(git -C "$tmp" write-tree)
  if [ "$actual_tree" != "$EXPECTED_TREE" ]; then
    echo "vendored Ghostty base tree mismatch: expected $EXPECTED_TREE, found $actual_tree" >&2
    exit 1
  fi

  /bin/rm -rf "$tmp/.git"
  apply_series "$tmp"
  git -C "$tmp" init -q
  git -C "$tmp" add -f .
  actual_patched_tree=$(git -C "$tmp" write-tree)
  if [ "$actual_patched_tree" != "$EXPECTED_PATCHED_TREE" ]; then
    echo "patched Ghostty tree mismatch: expected $EXPECTED_PATCHED_TREE, found $actual_patched_tree" >&2
    exit 1
  fi
  /bin/rm -rf "$tmp/.git"
  if ! /usr/bin/diff -qr "$tmp" "$VENDOR" >/dev/null; then
    echo "vendored Ghostty tree differs from commit $EXPECTED_COMMIT plus ordered patch series" >&2
    /usr/bin/diff -qr "$tmp" "$VENDOR" | /usr/bin/sed -n '1,40p' >&2
    exit 1
  fi

  echo "vendored Ghostty verified: commit=$EXPECTED_COMMIT tree=$EXPECTED_TREE patched_tree=$EXPECTED_PATCHED_TREE patches=$(patch_series_sha256)"
}

case "${1:-}" in
  patch-series-sha256)
    [ "$#" -eq 1 ] || usage
    patch_series_sha256
    ;;
  verify)
    [ "$#" -eq 1 ] || usage
    verify_vendor
    ;;
  fetch)
    [ "$#" -eq 1 ] || usage
    mkdir -p "$CACHE" "$ROOT/vendor"
    if [ ! -d "$UPSTREAM_REPO/.git" ]; then
      git clone --filter=blob:none --no-checkout https://github.com/ghostty-org/ghostty.git "$UPSTREAM_REPO"
    fi
    git -C "$UPSTREAM_REPO" fetch --depth=1 origin "$EXPECTED_COMMIT"
    actual_commit=$(git -C "$UPSTREAM_REPO" rev-parse FETCH_HEAD)
    if [ "$actual_commit" != "$EXPECTED_COMMIT" ]; then
      echo "Ghostty fetch resolved $actual_commit, expected $EXPECTED_COMMIT" >&2
      exit 1
    fi
    actual_tree=$(git -C "$UPSTREAM_REPO" rev-parse "$EXPECTED_COMMIT^{tree}")
    if [ "$actual_tree" != "$EXPECTED_TREE" ]; then
      echo "Ghostty commit tree is $actual_tree, expected $EXPECTED_TREE" >&2
      exit 1
    fi

    if [ -d "$VENDOR" ]; then
      verify_vendor
    fi
    tmp=$(mktemp -d "$CACHE/ghostty-export.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT HUP INT TERM
    git -C "$UPSTREAM_REPO" archive "$EXPECTED_COMMIT" | /usr/bin/tar -xf - -C "$tmp"
    apply_series "$tmp"
    /bin/rm -rf "$VENDOR"
    /bin/mv "$tmp" "$VENDOR"
    trap - EXIT HUP INT TERM
    verify_vendor
    ;;
  *) usage ;;
esac
