#!/bin/zsh

set -euo pipefail

die() {
  print -u2 -- "u5-app-driver: $*"
  exit 1
}

for required_name in \
  HIVE_QA_HOME \
  HIVE_QA_PROJECT \
  HIVE_QA_PORT \
  HIVE_QA_ARTIFACTS \
  HIVE_QA_SRC_ROOT \
  HIVE_QA_U5_APP_READY_PATH \
  HIVE_QA_U5_APP_RELEASE_PATH \
  HIVE_QA_U5_APP_FEED_RECEIPT \
  HIVE_QA_U5_APP_EXECUTABLE
do
  [[ -n "${(P)required_name:-}" ]] || die "$required_name is required"
done

QA_HOME=$(realpath "$HIVE_QA_HOME")
QA_PROJECT=$(realpath "$HIVE_QA_PROJECT")
QA_ARTIFACTS=$(realpath "$HIVE_QA_ARTIFACTS")
QA_SOURCE=$(realpath "$HIVE_QA_SRC_ROOT")
QA_PORT=$HIVE_QA_PORT
APP_READY="$(realpath "$(dirname "$HIVE_QA_U5_APP_READY_PATH")")/$(basename "$HIVE_QA_U5_APP_READY_PATH")"
APP_RELEASE="$(realpath "$(dirname "$HIVE_QA_U5_APP_RELEASE_PATH")")/$(basename "$HIVE_QA_U5_APP_RELEASE_PATH")"
FEED_RECEIPT="$(realpath "$(dirname "$HIVE_QA_U5_APP_FEED_RECEIPT")")/$(basename "$HIVE_QA_U5_APP_FEED_RECEIPT")"
APP_EXE=$(realpath "$HIVE_QA_U5_APP_EXECUTABLE")
HIVE_BIN="$QA_ARTIFACTS/hive-bin"
FEED_BIN="$QA_ARTIFACTS/u5-workspace-feed-bridge"

[[ "$QA_HOME" == /private/tmp/hvqa-* || "$QA_HOME" == /tmp/hvqa-* ]] \
  || die "QA home is not an isolated short rig: $QA_HOME"
