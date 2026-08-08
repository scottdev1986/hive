#!/bin/bash
# qa/tour.sh — walk every visible Workspace-shell route, capture one PNG per route,
# and self-check every step so a broken run fails loudly instead of producing
# convincing garbage.
#
#   qa/tour.sh fixture <corpus-dir>                    # any fixture corpus
#   qa/tour.sh live <port> <instance-home> <hive-bin>  # read-only daemon reads
#   qa/tour.sh self-check <corpus-dir>                 # all machine guards must go red
#
# HIVE_SHELL_SCENARIO passes through to the app in fixture mode.
# Artifacts (one PNG per route, the app log, the headless proof line) land in
# $ARTIFACTS, defaulting to a fresh temp dir whose path is printed.
#
# The script builds the workspace package with swift build and nothing else.
# It never invokes the Makefile and never restarts a daemon. Live mode issues
# the same product reads the app performs at launch, plus GET /health and GET
# probes of the product screen paths (the pin's own positive control — not
# app traffic).
#
# Mutation env hooks (self-check re-enters fixture with each one set):
#   TOUR_FORCE_BAD_TITLE=<title>   — nil-click: click a title no button has
#   TOUR_FORCE_TINY_CAPTURE=1      — non-blank: replace each capture with a tiny blob
#   TOUR_FORCE_PERTURB_SETTLE=1    — settledness: corrupt the second capture
#   TOUR_FORCE_CLONE_PREV=1        — inter-route differ: copy prev route over this one
#   TOUR_FORCE_BAD_MENU=1          — interaction nil-control: miss the Hive menu
#   TOUR_FORCE_INTERACTION_TINY=1  — interaction non-blank: damage Agent menu capture
#   TOUR_FORCE_INTERACTION_CLONE=1 — interaction differ: hide the Edit menu pixels
#   TOUR_FORCE_FOCUS_FLICKER=1     — interaction settledness: damage View menu frame two
#   TOUR_FORCE_BAD_POPUP=1         — interaction nil-control: miss the router category popup
#   TOUR_FORCE_BAD_SELECTION=1     — interaction selected-value: reject category read-back
#   TOUR_FORCE_CLOSED_INSPECTOR=1  — interaction post-state: suppress inspector open
#   TOUR_FORCE_STUCK_INSPECTOR=1   — interaction post-state: suppress inspector close
#   TOUR_FORCE_CLOSED_DRAWER=1     — interaction post-state: suppress the drawer open
#   TOUR_FORCE_STUCK_DRAWER=1      — interaction post-state: suppress the drawer close
#   TOUR_FORCE_CLOSED_DIALOG=1     — interaction post-state: suppress the dialog open
#   TOUR_FORCE_STUCK_DIALOG=1      — interaction post-state: suppress the dialog close
#   TOUR_FORCE_UNCHANGED_TEXT=1    — interaction post-state: suppress text entry
#
# TOUR_CALIBRATION=1 records each red and walks on instead of stopping at the
# first, so a run documenting a broken UI still collects every route capture. The
# run still exits non-zero and lists every red.
set -u

# Ambient HIVE_SHELL_PROOF_MUTATE would turn a live proof into a real CAS write
# (WorkspaceShellLaunch reads it; proveOneWrite mutates routing). Strip it for
# every launch so the tour stays read-only even if an user's shell exports it.
unset HIVE_SHELL_PROOF_MUTATE

usage() {
  echo "usage: qa/tour.sh fixture <corpus-dir>" >&2
  echo "       qa/tour.sh live <port> <instance-home> <hive-bin>" >&2
  echo "       qa/tour.sh self-check <corpus-dir>" >&2
  exit 2
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(dirname "$SCRIPT_DIR")/workspace}"
BINARY="$WORKSPACE_ROOT/.build/debug/HiveWorkspace"
ARTIFACTS="${ARTIFACTS:-$(mktemp -d -t workspace-tour)}"

die() {
  echo "FAIL: $*" >&2
  exit 1
}

# The sidebar renders one NSButton per route, titled with a two-space prefix.
# Slugs are the ShellRoute raw values; they name the PNGs.
TITLES=("Live Run" "Task Router" "Models & Quota" "Queen Provider" \
  "Autonomy" "Memory Overview" "Memory Library" "Recall Lab" "Memory Maintenance")
SLUGS=(run router models queen autonomy memory-overview memory-library \
  memory-recall memory-maintenance)

# Product GET paths that feed live screens, paired with the proof field slug
# each path populates (availability-<slug>=…). Probed in live mode so a 404 is
# checked against the screen that actually rendered it — not the active route,
# which defaults to Live Run and has no live endpoint.
# memory/recall-preview is intentionally absent: the app POSTs it (GET is not
# the product path), and its refusal maps to .unknown, never .disconnected.
# Well above the slowest product endpoint: model-control/snapshot answers in
# ~2.8s against ~0.001s for its neighbours, and a 2s ceiling turned that into a
# timeout the pin could not tell apart from a reading. The self-check lowers it
# so the timeout path can be exercised in seconds.
PROBE_TIMEOUT_SECONDS=10

LIVE_ENDPOINT_PROBES=(
  "routing/policy:router"
  "model-control/snapshot:models"
  "memory/overview:memory-overview"
  "memory/library:memory-library"
  "memory/maintenance:memory-maintenance"
)

# Every lldb call targets the recorded PID. Never select the process by name:
# the production Workspace and this test binary both match "HiveWorkspace".
lldb_value() {
  lldb -b -p "$APP_PID" -o "expr -l objc -- $1" -o detach 2>/dev/null \
    | awk '/\$0 = /{print $NF}'
}

# Message sends on id must be cast or lldb rejects the expression outright
# ("no known method"), which is why every send below spells out its receiver
# type.
NSAPP='((NSApplication*)[NSApplication sharedApplication])'

window_number() {
  lldb_value "(long)[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] windowNumber]"
}

# 1 when nothing chrome-like is left to draw. Every part of that claim is
# checked, one by one: no toolbar, a transparent title bar, no title text, and
# all THREE traffic lights hidden — close (0), miniaturize (1) and zoom (2).
# Checking one button and calling it "the traffic lights" fails open on the
# other two, which are just as visible and repaint on focus just as readily.
window_chrome_hidden() {
  lldb_value "NSWindow *tourWindow = (NSWindow*)[[$NSAPP windows] objectAtIndex:0]; BOOL tourNoToolbar = ([tourWindow toolbar] == (NSToolbar*)0); BOOL tourClearBar = (BOOL)[tourWindow titlebarAppearsTransparent]; BOOL tourNoTitle = ((long)[tourWindow titleVisibility] == 1); BOOL tourNoClose = (BOOL)[(NSButton*)[tourWindow standardWindowButton:0] isHidden]; BOOL tourNoMin = (BOOL)[(NSButton*)[tourWindow standardWindowButton:1] isHidden]; BOOL tourNoZoom = (BOOL)[(NSButton*)[tourWindow standardWindowButton:2] isHidden]; (long)(tourNoToolbar && tourClearBar && tourNoTitle && tourNoClose && tourNoMin && tourNoZoom)"
}

# 1 when the window covers everything its screen makes available. Compared
# against visibleFrame because AppKit refuses to put a titled window over the
# menu bar, so frame is a target no such window can ever reach.
window_fills_screen() {
  lldb_value "NSWindow *tourWindow = (NSWindow*)[[$NSAPP windows] objectAtIndex:0]; NSRect tourFrame = (NSRect)[tourWindow frame]; NSRect tourScreen = (NSRect)[(NSScreen*)[tourWindow screen] visibleFrame]; (long)(tourFrame.size.width >= tourScreen.size.width && tourFrame.size.height >= tourScreen.size.height)"
}

