#!/usr/bin/env bash
set -euo pipefail

QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$QA_DIR/repo-root.sh"
ROOT="$(qa_repo_root "$QA_DIR")" || exit 2
PRIMARY_ROOT="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"
USER_HOME="${M3_USER_HOME:-$HOME}"
BUILD_ROOT="${M3_BUILD_ROOT:-/Users/scottkellar/Projects/hive/.dev/tmp/opencode/m3-frozen}"
FROZEN="$BUILD_ROOT/source"
DIST="$BUILD_ROOT/dist"
HIVE_BIN="$BUILD_ROOT/hive"
SESSIOND_BIN="$BUILD_ROOT/hive-sessiond"
EVIDENCE="$ROOT/docs/evidence/m3-conformance"
FROZEN_SHA=7840700d

refuse() { echo "m3: refusing: $*" >&2; exit 2; }

candidate_for() {
  case "$1" in
    claude) echo "claude/claude-haiku-4-5-20251001" ;;
    codex) echo "codex/gpt-5.3-codex-spark@high" ;;
    grok) echo "grok/grok-4.5@high" ;;
    kimi) echo "kimi/kimi-code/k3@high" ;;
    opencode) echo "opencode/openai/gpt-5.6-terra" ;;
    *) refuse "unknown vendor $1" ;;
  esac
}

qa_home_for() {
  case "$1:$2" in
    claude:auth) echo /tmp/hvqa-ca ;;
    claude:run) echo /tmp/hvqa-cr ;;
    codex:auth) echo /tmp/hvqa-da ;;
    codex:run) echo /tmp/hvqa-dr ;;
    grok:auth) echo /tmp/hvqa-ga ;;
    grok:run) echo /tmp/hvqa-gr ;;
    kimi:auth) echo /tmp/hvqa-ka ;;
    kimi:run) echo /tmp/hvqa-kr ;;
    opencode:auth) echo /tmp/hvqa-oa ;;
    opencode:run) echo /tmp/hvqa-or ;;
    *) refuse "no QA home for $1 $2" ;;
  esac
}

build_frozen() {
  mkdir -p "$BUILD_ROOT" "$EVIDENCE"
  if [ -d "$FROZEN/.git" ] || [ -f "$FROZEN/.git" ]; then
    git -C "$FROZEN" rev-parse HEAD | grep -q "^$FROZEN_SHA" \
      || refuse "$FROZEN is not the frozen M4 source"
  else
    git -C "$ROOT" worktree add --detach "$FROZEN" "$FROZEN_SHA"
  fi
  if [ ! -e "$FROZEN/node_modules" ]; then
    rm -f "$FROZEN/node_modules"
    ln -s "$PRIMARY_ROOT/node_modules" "$FROZEN/node_modules"
  fi
  rm -rf "$DIST"
  bun run "$FROZEN/src/release/build.ts" \
    --repo-root "$FROZEN" --version 0.0.0 --commit "$FROZEN_SHA" \
    --out "$DIST" --skip-workspace --skip-embeddings
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) refuse "unsupported architecture" ;;
  esac
  install -m 755 "$DIST/hive-darwin-$arch" "$HIVE_BIN"
  install -m 755 "$DIST/hive-sessiond-darwin-$arch" "$SESSIOND_BIN"
  unique_count="$(grep -ac 'hive_mail_publish' "$HIVE_BIN")"
  control_count="$(grep -ac 'Hive daemon ready' "$HIVE_BIN")"
  [ "$unique_count" -ge 1 ] || refuse "compiled binary lacks the M4 mail tool"
  [ "$control_count" -ge 1 ] || refuse "compiled-binary reader failed its positive control"
  cat > "$EVIDENCE/build.json" <<EOF
{
  "frozenSha": "$FROZEN_SHA",
  "sourceHead": "$(git -C "$FROZEN" rev-parse HEAD)",
  "binaryVersion": "$($HIVE_BIN --version)",
  "mailToolStringCount": $unique_count,
  "positiveControlStringCount": $control_count,
  "binaryBytes": $(stat -f %z "$HIVE_BIN"),
  "sessiondBytes": $(stat -f %z "$SESSIOND_BIN")
}
EOF
  set +e
  bun run "$FROZEN/scripts/test-sandbox.ts" -- \
    bun test "$FROZEN/test/daemon/mail-mcp.test.ts" \
    > "$EVIDENCE/terminal-counter-positive-control.txt" 2>&1
  test_status=$?
  set -e
  [ "$test_status" -eq 0 ] || return "$test_status"
}