[[ ${#QA_HOME} -le 20 ]] || die "QA home is too long for sessiond: $QA_HOME"
[[ "$QA_PROJECT" == /private/tmp/* || "$QA_PROJECT" == /tmp/* ]] \
  || die "QA project is outside the temporary root: $QA_PROJECT"
[[ "$QA_PROJECT" != /Users/scottkellar/Projects/hive-test-project ]] \
  || die "refusing the shared hive-test-project"
[[ "$QA_ARTIFACTS" == "$QA_HOME/"* ]] \
  || die "artifact root is outside the isolated home"
[[ "$APP_READY" == "$QA_ARTIFACTS/"* ]] || die "ready path is outside artifacts"
[[ "$APP_RELEASE" == "$QA_ARTIFACTS/"* ]] || die "release path is outside artifacts"
[[ "$FEED_RECEIPT" == "$QA_ARTIFACTS/"* ]] || die "receipt path is outside artifacts"
[[ "$QA_PORT" == <-> && "$QA_PORT" -gt 0 ]] || die "invalid daemon port: $QA_PORT"
[[ -x "$APP_EXE" && "$APP_EXE" == */HiveWorkspace.app/Contents/MacOS/HiveWorkspace ]] \
  || die "not an exact Workspace app executable: $APP_EXE"
[[ -x "$HIVE_BIN" ]] || die "hive-bin is absent: $HIVE_BIN"
[[ -x "$FEED_BIN" ]] || die "feed bridge is absent: $FEED_BIN"
[[ ! -e "$APP_RELEASE" ]] || die "release rendezvous already exists: $APP_RELEASE"
[[ ! -e "$FEED_RECEIPT" ]] || die "feed receipt already exists: $FEED_RECEIPT"

if [[ -n "${HIVE_QA_U5_HARNESS_PID:-}" ]]; then
  [[ "$HIVE_QA_U5_HARNESS_PID" == <-> ]] || die "invalid harness pid"
fi

ready_ok=0
for _ in {1..600}; do
  if [[ -f "$APP_READY" ]] && jq -e '
    .schemaVersion == 1 and
    .state == "ready" and
    (.agents | length) == 5 and
    ([.agents[].provider] | sort) == ["claude", "codex", "grok", "kimi", "opencode"] and
    ([.agents[].agentId] | unique | length) == 5
  ' "$APP_READY" >/dev/null 2>&1; then
    ready_ok=1
    break
  fi
  if [[ -n "${HIVE_QA_U5_HARNESS_PID:-}" ]] \
    && ! /bin/kill -0 "$HIVE_QA_U5_HARNESS_PID" 2>/dev/null; then
    die "harness exited before publishing the ready marker"
  fi
  sleep 1
done
[[ "$ready_ok" == 1 ]] || die "ready marker did not arrive within 10 minutes"

EVIDENCE_ROOT=$(realpath "$(jq -er '.evidenceRoot' "$APP_READY")")
[[ "$EVIDENCE_ROOT" == "$QA_ARTIFACTS/"* ]] \
  || die "ready marker points outside the artifact root: $EVIDENCE_ROOT"

typeset -a PROVIDERS AGENT_IDS SCREENSHOTS APP_ARGS CHILD_PIDS
while IFS=$'\t' read -r provider agent_id; do
  print -r -- "$provider" | grep -Eq '^(claude|codex|grok|kimi|opencode)$' \
    || die "unsafe provider in ready marker: $provider"
  print -r -- "$agent_id" | grep -Eq '^[A-Za-z0-9_-]+$' \
    || die "unsafe agent id in ready marker: $agent_id"
  PROVIDERS+=("$provider")
  AGENT_IDS+=("$agent_id")
done < <(jq -r '.agents[] | [.provider, .agentId] | @tsv' "$APP_READY")
[[ ${#PROVIDERS} -eq 5 && ${#AGENT_IDS} -eq 5 ]] || die "ready marker did not yield five rows"

INSTANCE_ID=$(print -rn -- "$QA_HOME" | shasum -a 256 | awk '{print substr($1, 1, 10)}')
APP_ARGS=(
  --workspace-shell-live
  --port "$QA_PORT"
  --instance-home "$QA_HOME"
  --hive "$HIVE_BIN"
  --project "$QA_PROJECT"
  --instance-id "$INSTANCE_ID"
  --feed "$FEED_BIN"
)
APP_SHA=$(shasum -a 256 "$APP_EXE" | awk '{print $1}')
APP_LOG="$EVIDENCE_ROOT/08-workspace-app.log"
LLDB_LOG="$EVIDENCE_ROOT/08-workspace-lldb.log"
CHILDREN_BEFORE="$EVIDENCE_ROOT/08-workspace-direct-children-before.txt"
PREKILL_PATH="$EVIDENCE_ROOT/08-workspace-prekill-readback.txt"
POSTKILL_PATH="$EVIDENCE_ROOT/08-workspace-postkill-readback.txt"
for fresh_path in "$APP_LOG" "$LLDB_LOG" "$CHILDREN_BEFORE" "$PREKILL_PATH" "$POSTKILL_PATH"; do
  [[ ! -e "$fresh_path" ]] || die "app artifact already exists: $fresh_path"
done

APP_PID=""
RELEASE_TMP=""
cleanup() {
  local exit_code=$?
  if [[ -n "$APP_PID" ]] && /bin/kill -0 "$APP_PID" 2>/dev/null; then
    /bin/kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [[ -n "$RELEASE_TMP" && -e "$RELEASE_TMP" ]]; then
    rm -f "$RELEASE_TMP"
  fi
  return "$exit_code"
}
trap cleanup EXIT INT TERM

LAUNCHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
env \
  -u HIVE_SHELL_PROOF \
  -u HIVE_SHELL_PROOF_MUTATE \
  -u HIVE_SHELL_SCENARIO \
  HIVE_HOME="$QA_HOME" \
  HIVE_QA_HOME="$QA_HOME" \
  HIVE_QA_PROJECT="$QA_PROJECT" \
  HIVE_QA_PORT="$QA_PORT" \
  HIVE_QA_ARTIFACTS="$QA_ARTIFACTS" \
  HIVE_QA_SRC_ROOT="$QA_SOURCE" \
  HIVE_QA_U5_APP_READY_PATH="$APP_READY" \
  HIVE_QA_U5_APP_FEED_RECEIPT="$FEED_RECEIPT" \
  HIVE_QA_U5_VISIBILITY_BASE_REVISION=1 \
  "$APP_EXE" "${APP_ARGS[@]}" >"$APP_LOG" 2>&1 &
APP_PID=$!
VIEWER_PID=$APP_PID

NSAPP='((NSApplication*)[NSApplication sharedApplication])'
lldb_value() {
  local expression=$1 output value
  output=$(/usr/bin/lldb -b -p "$APP_PID" \
    -o "expr -l objc -- $expression" -o detach 2>&1) || true
  print -r -- "$output" >> "$LLDB_LOG"
  value=$(print -r -- "$output" | awk '/\$0 = /{print $NF}' | tail -1)
  [[ -n "$value" ]] || return 1
  print -r -- "$value"
}

window_number() {
  lldb_value "NSArray *wins=[$NSAPP windows]; NSWindow *hit=(NSWindow*)0; for (NSWindow *candidate in wins) { NSMutableArray *q=[NSMutableArray arrayWithObject:[candidate contentView]]; BOOL found=NO; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-workbench\"]) { found=YES; break; } [q addObjectsFromArray:[v subviews]]; } if (found) { hit=candidate; break; } } (long)[hit windowNumber]"
}

click_session() {
  local target_id=$1
  lldb_value "NSArray *wins=[$NSAPP windows]; NSWindow *win=(NSWindow*)0; for (NSWindow *candidate in wins) { NSMutableArray *probe=[NSMutableArray arrayWithObject:[candidate contentView]]; BOOL found=NO; while ([probe count] > 0) { NSView *v=(NSView*)[probe objectAtIndex:0]; [probe removeObjectAtIndex:0]; if ([(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-workbench\"]) { found=YES; break; } [probe addObjectsFromArray:[v subviews]]; } if (found) { win=candidate; break; } } NSMutableArray *q=win ? [NSMutableArray arrayWithObject:[win contentView]] : [NSMutableArray array]; NSButton *hit=(NSButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSButton class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-session-$target_id\"]) { hit=(NSButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } [hit performSelector:@selector(performClick:) withObject:(id)0 afterDelay:0.2]; (long)hit"
}

# Bits: window, exact selected row, one visible terminal child, disabled controls,
# and the honest unknown termination fact. A full observation is 31.
state_mask() {
  local target_id=$1
  lldb_value "NSArray *wins=[$NSAPP windows]; NSWindow *win=(NSWindow*)0; for (NSWindow *candidate in wins) { NSMutableArray *probe=[NSMutableArray arrayWithObject:[candidate contentView]]; BOOL found=NO; while ([probe count] > 0) { NSView *v=(NSView*)[probe objectAtIndex:0]; [probe removeObjectAtIndex:0]; if ([(NSString*)[v accessibilityIdentifier] isEqualToString:@\"live-run-workbench\"]) { found=YES; break; } [probe addObjectsFromArray:[v subviews]]; } if (found) { win=candidate; break; } } NSMutableArray *q=win ? [NSMutableArray arrayWithObject:[win contentView]] : [NSMutableArray array]; long targetCount=0; long targetSelected=0; long selectedRows=0; long hostCount=0; long visibleHostChildren=0; long stopCount=0; long stopDisabled=0; long terminateCount=0; long terminateDisabled=0; long honestUnknownCount=0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; NSString *identifier=(NSString*)[v accessibilityIdentifier]; if ([v isKindOfClass:[NSButton class]] && [identifier hasPrefix:@\"live-run-session-\"]) { NSButton *button=(NSButton*)v; if ((long)[button state] == 1) { selectedRows += 1; } if ([identifier isEqualToString:@\"live-run-session-$target_id\"]) { targetCount += 1; if ((long)[button state] == 1) { targetSelected += 1; } } } if ([identifier isEqualToString:@\"live-run-terminal-host\"]) { hostCount += 1; for (NSView *child in [v subviews]) { if (![child isHidden]) { visibleHostChildren += 1; } } } if ([v isKindOfClass:[NSButton class]] && [[(NSButton*)v title] isEqualToString:@\"Stop Provider\"]) { stopCount += 1; if (![(NSButton*)v isEnabled]) { stopDisabled += 1; } } if ([v isKindOfClass:[NSButton class]] && [[(NSButton*)v title] isEqualToString:@\"Terminate Terminal\"]) { terminateCount += 1; if (![(NSButton*)v isEnabled]) { terminateDisabled += 1; } } if ([v isKindOfClass:[NSTextField class]]) { NSString *text=[(NSTextField*)v stringValue]; if ([text containsString:@\"unknown\"] && [text containsString:@\"process-tree-escapees-unaccounted\"]) { honestUnknownCount += 1; } } [q addObjectsFromArray:[v subviews]]; } long mask=0; if (win) mask|=1; if (targetCount == 1 && targetSelected == 1 && selectedRows == 1) mask|=2; if (hostCount == 1 && visibleHostChildren == 1) mask|=4; if (stopCount == 1 && stopDisabled == 1 && terminateCount == 1 && terminateDisabled == 1) mask|=8; if (honestUnknownCount == 1) mask|=16; mask"
}

WINID=""
for _ in {1..90}; do
  /bin/kill -0 "$APP_PID" 2>/dev/null \
    || die "app exited before its Live Run window appeared: $(tail -20 "$APP_LOG")"
  WINID=$(window_number 2>/dev/null || true)
  [[ -n "$WINID" && "$WINID" != 0 ]] && break
  sleep 1
done
[[ -n "$WINID" && "$WINID" != 0 ]] || die "no Live Run workbench window appeared"

initial_visibility=0
for _ in {1..90}; do
  if [[ -f "$FEED_RECEIPT" ]] && jq -e '
    .schemaVersion == 1 and
    .state == "visibility-accepted" and
    .agentCount == 5 and
    (.acceptedVisibility | length) >= 2 and
    .acceptedVisibility[0].terminalCount == 0 and
    .acceptedVisibility[-1].terminalCount == 1 and
    all(.acceptedVisibility[]; .terminalCount <= 1)
  ' "$FEED_RECEIPT" >/dev/null 2>&1; then
    initial_visibility=1
    break
  fi
  /bin/kill -0 "$APP_PID" 2>/dev/null || die "app exited while waiting for visibility"
  sleep 1
done
[[ "$initial_visibility" == 1 ]] \
  || die "feed did not prove initial zero, attached one, and the one-terminal ceiling"

default_state=0
for _ in {1..60}; do
  mask=$(state_mask "$AGENT_IDS[1]" 2>/dev/null || true)
  if [[ "$mask" == 31 ]]; then
    default_state=1
    break
  fi
  sleep 1
done
[[ "$default_state" == 1 ]] \
  || die "default selected provider never reached the full observable state (mask=${mask:-missing})"

# The feed selects its first exact locator initially. Rotate the order so every
# click changes the exact locator, including the final click back to row one.
for index in 2 3 4 5 1; do
  provider=$PROVIDERS[$index]
  agent_id=$AGENT_IDS[$index]
  before_count=$(jq -er '.acceptedVisibility | length' "$FEED_RECEIPT")
  hit=$(click_session "$agent_id" 2>/dev/null || true)
  [[ -n "$hit" && "$hit" != 0 ]] || die "row control is absent for $provider/$agent_id"

  switched=0
  for _ in {1..90}; do
    mask=$(state_mask "$agent_id" 2>/dev/null || true)
    if [[ "$mask" == 31 ]] && jq -e --argjson base "$before_count" '
      (.acceptedVisibility | length) > $base and
      all(.acceptedVisibility[$base:][]; .terminalCount == 1) and
      all(.acceptedVisibility[]; .terminalCount <= 1)
    ' "$FEED_RECEIPT" >/dev/null 2>&1; then
      switched=1
      break
    fi
    /bin/kill -0 "$APP_PID" 2>/dev/null || die "app exited while switching to $provider"
    sleep 1
  done
  [[ "$switched" == 1 ]] \
    || die "switch to $provider was not observed (mask=${mask:-missing}, priorReceiptCount=$before_count)"

  sleep 2
  screenshot="$EVIDENCE_ROOT/workspace-final-$provider.png"
  [[ ! -e "$screenshot" ]] || die "screenshot already exists: $screenshot"
  /usr/sbin/screencapture -x -o -l "$WINID" "$screenshot" \
    || die "window capture failed for $provider"
  screenshot_size=$(stat -f%z "$screenshot")
  [[ "$screenshot_size" -gt 30000 ]] \
    || die "$provider screenshot is blank or near-blank: $screenshot_size bytes"
  SCREENSHOTS+=("$(realpath "$screenshot")")
done

[[ ${#SCREENSHOTS} -eq 5 ]] || die "did not capture the exact five-provider screenshot set"
jq -e '
  .acceptedVisibility[0].terminalCount == 0 and
  .acceptedVisibility[-1].terminalCount == 1 and
  all(.acceptedVisibility[]; .terminalCount <= 1)
' "$FEED_RECEIPT" >/dev/null || die "final visibility receipt broke the one-terminal ceiling"

/bin/ps -ww -p "$VIEWER_PID" -o pid=,command= > "$PREKILL_PATH.viewer"
VIEWER_LINE=$(<"$PREKILL_PATH.viewer")
rm -f "$PREKILL_PATH.viewer"
EXPECTED_COMMAND="$APP_EXE ${APP_ARGS[*]}"
[[ "$VIEWER_LINE" == *"$EXPECTED_COMMAND"* ]] \
  || die "pre-kill ps readback did not contain the exact launch command: $VIEWER_LINE"

/bin/ps -ww -axo pid=,ppid=,command= \
  | awk -v parent="$VIEWER_PID" '$2 == parent { print }' > "$CHILDREN_BEFORE"
while read -r child_pid _; do
  [[ -n "$child_pid" ]] && CHILD_PIDS+=("$child_pid")
done < "$CHILDREN_BEFORE"
PREKILL_READBACK="$VIEWER_LINE
executableSha256=$APP_SHA
recordedDirectChildren:
$(<"$CHILDREN_BEFORE")"
print -r -- "$PREKILL_READBACK" > "$PREKILL_PATH"

SIGKILL_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
/bin/kill -KILL "$VIEWER_PID"
if wait "$VIEWER_PID" 2>/dev/null; then
  WAIT_STATUS=0
else
  WAIT_STATUS=$?
fi
APP_PID=""
[[ "$WAIT_STATUS" == 137 ]] || die "viewer wait status was $WAIT_STATUS, expected 137"

POST_STDOUT="$EVIDENCE_ROOT/08-workspace-postkill.stdout"
POST_STDERR="$EVIDENCE_ROOT/08-workspace-postkill.stderr"
parent_absent=0
for _ in {1..100}; do
  if /bin/ps -p "$VIEWER_PID" -o pid= >"$POST_STDOUT" 2>"$POST_STDERR"; then
    post_rc=0
  else
    post_rc=$?
  fi
  if [[ "$post_rc" == 1 && ! -s "$POST_STDOUT" && ! -s "$POST_STDERR" ]]; then
    parent_absent=1
    break
  fi
  sleep 0.1
done
[[ "$parent_absent" == 1 ]] \
  || die "viewer pid was not independently absent (exit=$post_rc stdout=$(<"$POST_STDOUT") stderr=$(<"$POST_STDERR"))"

for child_pid in "${CHILD_PIDS[@]}"; do
  child_out="$EVIDENCE_ROOT/08-child-$child_pid-postkill.stdout"
  child_err="$EVIDENCE_ROOT/08-child-$child_pid-postkill.stderr"
  child_absent=0
  for _ in {1..100}; do
    if /bin/ps -p "$child_pid" -o pid= >"$child_out" 2>"$child_err"; then
      child_rc=0
    else
      child_rc=$?
    fi
    if [[ "$child_rc" == 1 && ! -s "$child_out" && ! -s "$child_err" ]]; then
      child_absent=1
      break
    fi
    sleep 0.1
  done
  [[ "$child_absent" == 1 ]] \
    || die "recorded direct child $child_pid survived viewer SIGKILL"
done

POSTKILL_PROBE="ps -p $VIEWER_PID -o pid=: exit=$post_rc stdout=$(jq -Rs . < "$POST_STDOUT") stderr=$(jq -Rs . < "$POST_STDERR"); recordedDirectChildren=${(j:,:)CHILD_PIDS:-none}; allAbsent=true"
print -r -- "$POSTKILL_PROBE" > "$POSTKILL_PATH"
LAUNCH_ARGUMENTS_JSON=$(printf '%s\n' "${APP_ARGS[@]}" | jq -R . | jq -s .)
SCREENSHOTS_JSON=$(printf '%s\n' "${SCREENSHOTS[@]}" | jq -R . | jq -s .)
RELEASE_TMP="$APP_RELEASE.tmp.$VIEWER_PID"
jq -n \
  --argjson viewerPid "$VIEWER_PID" \
  --arg executablePath "$APP_EXE" \
  --argjson launchArguments "$LAUNCH_ARGUMENTS_JSON" \
  --arg launchedAt "$LAUNCHED_AT" \
  --arg preKillProcessReadback "$PREKILL_READBACK" \
  --arg sigkillIssuedAt "$SIGKILL_AT" \
  --arg postKillProbe "$POSTKILL_PROBE" \
  --argjson screenshots "$SCREENSHOTS_JSON" \
  '{
    schemaVersion: 1,
    viewerPid: $viewerPid,
    executablePath: $executablePath,
    launchArguments: $launchArguments,
    launchedAt: $launchedAt,
    preKillProcessReadback: $preKillProcessReadback,
    sigkillIssuedAt: $sigkillIssuedAt,
    waitStatus: "137",
    postKillState: "absent",
    postKillProbe: $postKillProbe,
    screenshots: $screenshots
  }' > "$RELEASE_TMP"
mv "$RELEASE_TMP" "$APP_RELEASE"
RELEASE_TMP=""

print -- "u5-app-driver: release published at $APP_RELEASE"
