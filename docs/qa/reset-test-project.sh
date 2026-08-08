#!/usr/bin/env bash
# Restores the designated QA project to its reviewed seed and independently
# measures whether that fresh-start state holds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MANIFEST="$SCRIPT_DIR/test-project-seed"
ALLOWLIST="$SCRIPT_DIR/test-project-persistence.allow"
EXPECTED_PROJECT="/Users/scottkellar/Projects/hive-test-project"

die() { echo "reset-test-project: $*" >&2; exit 2; }

load_manifest() {
  local line key value seen_project=0 seen_branch=0 seen_commit=0
  PROJECT=""
  BRANCH=""
  SEED=""
  [ -f "$MANIFEST" ] || die "missing seed manifest: $MANIFEST"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in *=*) key="${line%%=*}"; value="${line#*=}";; *) die "invalid seed manifest line";; esac
    [ -n "$value" ] || die "empty seed manifest value for $key"
    case "$key" in
      project) [ "$seen_project" -eq 0 ] || die "duplicate seed manifest key: project"; PROJECT="$value"; seen_project=1 ;;
      branch) [ "$seen_branch" -eq 0 ] || die "duplicate seed manifest key: branch"; BRANCH="$value"; seen_branch=1 ;;
      commit) [ "$seen_commit" -eq 0 ] || die "duplicate seed manifest key: commit"; SEED="$value"; seen_commit=1 ;;
      *) die "unknown seed manifest key: $key" ;;
    esac
  done < "$MANIFEST"
  [ "$seen_project$seen_branch$seen_commit" = "111" ] || die "seed manifest must define project, branch, and commit exactly once"
  [ "$PROJECT" = "$EXPECTED_PROJECT" ] || die "project must be the designated target: $EXPECTED_PROJECT"
  [ "$BRANCH" = main ] || die "seed branch must be main"
  case "$SEED" in *[!0-9a-f]*|'') die "seed commit must be a full lowercase object id";; esac
  [ "${#SEED}" -eq 40 ] || die "seed commit must be a full lowercase object id"
  [ -d "$PROJECT" ] && [ ! -L "$PROJECT" ] || die "project is missing or is not a real directory: $PROJECT"
  [ "$(cd "$PROJECT" && pwd -P)" = "$EXPECTED_PROJECT" ] || die "project resolves outside the designated target"
  git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1 || die "project is not a Git repository"
  git -C "$PROJECT" cat-file -e "$SEED^{commit}" 2>/dev/null || die "seed commit is missing: $SEED"
}

