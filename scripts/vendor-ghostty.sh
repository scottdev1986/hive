#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
VENDOR="$ROOT/vendor/ghostty"
PATCH_DIR="$ROOT/native/ghostty-patches"
SERIES="$PATCH_DIR/series"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}
UPSTREAM_REPO="$CACHE/ghostty-upstream"
EXPECTED_COMMIT=$(/usr/bin/plutil -extract ghostty.commit raw -o - "$LOCK")
EXPECTED_TREE=$(/usr/bin/plutil -extract ghostty.upstreamTree raw -o - "$LOCK")
EXPECTED_PATCHED_TREE=$(/usr/bin/plutil -extract ghostty.patchedTree raw -o - "$LOCK")
EXPECTED_PUBLIC_HEADERS=1
MAX_UPSTREAM_IMPLEMENTATION_FILES=6
MAX_NET_NON_TEST_LINES=3250

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
  # No pipeline here: an `exit 1` inside `series_entries | while ...` only
  # leaves the pipeline subshell, so a missing series entry would still
  # digest the partial payload. Series entries are single awk-emitted
  # tokens, so word splitting is safe.
  for patch in $(series_entries); do
    if [ ! -f "$PATCH_DIR/$patch" ]; then
      echo "patch series entry is missing: $patch" >&2
      /bin/rm -f "$payload"
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

# git apply DISCOVERS the enclosing repository. When the target directory is
# nested inside this repo (default TMPDIR is <repo>/.dev/tmp; fetch cache is
# under the repo), `git -C "$target" apply` resolves the hive checkout as the
# repository and treats $target as a subdirectory — every path in the patch is
# then "outside the subdirectory" and silently IGNORED: applies exit 0 while
# changing nothing. A ceiling at the target's PARENT stops upward discovery so
# apply runs in plain patch mode against the target tree. The ceiling must be
# the parent: git only honours a ceiling while ascending INTO it; a ceiling at
# the start directory itself is ignored (measured: discovery still resolved
# the enclosing repo).
apply_in() {
  dir=$1
  shift
  GIT_CEILING_DIRECTORIES="$(dirname -- "$dir")" git -C "$dir" apply "$@"
}

apply_series() {
  target=$1
  series_entries | while IFS= read -r patch; do
    echo "applying Ghostty patch: $patch"
    apply_in "$target" --whitespace=error-all "$PATCH_DIR/$patch"
  done
}

verify_patch_budget() {
  target=$1
  public_headers=$(/usr/bin/find "$ROOT/native/include" -maxdepth 1 -type f -name '*.h' | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  if [ "$public_headers" -ne "$EXPECTED_PUBLIC_HEADERS" ]; then
    echo "Ghostty patch budget exceeded: expected $EXPECTED_PUBLIC_HEADERS public C header, found $public_headers" >&2
    exit 1
  fi

  # Make ignored new patch files visible to `git diff` without staging their
  # contents. The base tree remains the index/HEAD comparison point.
  git -C "$target" add -N -f .
  set -- $(git -C "$target" diff --unified=1000000 --no-ext-diff | /usr/bin/awk '
    BEGIN { additions = 0; deletions = 0; excluded_additions = 0; excluded_deletions = 0; tests = 0; upstream_files = 0 }
    /^\+\+\+ b\// {
      file = substr($0, 7)
      excluded = file ~ /^src\/build\// || file == "src/terminal/build_options.zig" ||
        file == "src/lib_vt.zig" || file ~ /^src\/testdata\//
      if (!excluded && file != "src/hive_checkpoint.zig") upstream_files++
      in_test = 0
      next
    }
    /^@@ / { next }
    /^\+/ && !/^\+\+\+/ {
      content = substr($0, 2)
      additions++
      if (excluded) excluded_additions++
      if (!excluded && !in_test && content ~ /^test /) in_test = 1
      if (!excluded && in_test) tests++
      if (in_test && content == "}") in_test = 0
      next
    }
    /^-/ && !/^---/ {
      deletions++
      if (excluded) excluded_deletions++
      next
    }
    /^ / {
      content = substr($0, 2)
      if (!excluded && !in_test && content ~ /^test /) in_test = 1
      if (in_test && content == "}") in_test = 0
    }
    END {
      excluded_net = excluded_additions - excluded_deletions
      print upstream_files, additions - deletions - tests - excluded_net
    }
  ')
  upstream_files=$1
  net_non_test_lines=$2
  if [ "$upstream_files" -gt "$MAX_UPSTREAM_IMPLEMENTATION_FILES" ]; then
    echo "Ghostty patch budget exceeded: $upstream_files upstream implementation files > $MAX_UPSTREAM_IMPLEMENTATION_FILES" >&2
    exit 1
  fi
  if [ "$net_non_test_lines" -gt "$MAX_NET_NON_TEST_LINES" ]; then
    echo "Ghostty patch budget exceeded: $net_non_test_lines net non-test lines > $MAX_NET_NON_TEST_LINES" >&2
    exit 1
  fi
}

verify_vendor() {
  if [ ! -d "$VENDOR" ]; then
    echo "vendored Ghostty tree is missing; run scripts/vendor-ghostty.sh fetch" >&2
    exit 1
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-verify.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  /usr/bin/rsync -a --exclude .git --exclude zig-cache/ --exclude .zig-cache/ --exclude zig-out/ \
    "$VENDOR/" "$tmp/"

  reverse=$(series_entries | /usr/bin/awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }')
  if [ -n "$reverse" ]; then
    printf '%s\n' "$reverse" | while IFS= read -r patch; do
      apply_in "$tmp" --reverse --whitespace=error-all "$PATCH_DIR/$patch"
    done
  fi

  git -C "$tmp" init -q
  git -C "$tmp" add -f .
  actual_tree=$(git -C "$tmp" write-tree)
  if [ "$actual_tree" != "$EXPECTED_TREE" ]; then
    echo "vendored Ghostty base tree mismatch: expected $EXPECTED_TREE, found $actual_tree" >&2
    exit 1
  fi

  apply_series "$tmp"
  verify_patch_budget "$tmp"
  git -C "$tmp" add -f .
  actual_patched_tree=$(git -C "$tmp" write-tree)
  if [ "$actual_patched_tree" != "$EXPECTED_PATCHED_TREE" ]; then
    echo "patched Ghostty tree mismatch: expected $EXPECTED_PATCHED_TREE, found $actual_patched_tree" >&2
    exit 1
  fi
  /bin/rm -rf "$tmp/.git"
  if ! /usr/bin/diff -qr -x zig-cache -x .zig-cache -x zig-out "$tmp" "$VENDOR" >/dev/null; then
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
