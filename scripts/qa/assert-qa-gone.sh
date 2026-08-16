#!/bin/sh
# Prove a QA install is no longer on this machine. Prints every path it
# checked so an absence is not silent. Any path that still exists fails.
set -eu

die() { printf 'assert-qa-gone: %s\n' "$1" >&2; exit 2; }

[ "$#" -ge 1 ] || die "usage: $0 <path> [<path>...]"

failed=0
for path in "$@"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    printf 'assert-qa-gone: STILL PRESENT  %s\n' "$path" >&2
    failed=1
  else
    printf 'assert-qa-gone: absent         %s\n' "$path"
  fi
done

if [ "$failed" -ne 0 ]; then
  printf 'assert-qa-gone: machine still carries a qa install\n' >&2
  exit 1
fi
printf 'assert-qa-gone: no listed qa path remains\n'
