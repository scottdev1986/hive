#!/bin/sh
# Inventory the user Hive home for QA isolation checks.
#
# A live fleet writes hive.db-wal, logs, and mail while this runs. Hashing
# those bytes would make every compare red and hide a real leak. This
# listing is the names a leaked QA install would add or remove: top-level
# entries, named instances, db-identity/ suffixes, and Hive's own
# default install names (hive, hive-dev, hive-qa) under ~/.local/bin and
# ~/.local/share. Content of live databases is not hashed.
#
# run/ is captured but stripped on compare. The live daemon creates and
# deletes its run suffix while QA is up, and treating that as a leak left
# QA_STATE in place so the next `make qa` refused to start.
#
# Those two directories are a shared user PATH and share root. Other
# products install and update there. Isolation probes only Hive's names; it
# does not walk the directory or record how Claude, Grok, Codex, or anyone
# else is installed. compare rewrites both snapshots to that form so a
# hive-before that listed vendor entries still matches.
set -eu

die() { printf 'isolation-inventory: %s\n' "$1" >&2; exit 2; }

here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)

list_names() {
  dir="$1"
  label="$2"
  printf 'section\t%s\t%s\n' "$label" "$dir"
  if [ ! -e "$dir" ]; then
    printf 'state\tabsent\n'
    return 0
  fi
  if [ -L "$dir" ]; then
    printf 'L\t%s\n' "$(readlink "$dir")"
    return 0
  fi
  if [ ! -d "$dir" ]; then
    printf 'O\tnot-a-directory\n'
    return 0
  fi
  /usr/bin/find -P "$dir" -mindepth 1 -maxdepth 1 -print |
    /usr/bin/sort |
    while IFS= read -r path; do
      name="${path##*/}"
      if [ -L "$path" ]; then
        printf 'L\t%s\t%s\n' "$name" "$(readlink "$path")"
      elif [ -d "$path" ]; then
        printf 'D\t%s\n' "$name"
      elif [ -f "$path" ]; then
        printf 'F\t%s\n' "$name"
      else
        printf 'O\t%s\n' "$name"
      fi
    done
}

# Existence of Hive's own default install names only. Never list the rest of
# the directory: those entries belong to other products.
list_hive_installs() {
  dir="$1"
  label="$2"
  printf 'section\t%s\t%s\n' "$label" "$dir"
  if [ ! -e "$dir" ]; then
    printf 'state\tabsent\n'
    return 0
  fi
  for name in hive hive-dev hive-qa; do
    path="$dir/$name"
    if [ -L "$path" ]; then
      printf 'L\t%s\n' "$name"
    elif [ -d "$path" ]; then
      printf 'D\t%s\n' "$name"
    elif [ -f "$path" ]; then
      printf 'F\t%s\n' "$name"
    elif [ -e "$path" ]; then
      printf 'O\t%s\n' "$name"
    fi
  done
}

canonicalize() {
  /usr/bin/awk '
    BEGIN { FS = OFS = "\t" }
    $1 == "section" { section = $2; print; next }
    section == "run" { next }
    section == "local-bin" || section == "local-share" {
      if ($1 == "state") { print; next }
      if ($1 == "L" || $1 == "F" || $1 == "D" || $1 == "O") {
        if ($2 == "hive" || $2 == "hive-dev" || $2 == "hive-qa") {
          print $1, $2
        }
        next
      }
      print
      next
    }
    { print }
  '
}

canonicalize_file() {
  [ -f "$1" ] || die "missing inventory: $1"
  tmp="$(mktemp "${TMPDIR:-/tmp}/hive-isolation.XXXXXX")"
  canonicalize <"$1" >"$tmp"
  /bin/mv -f "$tmp" "$1"
}

capture() {
  [ "$#" -eq 2 ] || die "usage: $0 <user-hive> <out> | compare <before> <after>"
  root="$1"
  out="$2"
  tmp="$(mktemp "${TMPDIR:-/tmp}/hive-isolation.XXXXXX")"
  {
    printf 'kind\tisolation\n'
    printf 'root\t%s\n' "$root"
    list_names "$root" top
    list_names "$root/instances" instances
    list_names "$root/run" run
    list_names "$root/db-identity" db-identity
    home="${root%/.hive}"
    list_hive_installs "$home/.local/bin" local-bin
    list_hive_installs "$home/.local/share" local-share
  } >"$tmp"
  /bin/mv -f "$tmp" "$out"
  printf 'isolation-inventory: captured %s -> %s\n' "$root" "$out"
}

compare_cmd() {
  [ "$#" -eq 2 ] || die "usage: $0 compare <before> <after>"
  before="$1"
  after="$2"
  canonicalize_file "$before"
  canonicalize_file "$after"
  exec "$here/inventory.sh" compare "$before" "$after"
}

case "${1:-}" in
  compare)
    shift
    compare_cmd "$@"
    ;;
  *)
    capture "$@"
    ;;
esac
