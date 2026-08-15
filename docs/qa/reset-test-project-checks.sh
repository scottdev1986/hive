#!/usr/bin/env bash
# Exercises reset and check against a disposable clone, including mutants that
# remove one cleanup or verification clause at a time.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SELF_DIR/repo-root.sh"
ROOT="$(qa_repo_root "$SELF_DIR")" || exit 2
SOURCE_PROJECT="/Users/scottkellar/Projects/hive-test-project"
SEED="346d619cb64af48c93a465551f36c82176362f71"
SCOPE=""
PROJECT=""
QA_DIR=""
RESET=""
failures=0

pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*" >&2; failures=$((failures + 1)); }

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  case "$SCOPE" in /private/tmp/hvqa-reset-checks.*) /bin/rm -rf "$SCOPE";; esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

run_check_red() {
  local label="$1" expected="$2" output status
  output="$($RESET check 2>&1)"
  status=$?
  if [ "$status" -ne 0 ] && printf '%s\n' "$output" | grep -Fq "$expected"; then
    pass "$label made check red: $expected"
  else
    fail "$label did not make check red for '$expected' (exit $status): $output"
  fi
}

run_check_green() {
  local label="$1" output
  if output="$($RESET check 2>&1)"; then
    pass "$label: $output"
  else
    fail "$label did not make check green: $output"
  fi
}

fresh() {
  $RESET reset >/dev/null 2>&1 || { fail "could not restore the disposable clone"; return 1; }
}

make_mutant() {
  local name="$1" needle="$2" source mutant count
  source="$QA_DIR/reset-test-project.sh"
  mutant="$QA_DIR/$name.sh"
  count="$(grep -Fxc "$needle" "$source")"
  if [ "$count" -ne 1 ]; then
    fail "mutation '$name' matched $count lines instead of exactly one"
    return 1
  fi
  awk -v needle="$needle" '$0 != needle' "$source" > "$mutant" || return 1
  chmod +x "$mutant"
  printf '%s\n' "$mutant"
}

make_replacement_mutant() {
  local name="$1" needle="$2" replacement="$3" source mutant count
  source="$QA_DIR/reset-test-project.sh"
  mutant="$QA_DIR/$name.sh"
  count="$(grep -Fxc "$needle" "$source")"
  [ "$count" -eq 1 ] || return 1
  awk -v needle="$needle" -v replacement="$replacement" \
    '{ print ($0 == needle) ? replacement : $0 }' "$source" > "$mutant" || return 1
  chmod +x "$mutant"
  printf '%s\n' "$mutant"
}

reset_mutation_probe() {
  local label="$1" needle="$2" expected="$3" mutant output status
  if ! mutant="$(make_mutant "mutant-reset-$label" "$needle")"; then
    fail "$label reset mutant could not be built"
    return
  fi
  shift 3
  "$@" || { fail "$label reset-mutant fixture failed"; return; }
  if ! output="$($mutant reset 2>&1)"; then
    fail "$label reset mutant exited nonzero instead of leaving measurable state: $output"
    fresh
    return
  fi
  output="$($RESET check 2>&1)"
  status=$?
  if [ "$status" -ne 0 ] && printf '%s\n' "$output" | grep -Fq "$expected"; then
    pass "$label reset-clause mutant was caught independently: $expected"
  else
    fail "$label reset-clause mutant escaped check (exit $status): $output"
  fi
  fresh
}

check_mutation_probe() {
  local label="$1" needle="$2" expected="$3" mutant output status
  if ! mutant="$(make_mutant "mutant-check-$label" "$needle")"; then
    fail "$label check mutant could not be built"
    return
  fi
  shift 3
  "$@" || { fail "$label check-mutant fixture failed"; return; }
  output="$($RESET check 2>&1)"
  status=$?
  if [ "$status" -eq 0 ] || ! printf '%s\n' "$output" | grep -Fq "$expected"; then
    fail "$label positive-control check did not report '$expected': $output"
    fresh
    return
  fi
  if output="$($mutant check 2>&1)"; then
    pass "$label assertion deletion made its named probe fail"
  else
    fail "$label assertion deletion was masked by another check: $output"
  fi
  fresh
}

