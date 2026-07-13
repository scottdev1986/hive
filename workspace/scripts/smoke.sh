#!/bin/sh
# Headless end-to-end smoke for HiveWorkspace against the REAL substrate:
# real detached tmux sessions, real SwiftTerm terminals on ptys, and a
# process-boundary feed stub speaking the exact `hive workspace-feed` NDJSON
# contract (the app cannot tell the difference — nothing in-process is mocked).
#
# Usage: workspace/scripts/smoke.sh        (requires tmux; builds via swift)
# Exits 0/1; the app prints its own failure list, this script appends the
# harness-side assertions (sessions survive pane closes, keystrokes really
# landed in tmux).
set -u

cd "$(dirname "$0")/.." || exit 1

RUN_ID="hivesmoke$$"
PROJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-smoke-project.XXXXXX")"
SUPPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-smoke-support.XXXXXX")"
INSTANCE_HOME="$SUPPORT_DIR/instance"
mkdir -p "$INSTANCE_HOME"
SESS_ONE="${RUN_ID}-agent-one"
SESS_TWO="${RUN_ID}-agent-two"
SESS_ORCH="${RUN_ID}-orch"
RT_MARKER="SMOKERT$$"

failures=""
fail() {
    failures="${failures}\n  $1"
}

cleanup() {
    tmux kill-session -t "$SESS_ONE" 2>/dev/null
    tmux kill-session -t "$SESS_TWO" 2>/dev/null
    tmux kill-session -t "$SESS_ORCH" 2>/dev/null
    rm -rf "$PROJECT_DIR" "$SUPPORT_DIR"
}
trap cleanup EXIT

# --- (a) Real detached tmux sessions with recognizable output ---------------
# agent-one ends in an interactive shell so the keystroke round trip has a
# prompt to type at; agent-two chatters forever; orch stands in for the
# selected Workspace orchestrator session.
tmux new-session -d -x 100 -y 30 -s "$SESS_ONE" 'echo AGENT-ONE-ALIVE; exec sh -i' || { echo "SMOKE FAIL: cannot start tmux"; exit 1; }
tmux new-session -d -x 100 -y 30 -s "$SESS_ORCH" 'echo ORCH-ALIVE; exec sh -i'

# --- (b) Feed binary: contract-conformant NDJSON naming those sessions ------
# A process-boundary stub of `hive workspace-feed` for when the real CLI feed
# is unavailable in this harness. It exercises: an error line, unknown fields,
# fractional contextPct, and a closed agent that must never get a pane.
FEED="$SUPPORT_DIR/feed"
cat > "$FEED" <<EOF
#!/bin/sh
printf '{"v":1,"error":"warming up"}\n'
while :; do
  printf '{"v":1,"agents":[{"name":"agent-one","tool":"claude","model":"opus","status":"working","taskDescription":"index the code","tmuxSession":"$SESS_ONE","contextPct":12},{"name":"agent-two","tool":"codex","model":"gpt-5.4","status":"awaiting-approval","taskDescription":"migrate schema","tmuxSession":"$SESS_TWO","contextPct":55.5,"someFutureField":{"ok":true}},{"name":"ghost","tool":"claude","model":"opus","status":"done","taskDescription":"finished","tmuxSession":"gone","contextPct":90,"closedAt":"2026-07-10T00:00:00Z"}]}\n'
  # Like the real feed, exit when stdin closes — an app that fails to hold a
  # stdin pipe open kills its feed at launch, and this is where smoke catches
  # it (panes never appear). read rc=1 is EOF; rc>128 is timeout (keep going).
  read -r -t 1 _ 2>/dev/null
  [ "\$?" -eq 1 ] && exit 0
done
EOF
chmod +x "$FEED"

# --- Fake hive binary: private Workspace orchestrator boundary --------------
FAKE_HIVE="$SUPPORT_DIR/hive"
cat > "$FAKE_HIVE" <<EOF
#!/bin/sh
case "\${1:-}" in
  workspace-orchestrator) exec tmux attach-session -t "$SESS_ORCH" ;;
  *) echo "fake hive: unexpected subcommand: \$*" >&2; exit 64 ;;
esac
EOF
chmod +x "$FAKE_HIVE"

# --- (c) Build and run the app's in-process smoke assertions ----------------
swift build || exit 1
BIN="$(swift build --show-bin-path)/HiveWorkspace"

# The daemon publishes an AgentRecord just before it creates the agent's tmux
# session. Keep agent-two absent for one second so its first attach fails; the
# pane must retry instead of leaving tmux's "can't find session" on screen.
(sleep 1; tmux new-session -d -x 100 -y 30 -s "$SESS_TWO" \
  'while :; do echo AGENT-TWO-ALIVE; sleep 1; done') &

HIVE_SMOKE_AGENTS="agent-one=AGENT-ONE-ALIVE,agent-two=AGENT-TWO-ALIVE" \
HIVE_SMOKE_CLOSED="ghost" \
HIVE_SMOKE_ORCH_MARKER="ORCH-ALIVE" \
HIVE_SMOKE_TYPE_INTO="agent-one" \
HIVE_SMOKE_RT_MARKER="$RT_MARKER" \
HIVE_SMOKE_CLOSE="agent-two" \
"$BIN" --smoke --project "$PROJECT_DIR" --port 0 --hive "$FAKE_HIVE" \
  --instance-id "$RUN_ID" --instance-home "$INSTANCE_HOME" \
  --orchestrator-session "$SESS_ORCH" --feed "$FEED"
app_status=$?
[ "$app_status" -eq 0 ] || fail "app smoke exited $app_status"

# --- Harness-side assertions (the app process is gone now) ------------------
# Closing panes / quitting only detached clients; every session must survive.
tmux has-session -t "$SESS_ONE" 2>/dev/null || fail "agent-one session died (close must detach, never kill)"
tmux has-session -t "$SESS_TWO" 2>/dev/null || fail "agent-two session died (close must detach, never kill)"
tmux has-session -t "$SESS_ORCH" 2>/dev/null || fail "orchestrator session died (window close must detach)"

# No client may still be attached after the app quit.
for sess in "$SESS_ONE" "$SESS_TWO" "$SESS_ORCH"; do
    clients="$(tmux list-clients -t "$sess" 2>/dev/null | wc -l | tr -d ' ')"
    [ "$clients" = "0" ] || fail "$sess still has $clients attached client(s) after quit"
done

# The keystrokes the app typed must have reached the real tmux pane: the full
# round-trip marker only exists as the shell's *output* (it was typed split).
if ! tmux capture-pane -p -S -200 -t "$SESS_ONE" | grep -q "$RT_MARKER"; then
    fail "round-trip marker $RT_MARKER not found in tmux pane (keystrokes did not land)"
fi

if [ -n "$failures" ]; then
    printf 'SMOKE HARNESS FAIL:%b\n' "$failures"
    exit 1
fi
echo "SMOKE HARNESS OK — sessions survived, keystrokes landed in tmux"