run_phase() {
  vendor="$1"
  phase="$2"
  candidate="$(candidate_for "$vendor")"
  qa_home="$(qa_home_for "$vendor" "$phase")"
  vendor_evidence="$EVIDENCE/$vendor"
  isolation_evidence="$vendor_evidence/$phase-isolation.json"
  mkdir -p "$vendor_evidence"
  [ -x "$HIVE_BIN" ] || refuse "run build before vendor evidence"
  [ "$(git -C "$FROZEN" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse "$FROZEN_SHA")" ] \
    || refuse "frozen source moved"
  rm -rf "$qa_home"
  if [ "$vendor" = codex ]; then
    mkdir -p "$qa_home"
    printf 'autonomy = "dangerous"\n' > "$qa_home/config.toml"
  fi
  vendor_home="$(mktemp -d "${TMPDIR%/}/m3-${vendor}-${phase}.XXXXXX")"
  user_state="$(mktemp -d "${TMPDIR%/}/m3-user-${vendor}-${phase}.XXXXXX")"
  user_baseline="$user_state/baseline.json"
  chmod 700 "$vendor_home"
  chmod 700 "$user_state"
  mkdir -m 700 "$vendor_home/tmp"
  skip_borrow=0
  [ "$phase" = auth ] && skip_borrow=1
  HOME="$USER_HOME" M3_USER_HOME="$USER_HOME" \
    M3_VENDOR_HOME="$vendor_home" M3_ISOLATION_EVIDENCE="$isolation_evidence" \
    M3_USER_BASELINE="$user_baseline" \
    M3_SKIP_BORROW="$skip_borrow" \
    bun run "$QA_DIR/mail-vendor-isolation.ts" prepare "$vendor"
  qa_project="$vendor_home/project"
  mkdir -m 700 "$qa_project"
  git -C "$qa_project" init -q
  printf '# M3 isolated vendor fixture\n' > "$qa_project/README.md"
  git -C "$qa_project" add README.md
  git -C "$qa_project" -c user.name=m3-fixture -c user.email=m3@localhost \
    commit -qm "fixture root"

  if [ "$phase" = auth ]; then
    phase_command=(bun run "$QA_DIR/mail-vendor-conformance.ts")
  else
    phase_command=(bash "$QA_DIR/mail-vendor-suite.sh")
  fi
  set +e
  HOME="$vendor_home" TMPDIR="$vendor_home/tmp" \
    CODEX_HOME="$vendor_home/.codex" \
    KIMI_CODE_HOME="$vendor_home/.kimi-code" \
    KIMI_CODE_CACHE_DIR="$vendor_home/.cache/kimi" GROK_HOME="$vendor_home/.grok" \
    DISABLE_AUTOUPDATER=1 \
    KIMI_CLI_NO_AUTO_UPDATE=1 \
    GROK_DISABLE_AUTOUPDATER=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
    QA_HOME="$qa_home" QA_SRC_ROOT="$FROZEN" QA_HIVE_BIN="$HIVE_BIN" \
    QA_SESSIOND_BIN="$SESSIOND_BIN" QA_PROJECT="$qa_project" \
    QA_SKIP_POLICY=1 QA_VENDOR="$vendor" QA_ROUTE_CANDIDATE="$candidate" \
    M3_AUTH_PROBE="$([ "$phase" = auth ] && echo 1 || echo 0)" \
    "$QA_DIR/rig.sh" run "${phase_command[@]}"
  run_status=$?
  set -e

  set +e
  HOME="$USER_HOME" M3_USER_HOME="$USER_HOME" \
    M3_VENDOR_HOME="$vendor_home" M3_ISOLATION_EVIDENCE="$isolation_evidence" \
    M3_USER_BASELINE="$user_baseline" \
    bun run "$QA_DIR/mail-vendor-isolation.ts" verify "$vendor" \
    > "$vendor_evidence/$phase-verify.log" 2>&1
  verify_status=$?
  set -e
  if [ -d "$qa_home/artifacts" ]; then
    rm -rf "$vendor_evidence/$phase-artifacts"
    cp -R "$qa_home/artifacts" "$vendor_evidence/$phase-artifacts"
  fi
  for log in daemon.log owner.log init.log; do
    [ ! -f "$qa_home/$log" ] || cp "$qa_home/$log" "$vendor_evidence/$phase-$log"
  done
  HOME="$USER_HOME" M3_USER_HOME="$USER_HOME" \
    M3_VENDOR_HOME="$vendor_home" M3_ISOLATION_EVIDENCE="$isolation_evidence" \
    M3_USER_BASELINE="$user_baseline" \
    bun run "$QA_DIR/mail-vendor-isolation.ts" release "$vendor"
  rm -rf "$vendor_home"
  rm -rf "$user_state"
  [ ! -e "$vendor_home" ] || refuse "vendor credential tree survived teardown"
  [ ! -e "$user_state" ] || refuse "user baseline survived teardown"
  printf '{"vendor":"%s","phase":"%s","runExit":%s,"verifyExit":%s,"credentialTreeRemoved":true}\n' \
    "$vendor" "$phase" "$run_status" "$verify_status" \
    > "$vendor_evidence/$phase-teardown.json"
  rm -rf "$qa_home"
  [ "$run_status" -eq 0 ] || return "$run_status"
  return "$verify_status"
}

mode="${1:-}"
case "$mode" in
  build) build_frozen ;;
  auth|run)
    [ "$#" -eq 2 ] || refuse "usage: $0 $mode <vendor>"
    run_phase "$2" "$mode"
    ;;
  clean)
    git -C "$ROOT" worktree remove --force "$FROZEN" 2>/dev/null || true
    rm -rf "$BUILD_ROOT"
    ;;
  *) refuse "usage: $0 build|auth <vendor>|run <vendor>|clean" ;;
esac