# BFS the window's view tree for the button with this exact title and schedule
# a click on the app's own run loop, after detach. Echoes the button pointer:
# [nil performClick:] is a silent no-op, so the CALLER must refuse a zero
# pointer or a missed click turns into a full tour of one screen.
click_route() {
  lldb_value "NSMutableArray *q = [NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSButton *hit = (NSButton*)0; while ([q count] > 0) { NSView *v = (NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSButton class]] && [[(NSButton*)v title] isEqualToString:@\"  $1\"]) { hit = (NSButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } [hit performSelector:@selector(performClick:) withObject:(id)0 afterDelay:1.0]; (long)hit"
}

# Queue an exact main-menu family on the app's run loop. Calling the popup
# method synchronously would keep LLDB attached for the whole menu-tracking
# session; the queued block starts only after detach, leaving capture() free to
# observe the real open menu. objc_msgSend carries the point as its ABI shape
# because LLDB's Objective-C++ expression context cannot pass AppKit's NSPoint.
open_menu() {
  lldb_value "extern void objc_msgSend(void); typedef struct { double x; double y; } TourPoint; NSMenu *hit=(NSMenu*)0; for (NSMenuItem *top in [[$NSAPP mainMenu] itemArray]) { if ([[[top submenu] title] isEqualToString:@\"$1\"]) { hit=[top submenu]; break; } } NSWindow *win=(NSWindow*)[[$NSAPP windows] objectAtIndex:0]; NSView *host=(NSView*)[win contentView]; [[NSOperationQueue mainQueue] addOperationWithBlock:^{ TourPoint p={8.0, [host bounds].size.height-8.0}; ((void(*)(id,SEL,id,TourPoint,id))(void*)&objc_msgSend)(hit, @selector(popUpMenuPositioningItem:atLocation:inView:), (id)0, p, host); }]; (long)hit"
}

close_menu() {
  lldb_value "NSMenu *hit=(NSMenu*)0; for (NSMenuItem *top in [[$NSAPP mainMenu] itemArray]) { if ([[[top submenu] title] isEqualToString:@\"$1\"]) { hit=[top submenu]; break; } } [hit cancelTrackingWithoutAnimation]; (long)hit"
}

# Dispatch one catalog item through the same target/action pair AppKit uses.
# Exact menu and item titles keep a renamed or moved command from silently
# exercising some neighboring action.
invoke_menu_item() {
  lldb_value "NSMenuItem *hit=(NSMenuItem*)0; for (NSMenuItem *top in [[$NSAPP mainMenu] itemArray]) { NSMenu *menu=[top submenu]; if ([[menu title] isEqualToString:@\"$1\"]) { for (NSMenuItem *item in [menu itemArray]) { if ([[item title] isEqualToString:@\"$2\"]) { hit=item; break; } } } } [[NSOperationQueue mainQueue] addOperationWithBlock:^{ [$NSAPP sendAction:[hit action] to:[hit target] from:hit]; }]; (long)hit"
}

open_popup_exact() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSPopUpButton class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"$1\"]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } [hit performSelector:@selector(performClick:) withObject:(id)0 afterDelay:1.0]; (long)hit"
}

open_popup_prefix() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; NSString *tourIdentifier=(NSString*)[v accessibilityIdentifier]; if ([v isKindOfClass:[NSPopUpButton class]] && [tourIdentifier hasPrefix:@\"$1\"] && [(NSPopUpButton*)v isEnabled]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } [hit performSelector:@selector(performClick:) withObject:(id)0 afterDelay:1.0]; (long)hit"
}

close_popup_exact() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSPopUpButton class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"$1\"]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } [[hit menu] cancelTrackingWithoutAnimation]; (long)hit"
}

close_popup_prefix() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; NSString *tourIdentifier=(NSString*)[v accessibilityIdentifier]; if ([v isKindOfClass:[NSPopUpButton class]] && [tourIdentifier hasPrefix:@\"$1\"] && [(NSPopUpButton*)v isEnabled]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } [[hit menu] cancelTrackingWithoutAnimation]; (long)hit"
}

# Pick a different real item and fire the popup's product action. The returned
# value is selectedIndex+1, reserving zero for a missing or one-item control.
select_popup_exact() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSPopUpButton class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"$1\"]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } long tourItemCount=(long)[hit numberOfItems]; long tourNextIndex=tourItemCount > 1 ? (((long)[hit indexOfSelectedItem]+1)%tourItemCount) : -1; if (tourNextIndex >= 0) { [hit selectItemAtIndex:tourNextIndex]; [hit sendAction:[hit action] to:[hit target]]; } tourNextIndex+1"
}

select_popup_prefix() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; NSString *tourIdentifier=(NSString*)[v accessibilityIdentifier]; if ([v isKindOfClass:[NSPopUpButton class]] && [tourIdentifier hasPrefix:@\"$1\"] && [(NSPopUpButton*)v isEnabled]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } long tourItemCount=(long)[hit numberOfItems]; long tourNextIndex=tourItemCount > 1 ? (((long)[hit indexOfSelectedItem]+1)%tourItemCount) : -1; if (tourNextIndex >= 0) { [hit selectItemAtIndex:tourNextIndex]; [hit sendAction:[hit action] to:[hit target]]; } tourNextIndex+1"
}

popup_selected_exact() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSPopUpButton class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"$1\"]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } (long)(hit != (NSPopUpButton*)0 && (long)[hit indexOfSelectedItem] == $2)"
}