fixture_branch() { fresh && git -C "$PROJECT" branch leaked-branch "$SEED"; }
fixture_worktree() { fresh && git -C "$PROJECT" worktree add --detach -q "$SCOPE/leaked-worktree-mutation" "$SEED"; }
fixture_porcelain() { fresh && printf '\nmutation\n' >> "$PROJECT/README.md"; }
fixture_ignored() {
  fresh || return 1
  mkdir -p "$PROJECT/graphify-out"
  printf 'ignored\n' > "$PROJECT/graphify-out/mutation-canary"
}
fixture_head() {
  fresh || return 1
  printf 'advance\n' > "$PROJECT/head-advance"
  git -C "$PROJECT" add head-advance
  git -C "$PROJECT" commit -qm "advance head"
}

SCOPE="$(mktemp -d /private/tmp/hvqa-reset-checks.XXXXXX)" || exit 1
PROJECT="$SCOPE/project"
QA_DIR="$SCOPE/qa"
mkdir "$QA_DIR" || exit 1
if ! git clone -q --no-hardlinks "$SOURCE_PROJECT" "$PROJECT" ||
   ! git -C "$PROJECT" checkout -q -B main "$SEED"; then
  echo "reset checks: could not build the disposable clone" >&2
  exit 1
fi
git -C "$PROJECT" config user.email qa-reset-check@invalid
git -C "$PROJECT" config user.name "QA reset check"
cp "$SELF_DIR/reset-test-project.sh" "$SELF_DIR/test-project-seed" \
  "$SELF_DIR/test-project-persistence.allow" "$QA_DIR/" || exit 1
sed -i '' "s#$SOURCE_PROJECT#$PROJECT#g" \
  "$QA_DIR/reset-test-project.sh" "$QA_DIR/test-project-seed" || exit 1
chmod +x "$QA_DIR/reset-test-project.sh"
RESET="$QA_DIR/reset-test-project.sh"

echo "[1/6] dirty tracked, untracked, ignored, and advanced state"
printf '\ndirty\n' >> "$PROJECT/README.md"
printf 'untracked\n' > "$PROJECT/untracked-canary"
mkdir -p "$PROJECT/graphify-out"
printf 'ignored\n' > "$PROJECT/graphify-out/canary"
printf 'advance\n' > "$PROJECT/advance-canary"
git -C "$PROJECT" add advance-canary
git -C "$PROJECT" commit -qm "advance disposable main"
run_check_red "dirty advanced tree" "HEAD is"
if $RESET reset >/dev/null 2>&1 &&
   [ "$(git -C "$PROJECT" rev-parse HEAD)" = "$SEED" ] &&
   [ ! -e "$PROJECT/untracked-canary" ] &&
   [ ! -e "$PROJECT/graphify-out/canary" ]; then
  pass "reset restored the exact seed and removed dirty residue"
else
  fail "reset did not restore the dirtied tree"
fi
run_check_green "restored dirtied tree"

echo "[2/6] leaked branch and linked worktree"
git -C "$PROJECT" branch leaked-branch "$SEED"
git -C "$PROJECT" worktree add --detach -q "$SCOPE/leaked-worktree" "$SEED"
branch_red="$($RESET check 2>&1)"; branch_status=$?
if [ "$branch_status" -ne 0 ] &&
   printf '%s\n' "$branch_red" | grep -Fq "local branches" &&
   printf '%s\n' "$branch_red" | grep -Fq "worktrees"; then
  pass "one independent check named both branch and worktree leaks"
else
  fail "check did not name both Git leaks: $branch_red"
fi
if $RESET reset >/dev/null 2>&1 &&
   [ ! -e "$SCOPE/leaked-worktree" ] &&
   [ "$(git -C "$PROJECT" for-each-ref --format='%(refname:short)' refs/heads/)" = main ]; then
  pass "reset removed the leaked branch and linked worktree"
else
  fail "reset did not remove both Git leaks"
fi
run_check_green "restored Git topology"

echo "[3/6] persistence allowlist"
mkdir -p "$PROJECT/.hive/memory" "$PROJECT/graphify-out"
printf 'survives\n' > "$PROJECT/.hive/memory/persistence-canary"
printf 'removed\n' > "$PROJECT/graphify-out/ignored-canary"
if $RESET reset >/dev/null 2>&1 &&
   [ "$(cat "$PROJECT/.hive/memory/persistence-canary" 2>/dev/null)" = survives ] &&
   [ ! -e "$PROJECT/graphify-out/ignored-canary" ]; then
  pass "allowlisted canary survived and non-allowlisted ignored canary was removed"
