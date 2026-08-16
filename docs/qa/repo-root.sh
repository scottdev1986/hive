# qa/repo-root.sh — the one place the QA tree works out which checkout it is in.
#
# Sourced, never executed:
#
#     QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
#     . "$QA_DIR/repo-root.sh"
#     ROOT="$(qa_repo_root "$QA_DIR")" || exit 2
#
# It searches UPWARD for a real Hive checkout instead of counting directories,
# so nothing in this tree records how deep it sits. The QA scripts used to
# derive the root as "one level up", which was true while they lived at
# <checkout>/qa and silently wrong the moment they moved to <checkout>/docs/qa:
# every script then resolved the root to <checkout>/docs, which has no src/.
# Counting from a new depth would only reset that clock, so nothing here counts.
#
# Sibling QA assets are referenced through the caller's own directory rather
# than through the root, so a future move cannot break the cross-references
# either.

# Prints the checkout root containing the given directory. Fails loudly, naming
# the directory it started from and the marker it wanted, because a root that is
# merely wrong must never reach the daemon, the CLI, or the u5 isolation gate —
# those consume it to decide what is isolated from what.
qa_repo_root() {
  local start="${1:-}"
  if [ -z "$start" ] || [ ! -d "$start" ]; then
    echo "qa: qa_repo_root needs an existing directory, got '${start:-}'" >&2
    return 1
  fi
  local probe
  probe="$(cd "$start" && pwd -P)" || return 1
  while :; do
    # A Hive checkout necessarily has both; <checkout>/docs has neither, which
    # is exactly the confusion this function exists to make impossible.
    if [ -f "$probe/package.json" ] && [ -f "$probe/src/cli.ts" ]; then
      printf '%s\n' "$probe"
      return 0
    fi
    [ "$probe" != "/" ] || break
    probe="$(dirname "$probe")"
  done
  echo "qa: no Hive checkout at or above $start" >&2
  echo "qa: looked for a directory holding both package.json and src/cli.ts" >&2
  return 1
}

# Prints where the QA tree sits inside its own checkout, e.g. `docs/qa`. The rig
# runs harness helpers out of the source tree UNDER TEST, which is not always
# the tree the running script came from (qa/mail-vendor-run.sh points it at a
# frozen worktree). Deriving the subdirectory keeps that meaning without any
# script naming the location.
qa_tree_subdir() {
  local dir="${1:-}" root
  root="$(qa_repo_root "$dir")" || return 1
  dir="$(cd "$dir" && pwd -P)" || return 1
  if [ "$dir" = "$root" ]; then
    echo "qa: the QA tree cannot be the checkout root itself: $dir" >&2
    return 1
  fi
  printf '%s\n' "${dir#"$root"/}"
}