popup_selected_prefix() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSPopUpButton *hit=(NSPopUpButton*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; NSString *tourIdentifier=(NSString*)[v accessibilityIdentifier]; if ([v isKindOfClass:[NSPopUpButton class]] && [tourIdentifier hasPrefix:@\"$1\"] && [(NSPopUpButton*)v isEnabled]) { hit=(NSPopUpButton*)v; break; } [q addObjectsFromArray:[v subviews]]; } (long)(hit != (NSPopUpButton*)0 && (long)[hit indexOfSelectedItem] == $2)"
}

view_identifier_exists() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSView *hit=(NSView*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([(NSString*)[v accessibilityIdentifier] isEqualToString:@\"$1\"]) { hit=v; break; } [q addObjectsFromArray:[v subviews]]; } (long)hit"
}

set_text_field() {
  lldb_value "NSMutableArray *q=[NSMutableArray arrayWithObject:[(NSWindow*)[[$NSAPP windows] objectAtIndex:0] contentView]]; NSTextField *hit=(NSTextField*)0; while ([q count] > 0) { NSView *v=(NSView*)[q objectAtIndex:0]; [q removeObjectAtIndex:0]; if ([v isKindOfClass:[NSTextField class]] && [(NSString*)[v accessibilityIdentifier] isEqualToString:@\"$1\"]) { hit=(NSTextField*)v; break; } [q addObjectsFromArray:[v subviews]]; } [hit setStringValue:@\"$2\"]; [[hit window] makeFirstResponder:hit]; (long)(hit != (NSTextField*)0 && [[hit stringValue] isEqualToString:@\"$2\"])"
}

attach_visible_dialog() {
  lldb_value "NSArray *wins=[$NSAPP windows]; NSWindow *main=(NSWindow*)[wins objectAtIndex:0]; NSWindow *dialog=(NSWindow*)0; for (NSWindow *candidate in wins) { if (candidate != main && [candidate isVisible]) { dialog=candidate; break; } } [main addChildWindow:dialog ordered:1]; (long)[dialog windowNumber]"
}

close_visible_dialog() {
  lldb_value "NSArray *wins=[$NSAPP windows]; NSWindow *main=(NSWindow*)[wins objectAtIndex:0]; NSWindow *dialog=(NSWindow*)0; for (NSWindow *candidate in wins) { if (candidate != main && [candidate isVisible]) { dialog=candidate; break; } } [main removeChildWindow:dialog]; [dialog close]; (long)(dialog != (NSWindow*)0 && ![dialog isVisible])"
}

# Deleting any prior file first means a failed capture can never pass the
# checks on a stale image from an earlier run in a caller-supplied $ARTIFACTS.
# TOUR_FORCE_TINY_CAPTURE replaces the capture with a sub-floor blob so the
# non-blank assert fires (self-check re-enters the real tour with this set).
capture() {
  rm -f "$1"
  screencapture -x -o -l "$WINID" "$1" || return 1
  if [ -n "${TOUR_FORCE_TINY_CAPTURE:-}" ]; then
    dd if=/dev/zero of="$1" bs=1024 count=4 status=none 2>/dev/null \
      || dd if=/dev/zero of="$1" bs=1024 count=4 2>/dev/null
  fi
}

# TOUR_FORCE_PERTURB_SETTLE corrupts the second frame so settledness dies.
# Settledness compares the two captures byte for byte, so corrupting the file
# is a faithful corruption of what the guard reads.
perturb_capture() {
  [ -n "${TOUR_FORCE_PERTURB_SETTLE:-}" ] || return 0
  printf 'x' >> "$1"
}

# A window capture that was denied Screen Recording permission comes back
# blank, and a blank PNG compresses to a few KB where a real screen is far
# larger. Echoes what is wrong and returns non-zero, so the caller decides
# whether that ends the run or is recorded and walked past.
png_defect() {
  if [ ! -f "$1" ]; then
    echo "no capture written at $1 (screencapture failed?)"
    return 1
  fi
  local size
  size=$(stat -f%z "$1")
  if [ "$size" -le 30000 ]; then
    echo "$(basename "$1") is ${size} bytes — blank or near-blank capture; check Screen Recording permission"
    return 1
  fi
  return 0
}

# WindowServer re-encodes attached menu shadows on each capture and can move a
# few antialiased channel values while rendering the same settled pixels. sips
# decodes both PNGs through the native image stack; the small byte/count ceiling
# accepts that measured noise while a moved, closed, or focus-lost overlay is
# far beyond either limit.
interaction_pixels_stable() {
  local left="$ARTIFACTS/compare-left.bmp"
  local right="$ARTIFACTS/compare-right.bmp"
  sips -s format bmp "$1" --out "$left" >/dev/null 2>&1 || return 2
  sips -s format bmp "$2" --out "$right" >/dev/null 2>&1 || { rm -f "$left"; return 2; }
  cmp -l "$left" "$right" 2>/dev/null \
    | awk '{ d=$2-$3; if (d<0) d=-d; if (NR>10000 || d>30) { bad=1; exit } } END { exit bad }'
  local result=$?
  rm -f "$left" "$right"
  return "$result"
}

interaction_pixels_identical() {
  local left="$ARTIFACTS/compare-left.bmp"
  local right="$ARTIFACTS/compare-right.bmp"
  sips -s format bmp "$1" --out "$left" >/dev/null 2>&1 || return 2
  sips -s format bmp "$2" --out "$right" >/dev/null 2>&1 || { rm -f "$left"; return 2; }
  cmp -s "$left" "$right"
  local result=$?
  rm -f "$left" "$right"
  return "$result"
}

# Live-mode pin: WorkspaceDaemonClient maps every non-2xx (including 404) onto
# availability=disconnected, so a screen can claim the daemon is gone while
# /health is still 200. For each product endpoint that returns 404, the proof
# field for THAT route (availability-<slug>=…) must not be disconnected.
# The same credential the app itself obtains: ShellLiveStore runs
# `<hive> credential --agent user` with HIVE_HOME set to the instance home
# and reads the Authorization field. Probing with anything else would test a
# path the product never takes.
user_authorization() {
  local raw
  raw=$(HIVE_HOME="$LIVE_INSTANCE_HOME" "$LIVE_HIVE_BIN" credential --agent user 2>/dev/null) \
    || die "could not obtain the user credential from $LIVE_HIVE_BIN"
  printf '%s' "$raw" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["Authorization"])' 2>/dev/null \
    || die "credential helper did not return an Authorization field"
}

assert_live_404_not_false_disconnect() {
  local port="$1"
  local proof_line="$2"
  local auth="$3"
  local health_code ep_code probe_rc path slug entry
  local probed=() hit_404=()
  # /health is the daemon's public, non-authorizing route, so it is probed
  # without a credential exactly as a launcher would.
  health_code=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time "$PROBE_TIMEOUT_SECONDS" \
    "http://127.0.0.1:${port}/health" 2>/dev/null || echo 000)
  [ "$health_code" = "200" ] \
    || die "live tour requires daemon /health 200 (got ${health_code})"

  # The product paths authorize, so an unauthenticated probe answers 401 and a
  # missing endpoint can never show its 404. Carrying the user credential
  # is what makes this pin able to observe the condition it exists to catch.
  for entry in "${LIVE_ENDPOINT_PROBES[@]}"; do
    path="${entry%%:*}"
    slug="${entry##*:}"
    ep_code=$(curl -s -o /dev/null -w '%{http_code}' \
      --max-time "$PROBE_TIMEOUT_SECONDS" \
      -H "Authorization: ${auth}" \
      "http://127.0.0.1:${port}/${path}" 2>/dev/null)
    probe_rc=$?
    # A probe that never answered is not a reading. Folding it into a status
    # code let a slow endpoint read as "not 404" and drop out of the pin's
    # coverage without saying so, which is the blindness this guard exists to
    # prevent — so an unfinished probe is named and fatal, never absorbed.
    if [ "$probe_rc" -ne 0 ]; then
      probed+=("${slug}:timeout")
      if [ "$probe_rc" -eq 28 ]; then
        die "probe of /${path} timed out after ${PROBE_TIMEOUT_SECONDS}s (probed ${probed[*]}) — the pin cannot tell whether ${slug} answers 404, so that route is uncovered"
      fi
      die "probe of /${path} did not complete, curl exit ${probe_rc} (probed ${probed[*]}) — the pin cannot tell whether ${slug} answers 404, so that route is uncovered"
    fi
    probed+=("${slug}:${ep_code}")
    if [ "$ep_code" = "404" ]; then
      hit_404+=("$slug")
      if printf '%s\n' "$proof_line" | grep -q "availability-${slug}=disconnected"; then
        die "daemon /health is 200 and ${path} returned 404, but proof reports availability-${slug}=disconnected (HTTP 404 mislabeled as a lost daemon): $proof_line"
      fi
    fi
  done
  # Always say what the pin observed so an all-200 run is not read as "the pin
  # caught a false disconnect" when it never saw a 404 to check.
  echo "live-pin: probed ${probed[*]}"
  if [ ${#hit_404[@]} -eq 0 ]; then
    echo "live-pin: no product endpoint returned 404 — pin condition did not fire (all probes non-404)"
  else
    echo "live-pin: 404 on ${hit_404[*]} — checked those availability-* fields are not disconnected"
  fi
}

# Re-enter fixture mode under one mutation hook; require a non-zero exit and a
# specific die message so deleting the guard cannot leave self-check green.
# Args: <label> <expect-grep> <corpus> <artifacts-root> [ENV=val ...]
probe_fixture_guard() {
  local label="$1"
  local expect_grep="$2"
  local corpus="$3"
  local root="$4"
  shift 4
  local dir="$root/$label"
  local out="$dir/out.txt"
  local code
  mkdir -p "$dir"
  # Clear every mutation hook, then apply only the ones this probe passes in.
  env -u TOUR_FORCE_BAD_TITLE -u TOUR_FORCE_TINY_CAPTURE \
    -u TOUR_FORCE_PERTURB_SETTLE -u TOUR_FORCE_CLONE_PREV \
    -u TOUR_FORCE_BAD_MENU -u TOUR_FORCE_INTERACTION_TINY \
    -u TOUR_FORCE_INTERACTION_CLONE -u TOUR_FORCE_FOCUS_FLICKER \
    -u TOUR_FORCE_BAD_POPUP -u TOUR_FORCE_BAD_SELECTION \
    -u TOUR_FORCE_CLOSED_INSPECTOR -u TOUR_FORCE_STUCK_INSPECTOR \
    -u TOUR_FORCE_CLOSED_DRAWER \
    -u TOUR_FORCE_STUCK_DRAWER -u TOUR_FORCE_CLOSED_DIALOG \
    -u TOUR_FORCE_STUCK_DIALOG -u TOUR_FORCE_UNCHANGED_TEXT \
    -u TOUR_CALIBRATION \
    "$@" \
    ARTIFACTS="$dir" \
    WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    "$0" fixture "$corpus" >"$out" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then
    die "$label guard did not fire (fixture exited 0)"
  fi
  grep -q "$expect_grep" "$out" \
    || die "$label guard failed for the wrong reason (exit $code): $(cat "$out")"
  echo "self-check: $label goes red (re-entered fixture)"
}

# Exercise interaction-only mutations in one calibration walk. Unique
# slug/guard ledger rows are the positive controls: a mutation that trips an
# earlier copy of the same predicate cannot satisfy the expected row.
probe_interaction_guards() {
  local corpus="$1" root="$2" dir out code expected
  dir="$root/interactions"
  out="$dir/out.txt"
  mkdir -p "$dir"
  env -u TOUR_FORCE_BAD_TITLE -u TOUR_FORCE_TINY_CAPTURE \
    -u TOUR_FORCE_PERTURB_SETTLE -u TOUR_FORCE_CLONE_PREV \
    -u TOUR_FORCE_BAD_MENU -u TOUR_FORCE_INTERACTION_TINY \
    -u TOUR_FORCE_INTERACTION_CLONE -u TOUR_FORCE_FOCUS_FLICKER \
    -u TOUR_FORCE_BAD_POPUP -u TOUR_FORCE_BAD_SELECTION \
    -u TOUR_FORCE_CLOSED_INSPECTOR -u TOUR_FORCE_STUCK_INSPECTOR \
    -u TOUR_FORCE_CLOSED_DRAWER \
    -u TOUR_FORCE_STUCK_DRAWER -u TOUR_FORCE_CLOSED_DIALOG \
    -u TOUR_FORCE_STUCK_DIALOG -u TOUR_FORCE_UNCHANGED_TEXT \
    TOUR_CALIBRATION=1 \
    TOUR_FORCE_BAD_MENU=1 \
    TOUR_FORCE_INTERACTION_TINY=1 \
    TOUR_FORCE_INTERACTION_CLONE=1 \
    TOUR_FORCE_FOCUS_FLICKER=1 \
    TOUR_FORCE_BAD_POPUP=1 \
    TOUR_FORCE_BAD_SELECTION=1 \
    TOUR_FORCE_CLOSED_INSPECTOR=1 \
    TOUR_FORCE_STUCK_INSPECTOR=1 \
    TOUR_FORCE_CLOSED_DRAWER=1 \
    TOUR_FORCE_STUCK_DRAWER=1 \
    TOUR_FORCE_CLOSED_DIALOG=1 \
    TOUR_FORCE_STUCK_DIALOG=1 \
    TOUR_FORCE_UNCHANGED_TEXT=1 \
    ARTIFACTS="$dir" WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    "$0" fixture "$corpus" >"$out" 2>&1
  code=$?
  [ "$code" -ne 0 ] || die "interaction mutation walk exited 0"
  for expected in \
    $'run-menu-hive\tnil-control\t' \
    $'run-menu-edit\tdiffer\t' \
    $'run-menu-view\tsettledness\t' \
    $'run-menu-agent\tnon-blank\t' \
    $'run-inspector\tpost-state\tToggle Inspector did not show the Task inspector content' \
    $'run-inspector\tpost-state\tInspector remained visible after close' \
    $'router-category-popup\tnil-control\t' \
    $'router-category-selected\tselected-value\t' \
    $'run-attention\tpost-state\tAttention action did not make the drawer visible' \
    $'run-attention\tpost-state\tAttention drawer remained visible after close' \
    $'run-modal\tpost-state\tAbout action did not open a visible dialog' \
    $'run-modal\tpost-state\tAbout dialog remained visible after close' \
    $'memory-recall-text\tpost-state\tRecall query did not read back the exact entered text'
  do
    grep -Fq "$expected" "$dir/reds.tsv" \
      || die "interaction guard did not record $expected: $(cat "$dir/reds.tsv")"
    echo "self-check: interaction ${expected//$'\t'/ } goes red"
  done
  [ "$(wc -l < "$dir/reds.tsv")" -eq 13 ] \
    || die "interaction mutation walk recorded unexpected reds: $(cat "$dir/reds.tsv")"
}

# Mutation probes for every machine guard. Each re-enters the real tour path
# (or the live pin function) so deleting a guard cannot leave self-check green.
# Stand-in daemon for the pin's controls, matched to the real one on the two
# axes the pin depends on: /health is public, and product paths authorize
# before they answer. A stand-in that served product paths to any caller would
# let a pin that forgets to authenticate pass here and go blind against a real
# rig — the divergence that hid the /health path itself. A non-empty slow_path
# stalls that one route, standing in for the snapshot endpoint that answers far
# slower than its neighbours. Echoes the server pid.
#
# The server's own output goes to /dev/null: callers read the pid through a
# command substitution, and a background child holding that pipe open would
# keep the substitution waiting for a server that never exits.
start_standin_daemon() {
  local port="$1" token="$2" slow_path="$3" code
  python3 - "$port" "$token" "$slow_path" >/dev/null 2>&1 <<'PY' &
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1])
expected = sys.argv[2]
slow_path = sys.argv[3]

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        if slow_path and path == slow_path:
            time.sleep(5)
        if self.headers.get("Authorization") != expected:
            self.send_response(401)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        return

ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
  local pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 \
      "http://127.0.0.1:${port}/health" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && break
    sleep 0.1
  done
  [ "$code" = "200" ] || { kill "$pid" 2>/dev/null; die "stand-in /health never came up on port $port"; }
  printf '%s' "$pid"
}

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

run_self_check() {
  local corpus="$1"
  local check_dir port fake_pid fake_token proof_bad proof_ok
  local slow_port slow_pid slow_out slow_rc
  check_dir=$(mktemp -d -t tour-self-check)

  # --- nil-click: click a title no sidebar button has ---
  probe_fixture_guard nil-click 'sidebar button .* not found' \
    "$corpus" "$check_dir" \
    TOUR_FORCE_BAD_TITLE='__no_such_sidebar_button__'

  # --- non-blank: capture() downsamples to a sub-floor blob ---
  probe_fixture_guard non-blank 'blank or near-blank capture' \
    "$corpus" "$check_dir" \
    TOUR_FORCE_TINY_CAPTURE=1

  # --- settledness: second capture is corrupted so consecutive frames differ ---
  probe_fixture_guard settledness 'did not settle: consecutive captures differ' \
    "$corpus" "$check_dir" \
    TOUR_FORCE_PERTURB_SETTLE=1

  # --- inter-route differ: this route's PNG is replaced with the previous ---
  probe_fixture_guard differ 'capture is byte-identical to' \
    "$corpus" "$check_dir" \
    TOUR_FORCE_CLONE_PREV=1

  probe_interaction_guards "$corpus" "$check_dir"

  # --- live 404 false-disconnect pin (no app launch; pin function only) ---
  port=$(free_port)
  fake_token="Bearer self-check-user-token"
  fake_pid=$(start_standin_daemon "$port" "$fake_token" "")

  proof_bad="SHELL-PROOF routes=10 wired=6 scenario=current active=run nav=9 drawer=hidden banner=none availability-run=unknown availability-router=disconnected availability-models=disconnected"
  if ( assert_live_404_not_false_disconnect "$port" "$proof_bad" "$fake_token" ) >/dev/null 2>&1; then
    kill "$fake_pid" 2>/dev/null
    die "live 404 pin did not go red when availability-router=disconnected under /health 200 + endpoint 404"
  fi
  echo "self-check: live 404 pin goes red on false disconnect"

  proof_ok="SHELL-PROOF routes=10 wired=6 scenario=current active=run nav=9 drawer=hidden banner=none availability-run=unknown availability-router=unauthorized availability-models=unknown"
  if ! ( assert_live_404_not_false_disconnect "$port" "$proof_ok" "$fake_token" ) >/dev/null 2>&1; then
    kill "$fake_pid" 2>/dev/null
    die "live 404 pin went red on a proof that does not claim disconnection"
  fi
  echo "self-check: live 404 pin stays green when proof does not claim disconnect"

  # Proves the stand-in really authenticates rather than answering every path.
  # With a token it rejects, the product paths return 401, the 404 condition
  # cannot be observed, and the pin stays green even on a proof that claims
  # disconnection — exactly the blindness an unauthenticated probe suffers
  # against the real daemon. If the stand-in ignored the header it would serve
  # 404 here and the pin would go red.
  if ! ( assert_live_404_not_false_disconnect "$port" "$proof_bad" "Bearer wrong" ) >/dev/null 2>&1; then
    kill "$fake_pid" 2>/dev/null
    die "stand-in daemon did not authenticate: a rejected credential still reached a 404"
  fi
  echo "self-check: stand-in authenticates, so an unauthenticated pin goes blind instead of firing"

  kill "$fake_pid" 2>/dev/null
  wait "$fake_pid" 2>/dev/null || true

  # A probe that never answers must be named a timeout and kill the run. This
  # stand-in stalls one product route past a 1s probe ceiling; the pin has to
  # die AND say "timed out", because dying with any other message would mean
  # the stall was still being absorbed as an ordinary reading.
  slow_port=$(free_port)
  slow_pid=$(start_standin_daemon "$slow_port" "$fake_token" "/routing/policy")

  slow_out=$(
    PROBE_TIMEOUT_SECONDS=1
    assert_live_404_not_false_disconnect "$slow_port" "$proof_ok" "$fake_token" 2>&1
  )
  slow_rc=$?
  kill "$slow_pid" 2>/dev/null
  wait "$slow_pid" 2>/dev/null || true
  [ "$slow_rc" -ne 0 ] \
    || die "a probe that never answered did not fail the pin: $slow_out"
  printf '%s' "$slow_out" | grep -q 'timed out' \
    || die "a stalled probe was not reported as a timeout: $slow_out"
  echo "self-check: a probe that never answers is reported as a timeout and is fatal"

  echo "self-check: all machine guards can go red (artifacts=$check_dir)"
  exit 0
}

MODE="${1:-}"
LIVE_PORT=""
LIVE_INSTANCE_HOME=""
LIVE_HIVE_BIN=""
case "$MODE" in
fixture)
  CORPUS="${2:-}"
  [ -d "$CORPUS" ] || usage
  LAUNCH_ARGS=(--workspace-shell "$CORPUS" --workspace-shell-fullscreen)
  ;;
live)
  [ $# -eq 4 ] || usage
  LIVE_PORT="$2"
  LIVE_INSTANCE_HOME="$3"
  LIVE_HIVE_BIN="$4"
  # ShellLiveStore requires --port, --hive, and --instance-home. Project and
  # instance-id are display-only; pick them up from the rig when present.
  LAUNCH_ARGS=(--workspace-shell-live --port "$2" --instance-home "$3" --hive "$4" \
    --workspace-shell-fullscreen)
  if [ -n "${HIVE_QA_PROJECT:-}" ]; then
    LAUNCH_ARGS+=(--project "$HIVE_QA_PROJECT")
  fi
  if [ -n "${HIVE_QA_INSTANCE_ID:-}" ]; then
    LAUNCH_ARGS+=(--instance-id "$HIVE_QA_INSTANCE_ID")
  fi
  ;;
self-check)
  CORPUS="${2:-}"
  [ -d "$CORPUS" ] || usage
  run_self_check "$CORPUS"
  ;;
