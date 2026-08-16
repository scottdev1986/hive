#!/bin/sh
# Inventory the user Hive home for QA isolation checks.
#
# A live fleet writes hive.db-wal, logs, and mail while this runs. Hashing
# those bytes would make every compare red and hide a real leak. This
# listing is the names a leaked QA install would add or remove: top-level
# entries, named instances, run/ and db-identity/ suffixes, and the default
# hive-qa install locations. Content of live databases is not hashed.
set -eu

die() { printf 'isolation-inventory: %s\n' "$1" >&2; exit 2; }

[ "$#" -eq 2 ] || die "usage: $0 <user-hive> <out>"
root="$1"
out="$2"

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

tmp="$(mktemp "${TMPDIR:-/tmp}/hive-isolation.XXXXXX")"
{
  printf 'kind\tisolation\n'
  printf 'root\t%s\n' "$root"
  list_names "$root" top
  list_names "$root/instances" instances
  list_names "$root/run" run
  list_names "$root/db-identity" db-identity
  home="${root%/.hive}"
  list_names "$home/.local/bin" local-bin
  list_names "$home/.local/share" local-share
} >"$tmp"
/bin/mv -f "$tmp" "$out"
printf 'isolation-inventory: captured %s -> %s\n' "$root" "$out"
