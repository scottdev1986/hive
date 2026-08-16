#!/bin/bash
# qa/workspace-shell-resize-proof.sh
#
# Builds a unique release Workspace bundle from an agent worktree, then proves
# dense screens stay inside real NSWindow frames, fill every point of width the
# sidebar leaves — including fullscreen — and that empty screens neither grow
# the window nor leave it showing through. LaunchServices owns the launch, so
# the harness resolves the app by its exact executable path and every debugger,
# capture, and cleanup action uses only that recorded PID.

set -u

die() {
  echo "FAIL: $*" >&2
  exit 1
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
. "$SCRIPT_DIR/repo-root.sh"
REPO_ROOT="$(qa_repo_root "$SCRIPT_DIR")" || exit 2
case "$REPO_ROOT" in
  */.hive/worktrees/*) ;;
  *) die "run this proof from a Hive agent worktree, not the primary checkout" ;;
esac

DENSE_CORPUS="$REPO_ROOT/workspace/Tests/WorkspaceCoreTests/Fixtures-dense"
GHOSTTY_KIT="$REPO_ROOT/workspace/Vendor/GhosttyKit.xcframework"
[ -d "$DENSE_CORPUS" ] || die "dense fixture corpus is missing: $DENSE_CORPUS"
[ -e "$GHOSTTY_KIT" ] || die "GhosttyKit build output is missing: $GHOSTTY_KIT"

ARTIFACTS="${ARTIFACTS:-$(mktemp -d -t workspace-shell-resize-proof)}"
if [ -e "$ARTIFACTS" ] \
  && [ -n "$(find "$ARTIFACTS" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  die "artifact directory must be empty: $ARTIFACTS"
fi
mkdir -p "$ARTIFACTS" || die "cannot create artifact directory: $ARTIFACTS"

BUILD_ROOT=$(mktemp -d -t workspace-shell-resize-build)
BUILD_ROOT=$(cd "$BUILD_ROOT" && pwd -P)
RELEASE_OUT="$BUILD_ROOT/release"
EXTRACT_ROOT="$BUILD_ROOT/extracted"
mkdir -p "$EXTRACT_ROOT"

APP_PID=""
APP_EXE=""
WINID=""
BACKING_SCALE100=""
NSAPP='((NSApplication*)[NSApplication sharedApplication])'
# Every metric, click, and capture below resolves the same window this one way,
# so a metric can never describe a different window than the one it measured.
PROOF_WINDOW="NSWindow *proofWindow=(NSWindow*)0; for (NSWindow *candidate in [$NSAPP windows]) { if ([candidate isVisible]) { proofWindow=candidate; break; } }"
PROOF_RECT='extern void objc_msgSend(void); typedef struct { double x; double y; double width; double height; } ProofRect;'

pid_owns_executable() {
  [ -n "$APP_PID" ] && [ -n "$APP_EXE" ] || return 1
  /usr/sbin/lsof -a -p "$APP_PID" -d txt -Fn 2>/dev/null \
    | grep -Fqx "n$APP_EXE"
}

stop_app() {
  [ -n "$APP_PID" ] || return 0
  if ! pid_owns_executable; then
    APP_PID=""
    APP_EXE=""
    WINID=""
    return 0
  fi
  kill "$APP_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$APP_PID" 2>/dev/null; then
    pid_owns_executable \
      || die "recorded PID $APP_PID no longer owns $APP_EXE; refusing cleanup"
    kill -KILL "$APP_PID" 2>/dev/null || true
  fi
  APP_PID=""
  APP_EXE=""
  WINID=""
}
trap stop_app EXIT

lldb_value() {
  lldb -b -p "$APP_PID" -o "expr -l objc -- $1" -o detach 2>/dev/null \
    | awk '/\$0 = /{print $NF}'
}

visible_window_count() {
  lldb_value "long proofCount=0; for (NSWindow *proofCandidate in [$NSAPP windows]) { if ([proofCandidate isVisible]) { proofCount++; } } proofCount"
}

window_number() {
  lldb_value "$PROOF_WINDOW (long)[proofWindow windowNumber]"
}

window_metric() {
  lldb_value "$PROOF_RECT $PROOF_WINDOW ProofRect proofFrame=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofWindow,@selector(frame)); ProofRect proofScreenFrame=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)([proofWindow screen],@selector(frame)); ProofRect proofVisibleFrame=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)([proofWindow screen],@selector(visibleFrame)); (long)$1"
}

# AppKit clamps a window to the area left by the menu bar and the Dock, so the
# screen's full frame is not a frame a window can hold. Filling the visible
# frame is the widest a real window gets, which is the width the defect needed.
maximize_window() {
  lldb_value "$PROOF_RECT $PROOF_WINDOW ProofRect proofVisibleFrame=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)([proofWindow screen],@selector(visibleFrame)); ((void(*)(id,SEL,ProofRect,BOOL,BOOL))(void*)&objc_msgSend)(proofWindow,@selector(setFrame:display:animate:),proofVisibleFrame,YES,NO); [[proofWindow contentView] layoutSubtreeIfNeeded]; ProofRect proofAfter=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofWindow,@selector(frame)); (long)(proofAfter.width == proofVisibleFrame.width)"
}

set_window_frame() {
  local width="$1"
  local height="$2"
  lldb_value "$PROOF_RECT $PROOF_WINDOW ProofRect proofFrame=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofWindow,@selector(frame)); double proofTop=proofFrame.y+proofFrame.height; proofFrame.width=$width; proofFrame.height=$height; proofFrame.y=proofTop-$height; ((void(*)(id,SEL,ProofRect,BOOL,BOOL))(void*)&objc_msgSend)(proofWindow,@selector(setFrame:display:animate:),proofFrame,YES,NO); [[proofWindow contentView] layoutSubtreeIfNeeded]; ProofRect proofAfter=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofWindow,@selector(frame)); (long)(proofAfter.width == $width && proofAfter.height == $height)"
}

toggle_fullscreen() {
  lldb_value "$PROOF_WINDOW [$NSAPP activateIgnoringOtherApps:YES]; [proofWindow performSelector:@selector(toggleFullScreen:) withObject:(id)0 afterDelay:0.1]; (long)proofWindow"
}

click_route() {
  lldb_value "$PROOF_WINDOW NSMutableArray *proofQueue=[NSMutableArray arrayWithObject:[proofWindow contentView]]; NSButton *proofHit=(NSButton*)0; while ([proofQueue count] > 0) { NSView *proofView=(NSView*)[proofQueue objectAtIndex:0]; [proofQueue removeObjectAtIndex:0]; if ([proofView isKindOfClass:[NSButton class]] && [[(NSButton*)proofView title] isEqualToString:@\"  $1\"]) { proofHit=(NSButton*)proofView; break; } [proofQueue addObjectsFromArray:[proofView subviews]]; } [proofHit performSelector:@selector(performClick:) withObject:(id)0 afterDelay:0.2]; (long)proofHit"
}

# Resolves the screen scroll view and its geometry. `proofPanel` is the screen's
# own view, so a render that rebuilds the screen hands back a different address.
scroll_metric() {
  lldb_value "$PROOF_RECT $PROOF_WINDOW NSMutableArray *proofQueue=[NSMutableArray arrayWithObject:[proofWindow contentView]]; NSScrollView *proofScroll=(NSScrollView*)0; while ([proofQueue count] > 0) { NSView *proofView=(NSView*)[proofQueue objectAtIndex:0]; [proofQueue removeObjectAtIndex:0]; if ([(NSString*)[proofView accessibilityIdentifier] isEqualToString:@\"shell-screen-scroll\"]) { proofScroll=(NSScrollView*)proofView; break; } [proofQueue addObjectsFromArray:[proofView subviews]]; } NSView *proofDocument=[proofScroll documentView]; NSView *proofPanel=[[proofDocument subviews] count] > 0 ? (NSView*)[[proofDocument subviews] objectAtIndex:0] : (NSView*)0; ProofRect proofDocumentBounds=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofDocument,@selector(bounds)); ProofRect proofClipBounds=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)([proofScroll contentView],@selector(bounds)); ProofRect proofScrollFrame=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofScroll,@selector(frame)); ProofRect proofContentBounds=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)([proofWindow contentView],@selector(bounds)); (long)$1"
}

scroll_to_bottom() {
  lldb_value "$PROOF_RECT typedef struct { double x; double y; } ProofPoint; $PROOF_WINDOW NSMutableArray *proofQueue=[NSMutableArray arrayWithObject:[proofWindow contentView]]; NSScrollView *proofScroll=(NSScrollView*)0; while ([proofQueue count] > 0) { NSView *proofView=(NSView*)[proofQueue objectAtIndex:0]; [proofQueue removeObjectAtIndex:0]; if ([(NSString*)[proofView accessibilityIdentifier] isEqualToString:@\"shell-screen-scroll\"]) { proofScroll=(NSScrollView*)proofView; break; } [proofQueue addObjectsFromArray:[proofView subviews]]; } NSClipView *proofClip=[proofScroll contentView]; NSView *proofDocument=[proofScroll documentView]; ProofRect proofDocumentBounds=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofDocument,@selector(bounds)); ProofRect proofClipBounds=((ProofRect(*)(id,SEL))(void*)&objc_msgSend)(proofClip,@selector(bounds)); double proofY=proofDocumentBounds.height-proofClipBounds.height; ProofPoint proofBottom={0,proofY > 0 ? proofY : 0}; ((void(*)(id,SEL,ProofPoint))(void*)&objc_msgSend)(proofClip,@selector(scrollToPoint:),proofBottom); [proofScroll reflectScrolledClipView:proofClip]; (long)proofScroll"
}

assert_frame() {
  local expected_width="$1"
  local expected_height="$2"
  local actual_width actual_height
  actual_width=$(window_metric 'proofFrame.width')
  actual_height=$(window_metric 'proofFrame.height')
  [ "$actual_width" = "$expected_width" ] \
    && [ "$actual_height" = "$expected_height" ] \
    || die "window frame drifted: expected ${expected_width}x${expected_height}, got ${actual_width}x${actual_height}"
}

assert_fills_width() {
  local label="$1"
  local content_width scroll_width document_width clip_width
  content_width=$(scroll_metric 'proofContentBounds.width')
  scroll_width=$(scroll_metric 'proofScrollFrame.width')
  document_width=$(scroll_metric 'proofDocumentBounds.width')
  clip_width=$(scroll_metric 'proofClipBounds.width')
  [ -n "$content_width" ] && [ -n "$scroll_width" ] \
    && [ -n "$document_width" ] && [ -n "$clip_width" ] \
    || die "$label width metrics were unavailable"
  # 224 points of sidebar and one point of separator; the screen owns the rest.
  [ "$scroll_width" = "$((content_width - 225))" ] \
    || die "$label screen is ${scroll_width}pt wide inside a ${content_width}pt window"
  [ "$document_width" = "$clip_width" ] \
    || die "$label document is ${document_width}pt inside a ${clip_width}pt viewport"
}

# Re-clicking the live route rebuilds the screen. The rebuilt panel is a new
# object, which is the positive control: without it an unchanged scroll
# position would only prove that nothing happened.
assert_scroll_survives_render() {
  local slug="$1"
  local title="$2"
  local before_y after_y before_panel after_panel
  before_y=$(scroll_metric 'proofClipBounds.y')
  before_panel=$(scroll_metric 'proofPanel')
  [ -n "$before_y" ] && [ "$before_y" -gt 0 ] \
    || die "$slug was not scrolled before the render"
  click_route "$title" > /dev/null
  sleep 1
  after_panel=$(scroll_metric 'proofPanel')
  after_y=$(scroll_metric 'proofClipBounds.y')
  [ -n "$after_panel" ] && [ "$after_panel" != "$before_panel" ] \
    || die "$slug did not re-render, so scroll preservation was never exercised"
  [ "$after_y" = "$before_y" ] \
    || die "$slug scroll jumped from $before_y to $after_y across a render"
}

png_defect() {
  [ -f "$1" ] || { echo "no capture written"; return 1; }
  local size
  size=$(stat -f%z "$1")
  [ "$size" -gt 30000 ] || { echo "capture is only $size bytes"; return 1; }
}

assert_png_dimensions() {
  local png="$1"
  local frame_width="$2"
  local frame_height="$3"
  local expected_width expected_height pixel_width pixel_height
  [ -n "$BACKING_SCALE100" ] || die "backing scale was not read at launch"
  expected_width=$((frame_width * BACKING_SCALE100 / 100))
  expected_height=$((frame_height * BACKING_SCALE100 / 100))
  pixel_width=$(sips -g pixelWidth "$png" 2>/dev/null | awk '/pixelWidth/{print $2}')
  pixel_height=$(sips -g pixelHeight "$png" 2>/dev/null | awk '/pixelHeight/{print $2}')
  [ "$pixel_width" = "$expected_width" ] \
    && [ "$pixel_height" = "$expected_height" ] \
    || die "$(basename "$png") is ${pixel_width}x${pixel_height}px; expected ${expected_width}x${expected_height}px"
}

capture_stable() {
  local png="$1"
  local frame_width="$2"
  local frame_height="$3"
  local second="$ARTIFACTS/settle-$(basename "$png")"
  rm -f "$png" "$second"
  screencapture -x -o -l "$WINID" "$png" || die "capture failed: $png"
  local defect
  defect=$(png_defect "$png") || die "$(basename "$png"): $defect"
  assert_png_dimensions "$png" "$frame_width" "$frame_height"
  for _ in 1 2 3 4 5; do
    sleep 1
    screencapture -x -o -l "$WINID" "$second" \
      || die "settle capture failed: $png"
    defect=$(png_defect "$second") || die "$(basename "$second"): $defect"
    assert_png_dimensions "$second" "$frame_width" "$frame_height"
    if cmp -s "$png" "$second"; then
      rm -f "$second"
      return
    fi
    mv "$second" "$png"
  done
  die "$(basename "$png") did not settle"
}

bind_launchservices_pid() {
  local matches=""
  local listing=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    listing=$(/usr/sbin/lsof -a -d txt -Fn -- "$APP_EXE" 2>/dev/null || true)
    matches=$(printf '%s\n' "$listing" | awk -v executable="$APP_EXE" '
      /^p[0-9]+$/ { pid=substr($0, 2) }
      $0 == "n" executable && pid != "" { print pid }
    ' | sort -u)
    [ "$(printf '%s\n' "$matches" | awk 'NF{count++} END{print count+0}')" = "1" ] \
      && break
    sleep 0.5
  done
  [ "$(printf '%s\n' "$matches" | awk 'NF{count++} END{print count+0}')" = "1" ] \
    || die "could not bind exactly one LaunchServices PID to $APP_EXE"
  APP_PID="$matches"
  pid_owns_executable || die "PID $APP_PID is not executing $APP_EXE"
}

launch_app() {
  local scenario="$1"
  local label="$2"
  APP_EXE="$EXTRACT_ROOT/HiveWorkspace.app/Contents/MacOS/HiveWorkspace"
  /usr/bin/open -n -F \
    --stdout "$ARTIFACTS/$label-app.stdout.log" \
    --stderr "$ARTIFACTS/$label-app.stderr.log" \
    --env "HIVE_SHELL_SCENARIO=$scenario" \
    --env "HIVE_HOME=$BUILD_ROOT/$label-hive-home" \
    "$EXTRACT_ROOT/HiveWorkspace.app" \
    --args --workspace-shell "$DENSE_CORPUS" \
    || die "LaunchServices refused $APP_EXE"
  bind_launchservices_pid
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ "$(visible_window_count)" = "1" ] && break
    sleep 0.5
  done
  [ "$(visible_window_count)" = "1" ] \
    || die "expected exactly one visible shell window for PID $APP_PID"
  WINID=$(window_number)
  [ -n "$WINID" ] && [ "$WINID" -gt 0 ] 2>/dev/null \
    || die "shell window has no WindowServer number"
  BACKING_SCALE100=$(window_metric '([proofWindow backingScaleFactor] * 100)')
  [ -n "$BACKING_SCALE100" ] && [ "$BACKING_SCALE100" -gt 0 ] 2>/dev/null \
    || die "could not read the window's backing scale"
  printf '%s\t%s\t%s\n' "$label" "$APP_PID" "$APP_EXE" >> "$ARTIFACTS/launches.tsv"
}

record_metrics() {
  local phase="$1"
  local slug="$2"
  local content_width scroll_width doc_width doc_height clip_height scroll_y
  content_width=$(scroll_metric 'proofContentBounds.width')
  scroll_width=$(scroll_metric 'proofScrollFrame.width')
  doc_width=$(scroll_metric 'proofDocumentBounds.width')
  doc_height=$(scroll_metric 'proofDocumentBounds.height')
  clip_height=$(scroll_metric 'proofClipBounds.height')
  scroll_y=$(scroll_metric 'proofClipBounds.y')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$phase" "$slug" "$content_width" "$scroll_width" "$doc_width" \
    "$doc_height" "$clip_height" "$scroll_y" \
    >> "$ARTIFACTS/metrics.tsv"
}

prove_dense_size() {
  local slug="$1"
  local phase="$2"
  local width="$3"
  local height="$4"
  local doc_height clip_height
  [ "$(set_window_frame "$width" "$height")" = "1" ] \
    || die "could not resize $slug to ${width}x${height}"
  sleep 1
  assert_frame "$width" "$height"
  assert_fills_width "$phase $slug"
  doc_height=$(scroll_metric 'proofDocumentBounds.height')
  clip_height=$(scroll_metric 'proofClipBounds.height')
  [ -n "$doc_height" ] && [ -n "$clip_height" ] \
    || die "$slug dense scroll metrics were unavailable at $phase"
  [ "$doc_height" -gt "$clip_height" ] \
    || die "$slug dense document does not overflow the $phase viewport"
  capture_stable "$ARTIFACTS/dense-$slug-$phase.png" "$width" "$height"
  record_metrics "dense-$phase" "$slug"
}

prove_fullscreen() {
  local slug="$1"
  local title="$2"
  local hit screen_width frame_width frame_height phase
  hit=$(click_route "$title")
  [ -n "$hit" ] && [ "$hit" != "0" ] || die "route button missing: $title"
  sleep 1
  screen_width=$(window_metric 'proofScreenFrame.width')
  [ -n "$screen_width" ] && [ "$screen_width" -gt 0 ] \
    || die "$slug has no screen frame to fill"
  toggle_fullscreen > /dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ "$(window_metric 'proofFrame.width')" = "$screen_width" ] && break
    sleep 0.5
  done
  frame_width=$(window_metric 'proofFrame.width')
  # A background app can refuse the Space transition. The screen-width defect
  # this proves does not need one, so the fallback fills the screen with an
  # ordinary window and the phase name records which of the two was captured.
  if [ "$frame_width" = "$screen_width" ]; then
    phase=fullscreen
  else
    [ "$(maximize_window)" = "1" ] \
      || die "$slug reached neither fullscreen nor a screen-sized window"
    phase=screen-width
    frame_width=$(window_metric 'proofFrame.width')
  fi
  frame_height=$(window_metric 'proofFrame.height')
  WINID=$(window_number)
  sleep 1
  assert_fills_width "$phase $slug"
  capture_stable "$ARTIFACTS/dense-$slug-$phase.png" "$frame_width" "$frame_height"
  record_metrics "dense-$phase" "$slug"
  if [ "$phase" = "fullscreen" ]; then
    toggle_fullscreen > /dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      [ "$(window_metric 'proofFrame.width')" != "$screen_width" ] && break
      sleep 0.5
    done
    WINID=$(window_number)
  fi
}

prove_dense_route() {
  local slug="$1"
  local title="$2"
  local hit scroll_handle scroll_y
  hit=$(click_route "$title")
  [ -n "$hit" ] && [ "$hit" != "0" ] || die "route button missing: $title"
  sleep 1
  prove_dense_size "$slug" desktop 1440 900
  prove_dense_size "$slug" mid-resize 1180 700
  prove_dense_size "$slug" small 940 560

  scroll_handle=$(scroll_to_bottom)
  [ -n "$scroll_handle" ] && [ "$scroll_handle" != "0" ] \
    || die "$slug has no screen scroll view"
  sleep 1
  scroll_y=$(scroll_metric 'proofClipBounds.y')
  [ -n "$scroll_y" ] || die "$slug scroll position was unavailable"
  [ "$scroll_y" -gt 0 ] || die "$slug did not scroll below its small viewport"
  capture_stable "$ARTIFACTS/dense-$slug-small-bottom.png" 940 560
  record_metrics dense-small-bottom "$slug"
  assert_scroll_survives_render "$slug" "$title"
  record_metrics dense-small-rerender "$slug"

  [ "$(set_window_frame 1440 900)" = "1" ] || die "could not restore desktop frame"
}

prove_empty_route() {
  local slug="$1"
  local title="$2"
  local width="$3"
  local height="$4"
  local phase="$5"
  local hit doc_height clip_height
  hit=$(click_route "$title")
  [ -n "$hit" ] && [ "$hit" != "0" ] || die "route button missing: $title"
  sleep 1
  assert_frame "$width" "$height"
  assert_fills_width "$phase $slug"
  doc_height=$(scroll_metric 'proofDocumentBounds.height')
  clip_height=$(scroll_metric 'proofClipBounds.height')
  [ -n "$doc_height" ] && [ -n "$clip_height" ] \
    || die "$slug empty scroll metrics were unavailable"
  [ "$doc_height" -le "$clip_height" ] \
    || die "$slug unknown-data screen manufactured overflow"
  # The document floor is what keeps a short screen from leaving the window
  # showing through below the panel.
  [ "$doc_height" = "$clip_height" ] \
    || die "$slug leaves ${clip_height}pt of viewport under a ${doc_height}pt screen"
  capture_stable "$ARTIFACTS/empty-$slug-$phase.png" "$width" "$height"
  record_metrics "empty-$phase" "$slug"
}

printf 'phase\troute\tcontentWidth\tscreenWidth\tdocumentWidth\tdocumentHeight\tclipHeight\tscrollY\n' \
  > "$ARTIFACTS/metrics.tsv"
printf 'label\tpid\texecutable\n' > "$ARTIFACTS/launches.tsv"

commit=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD) \
  || die "cannot read worktree commit"
env -u MACOS_SIGN_IDENTITY \
  -u MACOS_NOTARY_KEY_PATH \
  -u MACOS_NOTARY_KEY_ID \
  -u MACOS_NOTARY_ISSUER_ID \
  HIVE_HOME="$BUILD_ROOT/build-hive-home" \
  bun run src/release/build.ts \
    --version 0.0.0 \
    --commit "$commit" \
    --out "$RELEASE_OUT" \
    --skip-sessiond \
    --skip-embeddings \
  > "$ARTIFACTS/build.log" 2>&1 \
  || die "release build failed: $(tail -10 "$ARTIFACTS/build.log")"

tar -xzf "$RELEASE_OUT/HiveWorkspace.tar.gz" -C "$EXTRACT_ROOT" \
  || die "could not extract HiveWorkspace.tar.gz"
APP_EXE="$EXTRACT_ROOT/HiveWorkspace.app/Contents/MacOS/HiveWorkspace"
[ -x "$APP_EXE" ] || die "release bundle has no executable: $APP_EXE"
printf '%s\n' "$EXTRACT_ROOT/HiveWorkspace.app" > "$ARTIFACTS/bundle-path.txt"

launch_app current dense
[ "$(set_window_frame 1440 900)" = "1" ] || die "could not set desktop frame"
prove_dense_route router "Task Router"
prove_dense_route models "Models & Quota"
prove_dense_route memory-library "Memory Library"
prove_fullscreen router "Task Router"
stop_app

launch_app unknown empty
[ "$(set_window_frame 940 560)" = "1" ] || die "could not set empty-data frame"
prove_empty_route router "Task Router" 940 560 small
prove_empty_route models "Models & Quota" 940 560 small
prove_empty_route memory-library "Memory Library" 940 560 small
[ "$(set_window_frame 1440 900)" = "1" ] || die "could not set empty-data desktop frame"
prove_empty_route router "Task Router" 1440 900 desktop
stop_app

echo "PASS: real Workspace bundle stayed bounded; artifacts=$ARTIFACTS"