*)
  usage
  ;;
esac

APP_PID=""
cleanup() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "tour: mode=$MODE artifacts=$ARTIFACTS"

(cd "$WORKSPACE_ROOT" && swift build > "$ARTIFACTS/build.log" 2>&1) \
  || die "swift build failed in $WORKSPACE_ROOT: $(tail -5 "$ARTIFACTS/build.log")"

# Headless proof first: the measured launch line is the machine-readable dump
# of what the shell built (route/nav counts, per-route availability, and in
# live mode the policy revision and library store), and it must agree with the
# window we are about to capture.
# env -u strips ambient mutation even if something re-exported it after unset.
proof=$(env -u HIVE_SHELL_PROOF_MUTATE HIVE_SHELL_PROOF=1 \
  "$BINARY" "${LAUNCH_ARGS[@]}" 2>&1)
code=$?
printf '%s\n' "$proof" > "$ARTIFACTS/proof.txt"
# Named fields the judgment leg and the live false-disconnect pin both read.
printf '%s\n' "$proof" | tr ' ' '\n' | grep '^availability-' \
  > "$ARTIFACTS/proof-availability.txt" || true
[ $code -eq 0 ] || die "headless proof exited $code: $proof"
# Anchored to the proof line and to the fields' trailing spaces, so stray
# output cannot satisfy the check and routes=100 cannot pass as routes=10.
printf '%s\n' "$proof" | grep -q '^SHELL-PROOF routes=10 ' \
  || die "proof line drifted: $proof"