else
  fail "persistence allowlist did not preserve exactly the intended canary"
fi
run_check_green "allowlisted state"
failure_mutant="$(make_replacement_mutant mutant-reset-failure \
  "  reset_remove_worktrees" "  false")"
if [ -n "$failure_mutant" ] && ! "$failure_mutant" reset >/dev/null 2>&1 &&
   [ "$(cat "$PROJECT/.hive/memory/persistence-canary" 2>/dev/null)" = survives ]; then
  pass "a failed reset restored allowlisted state before exiting red"
else
  fail "a failed reset lost allowlisted state or did not exit red"
fi
fresh
mkdir -p "$PROJECT/.hive/memory"
printf 'must be removed\n' > "$PROJECT/.hive/memory/empty-allowlist-canary"
if $RESET reset --empty-allowlist >/dev/null 2>&1 &&
   [ ! -e "$PROJECT/.hive/memory/empty-allowlist-canary" ] &&
   $RESET check --empty-allowlist >/dev/null 2>&1; then
  pass "empty allowlist removed the memory canary and checked green"
else
  fail "empty allowlist did not remove and independently verify the memory canary"
fi
fresh

echo "[4/6] reset-clause mutation probes"
reset_mutation_probe head "  reset_checkout_seed" "HEAD is" fixture_head
reset_mutation_probe branch "  reset_delete_branches" "local branches" fixture_branch
reset_mutation_probe worktree "  reset_remove_worktrees" "worktrees" fixture_worktree
reset_mutation_probe porcelain "  git -C \"\$PROJECT\" reset --hard \"\$SEED\" >/dev/null" "porcelain reports" fixture_porcelain
reset_mutation_probe ignored "  reset_clean_residue" "ignored or untracked residue" fixture_ignored

echo "[5/6] check-assertion mutation probes"
check_mutation_probe branch \
  "  [ \"\$actual\" = \"\$expected\" ] || check_failed \"local branches are not exactly \$expected\"" \
  "local branches" fixture_branch
check_mutation_probe worktree \
  "  [ \"\$actual\" = \"\$expected\" ] || check_failed \"worktrees are not exactly the primary project at the seed\"" \
  "worktrees" fixture_worktree
check_mutation_probe porcelain \
  "    check_porcelain_value \"\$actual\"" \
  "porcelain reports" fixture_porcelain
check_mutation_probe ignored \
  "  [ -z \"\$residue\" ] || check_failed \"ignored or untracked residue remains outside the persistence allowlist\"" \
  "ignored or untracked residue" fixture_ignored

echo "[6/6] HEAD assertion mutation with an isolated reader fault"
fresh
FAKE_BIN="$SCOPE/fake-bin"
mkdir "$FAKE_BIN"
REAL_GIT="$(command -v git)"
cat > "$FAKE_BIN/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = -C ] && [ "\${3:-}" = rev-parse ] && [ "\${4:-}" = HEAD ]; then
  printf '%s\n' ffffffffffffffffffffffffffffffffffffffff
  exit 0
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$FAKE_BIN/git"
if ! head_mutant="$(make_mutant mutant-check-head "    check_head_value \"\$actual\"")"; then
  fail "HEAD check mutant could not be built"
  head_mutant=""
fi
head_original="$(PATH="$FAKE_BIN:$PATH" $RESET check 2>&1)"; head_original_status=$?
if [ -n "$head_mutant" ]; then
  head_mutated="$(PATH="$FAKE_BIN:$PATH" "$head_mutant" check 2>&1)"; head_mutated_status=$?
else
  head_mutated="mutant unavailable"; head_mutated_status=1
fi
if [ "$head_original_status" -ne 0 ] && printf '%s\n' "$head_original" | grep -Fq "HEAD is" &&
   [ "$head_mutated_status" -eq 0 ]; then
  pass "HEAD assertion deletion made its isolated named probe fail"
else
  fail "HEAD assertion mutant was masked or the reader fault was not isolated: original=$head_original mutated=$head_mutated"
fi

if [ "$failures" -ne 0 ]; then
  echo "reset checks: $failures failure(s)" >&2
  exit 1
fi
echo "reset checks: all red proofs and mutation probes passed"