validate_allowlist() {
  local line component resolved seen=""
  ALLOWED=()
  [ "$EMPTY_ALLOWLIST" -eq 1 ] && return 0
  [ -f "$ALLOWLIST" ] || die "missing persistence allowlist: $ALLOWLIST"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || die "persistence allowlist contains an empty entry"
    case "$line" in
      /*|./*|*//*|*[\*\?\[]*|*/) ;;
      *) die "persistence entry must be a project-relative directory ending in /: $line" ;;
    esac
    case "$line" in /*|./*|*//*|*[\*\?\[]*) die "invalid persistence entry: $line";; esac
    IFS='/' read -r -a components <<< "$line"
    for component in "${components[@]}"; do
      case "$component" in .|..) die "persistence entry is not normalized: $line";; esac
    done
    case "$seen" in *$'\n'"$line"$'\n'*) die "duplicate persistence entry: $line";; esac
    seen="$seen"$'\n'"$line"$'\n'
    [ ! -L "$PROJECT/$line" ] || die "persistence entry is a symlink: $line"
    [ ! -e "$PROJECT/$line" ] || [ -d "$PROJECT/$line" ] || die "persistence entry is not a directory: $line"
    resolved="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$PROJECT/$line")" || die "could not resolve persistence entry: $line"
    case "$resolved/" in "$PROJECT"/*) ;; *) die "persistence entry resolves outside the project: $line";; esac
    ALLOWED+=("$line")
  done < "$ALLOWLIST"
}

clean_args() {
  CLEAN_ARGS=(-e .git/)
  local entry
  for entry in "${ALLOWED[@]+"${ALLOWED[@]}"}"; do CLEAN_ARGS+=(-e "$entry"); done
}

reset_remove_worktrees() {
  local listing field path
  listing="$(mktemp "${TMPDIR:-/tmp}/hive-reset-worktrees.XXXXXX")"
  git -C "$PROJECT" worktree list --porcelain -z > "$listing"
  while IFS= read -r -d '' field; do
    case "$field" in
      worktree\ *)
        path="${field#worktree }"
        [ "$path" = "$PROJECT" ] || git -C "$PROJECT" worktree remove --force "$path"
        ;;
    esac
  done < "$listing"
  /bin/rm -f "$listing"
}

reset_checkout_seed() {
  git -C "$PROJECT" checkout -B "$BRANCH" "$SEED" >/dev/null
  git -C "$PROJECT" reset --hard "$SEED" >/dev/null
}

reset_delete_branches() {
  local branch
  while IFS= read -r branch; do
    [ "$branch" = "$BRANCH" ] || git -C "$PROJECT" branch -D "$branch" >/dev/null
  done < <(git -C "$PROJECT" for-each-ref --format='%(refname:short)' refs/heads/)
}

reset_clean_residue() {
  clean_args
  git -C "$PROJECT" clean -ffdqx "${CLEAN_ARGS[@]}" >/dev/null
}

reset_state() {
  local stash entry index=0
  stash="$(mktemp -d "${TMPDIR:-/tmp}/hive-reset-persistence.XXXXXX")"
  restore_persistence() {
    local restore_entry restore_index=0
    for restore_entry in "${ALLOWED[@]+"${ALLOWED[@]}"}"; do
      if [ -d "$stash/$restore_index/value" ]; then
        /bin/rm -rf "$PROJECT/$restore_entry"
        mkdir -p "$(dirname "$PROJECT/$restore_entry")"
        mv "$stash/$restore_index/value" "$PROJECT/$restore_entry"
      fi
      restore_index=$((restore_index + 1))
    done
    /bin/rm -rf "$stash"
  }
  # A failed or interrupted Git operation must not turn cleanup failure into
  # persistence loss.
  trap 'restore_persistence' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  for entry in "${ALLOWED[@]+"${ALLOWED[@]}"}"; do
    if [ -d "$PROJECT/$entry" ]; then
      mkdir -p "$stash/$index"
      mv "$PROJECT/$entry" "$stash/$index/value"
    fi
    index=$((index + 1))
  done

  reset_remove_worktrees
  reset_checkout_seed
  reset_delete_branches
  reset_clean_residue
  git -C "$PROJECT" worktree prune

  restore_persistence
  trap - EXIT HUP INT TERM
}

check_state() {
  local failures=0 actual expected residue
  check_failed() { echo "CHECK FAIL: $*" >&2; failures=$((failures + 1)); }
  check_head_value() { [ "$1" = "$SEED" ] || check_failed "HEAD is ${1:-unreadable}, expected $SEED"; }
  check_porcelain_value() { [ -z "$1" ] || check_failed "porcelain reports tracked or untracked changes"; }

  if actual="$(git -C "$PROJECT" rev-parse HEAD 2>/dev/null)"; then
    :
    check_head_value "$actual"
  else
    check_failed "HEAD is unreadable, expected $SEED"
  fi

  actual="$(git -C "$PROJECT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ "$actual" = "$BRANCH" ] || check_failed "current branch is ${actual:-detached}, expected $BRANCH"

  if actual="$(git -C "$PROJECT" status --porcelain=v2 --untracked-files=all 2>/dev/null)"; then
    :
    check_porcelain_value "$actual"
  else
    check_failed "porcelain state is unreadable"
  fi

  actual="$(git -C "$PROJECT" for-each-ref --format='%(refname:short) %(objectname)' refs/heads/)"
  expected="$BRANCH $SEED"
  [ "$actual" = "$expected" ] || check_failed "local branches are not exactly $expected"

  actual="$(git -C "$PROJECT" worktree list --porcelain)"
  expected="worktree $PROJECT
HEAD $SEED
branch refs/heads/$BRANCH"
  [ "$actual" = "$expected" ] || check_failed "worktrees are not exactly the primary project at the seed"

  clean_args
  residue="$(git -C "$PROJECT" clean -ndffx "${CLEAN_ARGS[@]}")"
  [ -z "$residue" ] || check_failed "ignored or untracked residue remains outside the persistence allowlist"

  [ "$failures" -eq 0 ] || return 1
  echo "CHECK PASS: $PROJECT is fresh at $SEED"
}

mode="${1:-}"
shift || true
EMPTY_ALLOWLIST=0
case "${1:-}" in --empty-allowlist) EMPTY_ALLOWLIST=1; shift;; esac
[ "$#" -eq 0 ] || die "usage: $0 reset|check [--empty-allowlist]"
case "$mode" in reset|check) ;; *) die "usage: $0 reset|check [--empty-allowlist]";; esac
command -v python3 >/dev/null || die "python3 is required"
load_manifest
validate_allowlist
if [ "$mode" = reset ]; then
  reset_state
  echo "RESET COMPLETE: $PROJECT restored to $SEED"
else
  check_state
fi