printf '%s\n' "$proof" | grep -q '^SHELL-PROOF .* nav=9 ' \
  || die "proof nav count drifted: $proof"
# Per-route availability must be present so a stale binary without the fields
# cannot leave the live pin vacuous.
for slug in "${SLUGS[@]}"; do
  printf '%s\n' "$proof" | grep -q " availability-${slug}=" \
    || die "proof missing availability-${slug}= field: $proof"
done

if [ "$MODE" = live ]; then
  # Bound to a variable first: a die() inside $( ) would end only the subshell
  # and hand the pin an empty credential, which reads as 401 on every probe and
  # silently blinds the pin instead of failing.
  live_auth=$(user_authorization)
  [ -n "$live_auth" ] \
    || die "could not obtain the user credential for the live 404 pin"
  assert_live_404_not_false_disconnect "$LIVE_PORT" "$proof" "$live_auth"
fi

env -u HIVE_SHELL_PROOF_MUTATE \
  "$BINARY" "${LAUNCH_ARGS[@]}" > "$ARTIFACTS/app.log" 2>&1 &
APP_PID=$!

WINID=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  kill -0 "$APP_PID" 2>/dev/null \
    || die "app exited before showing a window: $(cat "$ARTIFACTS/app.log")"
  WINID=$(window_number)
  [ -n "$WINID" ] && [ "$WINID" -gt 0 ] 2>/dev/null && break
  WINID=""
  sleep 2
