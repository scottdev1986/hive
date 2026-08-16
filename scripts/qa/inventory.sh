#!/bin/sh
# Capture and compare filesystem inventories. Every compare prints both input
# paths and the lines that differ.
set -eu

die() { printf 'inventory: %s\n' "$1" >&2; exit 2; }

usage() {
  die "usage: $0 capture-tree <root> <out> | compare <before> <after>"
}

[ "$#" -ge 1 ] || usage
cmd="$1"
shift

emit_entry() {
  path="$1"
  rel="$2"
  if [ -L "$path" ]; then
    printf 'L\t%s\t%s\n' "$rel" "$(readlink "$path")"
  elif [ -f "$path" ]; then
    printf 'F\t%s\t%s\n' "$rel" "$(/usr/bin/shasum -a 256 "$path" | cut -d' ' -f1)"
  elif [ -d "$path" ]; then
    printf 'D\t%s\n' "$rel"
  else
    printf 'O\t%s\n' "$rel"
  fi
}

# Walk without following symlinks. Optional second argument is a directory
# name to prune (used to skip .git so the repo inventory is the working tree).
walk() {
  root="$1"
  prune="${2:-}"
  if [ -n "$prune" ]; then
    /usr/bin/find -P "$root" \( -name "$prune" -prune \) -o -print
  else
    /usr/bin/find -P "$root" -print
  fi
}

write_tree() {
  root="$1"
  prune="${2:-}"
  root="$(cd "$root" && pwd -P)" || die "cannot enter $1"
  printf 'root\t%s\n' "$root"
  walk "$root" "$prune" | while IFS= read -r path; do
    if [ "$path" = "$root" ]; then
      rel="."
    else
      rel="${path#"$root"/}"
    fi
    emit_entry "$path" "$rel"
  done | /usr/bin/sort
}

capture_tree() {
  [ "$#" -eq 2 ] || die "usage: $0 capture-tree <root> <out>"
  root="$1"
  out="$2"
  tmp="$(mktemp "${TMPDIR:-/tmp}/hive-inventory.XXXXXX")"
  if [ ! -e "$root" ]; then
    {
      printf 'kind\ttree\n'
      printf 'root\t%s\n' "$root"
      printf 'state\tabsent\n'
    } >"$tmp"
    /bin/mv -f "$tmp" "$out"
    printf 'inventory: captured absent tree %s -> %s\n' "$root" "$out"
    return 0
  fi
  [ -d "$root" ] || die "not a directory: $root"
  resolved="$(cd "$root" && pwd -P)" || die "cannot enter $root"
  {
    printf 'kind\ttree\n'
    write_tree "$resolved"
  } >"$tmp"
  /bin/mv -f "$tmp" "$out"
  printf 'inventory: captured tree %s -> %s\n' "$resolved" "$out"
}

compare() {
  [ "$#" -eq 2 ] || die "usage: $0 compare <before> <after>"
  before="$1"
  after="$2"
  [ -f "$before" ] || die "missing before inventory: $before"
  [ -f "$after" ] || die "missing after inventory: $after"
  printf 'inventory: comparing\n  before: %s\n  after:  %s\n' "$before" "$after"
  if /usr/bin/diff -u "$before" "$after"; then
    printf 'inventory: identical (%s lines)\n' "$(/usr/bin/wc -l <"$before" | tr -d ' ')"
    return 0
  fi
  printf 'inventory: DIFFER\n' >&2
  return 1
}

case "$cmd" in
  capture-tree) capture_tree "$@" ;;
  compare) compare "$@" ;;
  *) usage ;;
esac