done
[ -n "$WINID" ] || die "no window appeared within the wait budget"

# A window number exists as soon as the window does, which says nothing about
# whether it has taken the screen yet. Capturing before it has holds a title
# bar, traffic lights and a toolbar in frame — and the toolbar repaints, which
# reads as a screen that will not settle.
#
# So the two properties the captures depend on are checked directly, on the
# window, before anything is captured: nothing chrome-like left to draw, and the
# frame covering the whole screen. Neither is a proxy, and both fail while the
# window is still an ordinary one.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  hidden=$(window_chrome_hidden)
  fills=$(window_fills_screen)
  [ "$hidden" = "1" ] && [ "$fills" = "1" ] && break
  sleep 1
done
[ "$hidden" = "1" ] \
  || die "window still draws chrome (toolbar, title bar or traffic lights); captures would hold something that repaints on focus"
[ "$fills" = "1" ] \
  || die "window does not cover its screen; captures would miss part of the UI"

# Calibration mode. A run whose purpose is documenting a broken UI must not
# stop at the first red, or it loses the rest of the evidence about the very
# defect it exists to record. Every guard still runs and every failure is still
# a red, named on stderr and appended to the artifacts; only the stopping
# changes, and the run still exits non-zero listing every red it found. Default
# mode keeps the fatal behaviour that regression runs depend on.
REDS=()

# Both ledgers belong to this run. Appending to whatever a reused ARTIFACTS root
# already held would let a stale red outlive the run that found it, and a later
# clean run could exit 0 while the ledger still accuses it.
: > "$ARTIFACTS/reds.tsv"
: > "$ARTIFACTS/routes.tsv"
: > "$ARTIFACTS/interactions.tsv"

route_red() {
  local slug="$1" guard="$2" detail="$3"
  printf '%s\t%s\t%s\n' "$slug" "$guard" "$detail" >> "$ARTIFACTS/reds.tsv"
  if [ -z "${TOUR_CALIBRATION:-}" ]; then
    die "$detail"
  fi
  REDS+=("$slug [$guard] $detail")
  echo "RED $slug [$guard]: $detail" >&2
}

# One line per route so a reader can tell what was actually assessed from what
# was never assessable: a route whose capture came back blank, or identical to
# its neighbour, blocked every judgement that needed to see the screen.
route_status() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$ARTIFACTS/routes.tsv"
}

interaction_status() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$ARTIFACTS/interactions.tsv"
}

interaction_guard() {
  local slug="$1" guard="$2" detail="$3" value="$4"
  if [ -z "$value" ] || [ "$value" = "0" ]; then
    route_red "$slug" "$guard" "$detail"
    return 1
  fi
  return 0
}

# Interaction overlays are captured by the same window-number path as routes:
# WindowServer composites attached menus and popups into the window image. The
# second frame and closed-state comparison prove the overlay both settled and
# visibly opened instead of trusting performClick's return value.
interaction_capture() {
  local slug="$1" png="$2" baseline="$3"
  local second detail identical="" settled=""
  capture "$png"
  if [ -n "${TOUR_FORCE_INTERACTION_TINY:-}" ] && [ "$slug" = "run-menu-agent" ]; then
    dd if=/dev/zero of="$png" bs=1024 count=4 status=none 2>/dev/null \
      || dd if=/dev/zero of="$png" bs=1024 count=4 2>/dev/null
  fi
  if ! detail=$(png_defect "$png"); then
    route_red "$slug" non-blank "$detail"
    return 1
  fi

  # A queued menu can take longer to enter AppKit's tracking loop while the
  # self-check is launching and attaching repeatedly. Retry only while the
  # decoded pixels still prove the control is closed; the differ guard below
  # remains the authority after this bounded readiness wait.
  if [ -n "$baseline" ] && [ -f "$baseline" ]; then
    for _ in 1 2; do
      interaction_pixels_identical "$png" "$baseline"
      [ $? -ne 0 ] && break
      sleep 1
      capture "$png"
      if ! detail=$(png_defect "$png"); then
        route_red "$slug" non-blank "$detail"
        return 1
      fi
    done
  fi

  second="$ARTIFACTS/settle-interaction-$slug.png"
  for _ in 1 2 3 4 5; do
    sleep 1
    capture "$second"
    if [ -n "${TOUR_FORCE_FOCUS_FLICKER:-}" ] && [ "$slug" = "run-menu-view" ]; then
      cp "$ARTIFACTS/$MODE-router.png" "$second"
    fi
    if ! detail=$(png_defect "$second"); then
      route_red "$slug" non-blank "$detail"
      rm -f "$second"
      return 1
    fi
    interaction_pixels_stable "$png" "$second"
    case $? in
    0)
      settled=1
      break
      ;;
    1)
      # The mutation must remain a one-pair red. Real AppKit overlays get a
      # bounded wait for two consecutive settled captures.
      if [ -n "${TOUR_FORCE_FOCUS_FLICKER:-}" ] && [ "$slug" = "run-menu-view" ]; then
        break
      fi
      mv "$second" "$png"
      ;;
    *) die "could not decode interaction captures for settledness: $png $second" ;;
    esac
  done
  if [ -z "$settled" ]; then
    route_red "$slug" settledness \
      "did not settle: consecutive interaction captures differ beyond the decoded-pixel tolerance"
  fi
  rm -f "$second"

  if [ -n "${TOUR_FORCE_INTERACTION_CLONE:-}" ] && [ "$slug" = "run-menu-edit" ]; then
    cp "$baseline" "$png"
  fi
  if [ -n "$baseline" ]; then
    if [ ! -f "$baseline" ]; then
      route_red "$slug" baseline "closed-state baseline $(basename "$baseline") is missing"
      return 1
    fi
    interaction_pixels_identical "$png" "$baseline"
    case $? in
    0) identical=1
       route_red "$slug" differ "interaction capture is byte-identical to its closed state" ;;
    1) ;;
    *) die "cmp failed comparing $png with $(basename "$baseline")" ;;
    esac
  fi
  [ -z "$identical" ]
}

finish_interaction() {
  local slug="$1" before="$2" ok_detail="$3" red_detail="$4"
  if [ "${#REDS[@]}" -eq "$before" ]; then
    interaction_status "$slug" ok "$ok_detail"
    echo "ok $slug -> $ARTIFACTS/$MODE-$slug.png"
  else
    interaction_status "$slug" red "$red_detail"
  fi
}

run_interactions() {
  local run_baseline="$ARTIFACTS/$MODE-run.png"
  local router_baseline="$ARTIFACTS/$MODE-router.png"
  local recall_baseline="$ARTIFACTS/$MODE-memory-recall.png"
  local menu title slug png hit close_hit before ref detail
  local popup_id selected_plus selected_index selected selected_baseline
  local action_hit state dialog_number
  local menu_titles=(Hive Edit View Agent Run Memory Queen Window)
  local menu_slugs=(hive edit view agent run memory queen window)

  hit=$(click_route "Live Run")
  interaction_guard interactions nil-control \
    'Live Run button not found before interaction walk' "$hit" || true
  sleep 3

  for i in "${!menu_titles[@]}"; do
    menu="${menu_titles[$i]}"
    slug="run-menu-${menu_slugs[$i]}"
    png="$ARTIFACTS/$MODE-$slug.png"
    before=${#REDS[@]}
    title="$menu"
    if [ -n "${TOUR_FORCE_BAD_MENU:-}" ] && [ "$slug" = "run-menu-hive" ]; then
      title="__no_such_menu_family__"
    fi
    hit=$(open_menu "$title")
    if ! interaction_guard "$slug" nil-control \
      "menu family \"$title\" not found — no menu opened" "$hit"; then
      interaction_status "$slug" blocked "menu control missing; capture not assessable"
      continue
    fi
    sleep 1
    interaction_capture "$slug" "$png" "$run_baseline" || true
    close_hit=$(close_menu "$menu")
    interaction_guard "$slug" close-control \
      "menu family \"$menu\" disappeared before close" "$close_hit" || true
    sleep 1
    ref="run-menu-${menu_slugs[$i]}.png"
    if [ "$menu" = Queen ]; then
      detail="provider selector open and settled; reference=$ref"
    else
      detail="menu open and settled; reference=$ref"
    fi
    finish_interaction "$slug" "$before" "$detail" \
      "menu evidence has reds; reference=$ref"
  done

  # Inspector visibility is local shell state. The visible panel is the
  # required post-state; a successful menu invocation alone proves nothing.
  before=${#REDS[@]}
  action_hit=$(invoke_menu_item View "Toggle Inspector")
  interaction_guard run-inspector nil-control \
    'View > Toggle Inspector menu item not found' "$action_hit" || true
  sleep 1
  if [ -n "${TOUR_FORCE_CLOSED_INSPECTOR:-}" ]; then
    state=0
  else
    state=$(view_identifier_exists shell-inspector)
    if [ -n "$state" ] && [ "$state" != 0 ]; then
      state=$(view_identifier_exists shell-inspector-criteria-absent)
    fi
  fi
  interaction_guard run-inspector post-state \
    'Toggle Inspector did not show the Task inspector content' "$state" || true
  if [ -n "$state" ] && [ "$state" != 0 ]; then
    interaction_capture run-inspector \
      "$ARTIFACTS/$MODE-run-inspector.png" "$run_baseline" || true
  fi
  if [ -z "${TOUR_FORCE_STUCK_INSPECTOR:-}" ]; then
    invoke_menu_item View "Toggle Inspector" >/dev/null
  fi
  sleep 1
  state=$(view_identifier_exists shell-inspector)
  if [ -n "$state" ] && [ "$state" != 0 ]; then
    route_red run-inspector post-state 'Inspector remained visible after close'
    invoke_menu_item View "Toggle Inspector" >/dev/null
    sleep 1
  fi
  finish_interaction run-inspector "$before" \
    'Task inspector opened, settled, and closed; reference=run-inspector.png' \
    'inspector evidence has reds; reference=run-inspector.png'

  # Return to the route baseline before the reference-paired drawer and dialog
  # captures.
  hit=$(click_route "Live Run")
  interaction_guard run-attention nil-control \
    'Live Run button not found before drawer capture' "$hit" || true
  sleep 2

  before=${#REDS[@]}
  action_hit=$(invoke_menu_item View Attention)
  interaction_guard run-attention nil-control \
    'View > Attention menu item not found' "$action_hit" || true
  sleep 1
  state=$(view_identifier_exists shell-attention-drawer)
  if [ -n "${TOUR_FORCE_CLOSED_DRAWER:-}" ]; then
    state=0
  fi
  interaction_guard run-attention post-state \
    'Attention action did not make the drawer visible' "$state" || true
  if [ -n "$state" ] && [ "$state" != 0 ]; then
    interaction_capture run-attention "$ARTIFACTS/$MODE-run-attention.png" \
      "$run_baseline" || true
  fi
  if [ -z "${TOUR_FORCE_STUCK_DRAWER:-}" ]; then
    invoke_menu_item View Attention >/dev/null
    sleep 1
  fi
  state=$(view_identifier_exists shell-attention-drawer)
  if [ -n "$state" ] && [ "$state" != 0 ]; then
    route_red run-attention post-state 'Attention drawer remained visible after close'
    invoke_menu_item View Attention >/dev/null
    sleep 1
  fi
  finish_interaction run-attention "$before" \
    'drawer opened, settled, and closed; reference=run-attention.png' \
    'drawer evidence has reds; reference=run-attention.png'

  before=${#REDS[@]}
  action_hit=$(invoke_menu_item Hive "About Hive Workspace")
  interaction_guard run-modal nil-control \
    'Hive > About Hive Workspace menu item not found' "$action_hit" || true
  sleep 1
  dialog_number=$(attach_visible_dialog)
  state="$dialog_number"
  if [ -n "${TOUR_FORCE_CLOSED_DIALOG:-}" ]; then
    state=0
  fi
  interaction_guard run-modal post-state \
    'About action did not open a visible dialog' "$state" || true
  if [ -z "$dialog_number" ] || [ "$dialog_number" = 0 ]; then
    interaction_status run-modal blocked \
      'dialog did not open; reference=run-modal.png not assessable'
  else
    interaction_capture run-modal "$ARTIFACTS/$MODE-run-modal.png" \
      "$run_baseline" || true
    if [ -n "${TOUR_FORCE_STUCK_DIALOG:-}" ]; then
      state=0
    else
      state=$(close_visible_dialog)
    fi
    interaction_guard run-modal post-state \
      'About dialog remained visible after close' "$state" || true
    if [ -n "${TOUR_FORCE_STUCK_DIALOG:-}" ]; then
      close_visible_dialog >/dev/null
    fi
    finish_interaction run-modal "$before" \
      'dialog opened, settled, and closed; reference=run-modal.png' \
      'dialog evidence has reds; reference=run-modal.png'
  fi

  hit=$(click_route "Task Router")
  interaction_guard router-category-popup nil-control \
    'Task Router button not found before popup capture' "$hit" || true
  sleep 3

  before=${#REDS[@]}
  popup_id=task-router-category
  if [ -n "${TOUR_FORCE_BAD_POPUP:-}" ]; then
    popup_id=__no_such_router_popup__
  fi
  hit=$(open_popup_exact "$popup_id")
  if ! interaction_guard router-category-popup nil-control \
    "router category popup \"$popup_id\" not found — no popup opened" "$hit"; then
    interaction_status router-category-popup blocked \
      'popup control missing; reference=none (mockup coverage gap)'
  else
    sleep 1
    interaction_capture router-category-popup \
      "$ARTIFACTS/$MODE-router-category-popup.png" "$router_baseline" || true
    close_popup_exact task-router-category >/dev/null
    sleep 1
    finish_interaction router-category-popup "$before" \
      'popup open and settled; reference=none (mockup coverage gap)' \
      'popup evidence has reds; reference=none (mockup coverage gap)'
  fi

  before=${#REDS[@]}
  selected_plus=$(select_popup_exact task-router-category)
  selected_index=$((selected_plus - 1))
  sleep 1
  if [ -n "${TOUR_FORCE_BAD_SELECTION:-}" ]; then
    selected=$(popup_selected_exact task-router-category 9999)
  else
    selected=$(popup_selected_exact task-router-category "$selected_index")
  fi
  interaction_guard router-category-selected selected-value \
    'router category selected value did not survive the product action' "$selected" || true
  interaction_capture router-category-selected \
    "$ARTIFACTS/$MODE-router-category-selected.png" "$router_baseline" || true
  finish_interaction router-category-selected "$before" \
    'selected value read back; reference=none (mockup coverage gap)' \
    'selection evidence has reds; reference=none (mockup coverage gap)'
  selected_baseline="$ARTIFACTS/$MODE-router-category-selected.png"

  before=${#REDS[@]}
  hit=$(open_popup_prefix task-router-effort-)
  if ! interaction_guard router-effort-popup nil-control \
    'no enabled Task Router effort popup found — no popup opened' "$hit"; then
    interaction_status router-effort-popup blocked \
      'popup control missing; reference=none (mockup coverage gap)'
  else
    sleep 1
    interaction_capture router-effort-popup \
      "$ARTIFACTS/$MODE-router-effort-popup.png" "$selected_baseline" || true
    close_popup_prefix task-router-effort- >/dev/null
    sleep 1
    finish_interaction router-effort-popup "$before" \
      'popup open and settled; reference=none (mockup coverage gap)' \
      'popup evidence has reds; reference=none (mockup coverage gap)'
  fi

  before=${#REDS[@]}
  selected_plus=$(select_popup_prefix task-router-effort-)
  selected_index=$((selected_plus - 1))
  sleep 1
  selected=$(popup_selected_prefix task-router-effort- "$selected_index")
  interaction_guard router-effort-selected selected-value \
    'router effort selected value did not survive the product action' "$selected" || true
  interaction_capture router-effort-selected \
    "$ARTIFACTS/$MODE-router-effort-selected.png" "$selected_baseline" || true
  finish_interaction router-effort-selected "$before" \
    'selected value read back; reference=none (mockup coverage gap)' \
    'selection evidence has reds; reference=none (mockup coverage gap)'

  hit=$(click_route "Recall Lab")
  interaction_guard memory-recall-text nil-control \
    'Recall Lab button not found before text entry' "$hit" || true
  sleep 3
  before=${#REDS[@]}
  if [ -n "${TOUR_FORCE_UNCHANGED_TEXT:-}" ]; then
    state=0
  else
    state=$(set_text_field memory-recall-query "tour interaction query")
  fi
  interaction_guard memory-recall-text post-state \
    'Recall query did not read back the exact entered text' "$state" || true
  interaction_capture memory-recall-text \
    "$ARTIFACTS/$MODE-memory-recall-text.png" "$recall_baseline" || true
  finish_interaction memory-recall-text "$before" \
    'exact text read back; reference=none (mockup coverage gap)' \
    'text-entry evidence has reds; reference=none (mockup coverage gap)'
}

prev=""
for i in "${!TITLES[@]}"; do
  title="${TITLES[$i]}"
  slug="${SLUGS[$i]}"
  png="$ARTIFACTS/$MODE-$slug.png"

  # TOUR_FORCE_BAD_TITLE is the deliberate nil-click probe.
  click_title="${TOUR_FORCE_BAD_TITLE:-$title}"
  reds_before=${#REDS[@]}
  hit=$(click_route "$click_title")
  if [ -z "$hit" ] || [ "$hit" = "0" ]; then
    route_red "$slug" nil-click "sidebar button \"$click_title\" not found — nothing was clicked"
    route_status "$slug" blocked "nothing was clicked; nothing about this screen was assessable"
    continue
  fi

  # There is no rendering-finished signal, so settledness is measured instead
  # of guessed: two captures a second apart must be identical. This also
  # catches a stray keystroke landing in the window between captures.
  #
  # The whole capture is compared, with nothing excluded. The walk does not
  # start until the window reports fullscreen AND reserves zero chrome, so no
  # title bar or toolbar is in frame to repaint when focus moves; a focus change
  # takes the fullscreen window off the active Space instead, which makes the
  # capture fail loudly rather than quietly differ.
  sleep 3
  capture "$png"
  if ! detail=$(png_defect "$png"); then
    route_red "$slug" non-blank "$detail"
    route_status "$slug" blocked "capture unusable; nothing about this screen was assessable"
    continue
  fi
  sleep 1
  # screencapture refuses dot-prefixed destinations, so the scratch capture
  # gets a visible name and is removed after the comparison.
  second="$ARTIFACTS/settle-$slug.png"
  capture "$second"
  perturb_capture "$second"
  if ! detail=$(png_defect "$second"); then
    route_red "$slug" non-blank "$detail"
    route_status "$slug" blocked "second capture unusable; settledness not assessable"
    rm -f "$second"
    continue
  fi
  if ! cmp -s "$png" "$second"; then
    route_red "$slug" settledness "did not settle: consecutive captures differ"
  fi
  rm -f "$second"

  # TOUR_FORCE_CLONE_PREV runs after settle so only the inter-route differ
  # guard sees identical pixels across routes.
  if [ -n "${TOUR_FORCE_CLONE_PREV:-}" ] && [ -n "$prev" ]; then
    cp "$prev" "$png"
  fi

  # Two routes rendering the same pixels. The message states that measurement
  # and stops there: it used to assert the click had not landed, and that
  # inference proved wrong — a screen can render blank on both routes while the
  # click lands perfectly well. cmp's exit codes are handled one by one because
  # "could not compare" (>1) must fail the run rather than count as a
  # difference.
  identical=""
  if [ -n "$prev" ]; then
    cmp -s "$png" "$prev"
    case $? in
    0) identical=1
       route_red "$slug" differ "capture is byte-identical to $(basename "$prev")" ;;
    1) ;;
    *) die "cmp failed comparing $png with $(basename "$prev")" ;;
    esac
  fi

  if [ "${#REDS[@]}" -eq "$reds_before" ]; then
    route_status "$slug" ok "captured and settled"
    echo "ok $slug -> $png"
  elif [ -n "$identical" ]; then
    route_status "$slug" blocked "renders the same pixels as the previous route; anything needing to tell the two apart is unassessable here"
  else
    route_status "$slug" red "captured, with reds recorded above"
  fi
  prev="$png"
done

run_interactions

if [ "${#REDS[@]}" -gt 0 ]; then
  echo "tour: ${#TITLES[@]} routes walked, ${#REDS[@]} red(s):"
  printf '  %s\n' "${REDS[@]}"
  echo "tour: route outcomes in $ARTIFACTS/routes.tsv, interaction outcomes in $ARTIFACTS/interactions.tsv, reds in $ARTIFACTS/reds.tsv"
  echo "tour: artifacts=$ARTIFACTS (proof: $(cat "$ARTIFACTS/proof.txt"))"
  exit 1
fi

echo "tour: all ${#TITLES[@]} routes and required interactions captured and self-checked (proof: $(cat "$ARTIFACTS/proof.txt"))"
echo "tour: artifacts=$ARTIFACTS"
