# qa/declared-screens.sh — the one place QA asks the shell which screens exist.
#
# Sourced, never executed:
#
#     . "$QA_DIR/declared-screens.sh"
#     slugs="$(qa_declared_screens "$binary" "$corpus")" || exit 1
#
# The Shell's availability registry emits its declarations through the existing
# proof mode, one line per screen, terminated:
#
#     SHELL-SCREEN run|show-live-run|Workspace|Live Run
#     ...
#     SHELL-PROOF routes=8 screens=8 wired=8 ...
#     SHELL-PROOF-END screens=8
#
# Fields are pipe-separated because group and title contain spaces. Before this
# existed, docs/qa carried four hand-maintained slug lists; two of them already
# disagreed with each other, and every one of them would have gone on demanding
# captures of screens the cutover had deleted. A screen that is not declared
# cannot be toured, and a declared screen cannot be quietly forgotten.

# Prints slug|title, one screen per line. Fails loudly, and never returns an
# empty list as if it were an answer.
#
# The terminator is not decoration. A run that dies part-way prints some
# SHELL-SCREEN lines and stops, which is indistinguishable from a genuinely
# short screen list: a consumer would tour four screens and call it a pass. So
# the count the shell claims must equal the number of lines actually read, and a
# missing terminator is a failed read rather than an empty one.
#
# Fields are slug|command|group|title. Title is last because group and title
# contain spaces; a missing title is a failed read, because the tour clicks by
# title and a blank one would walk nothing while claiming a screen.
qa_parse_declared_screens() {
  local output="$1" records count claimed
  records="$(printf '%s\n' "$output" \
    | sed -n 's/^SHELL-SCREEN \([^|]*\)|[^|]*|[^|]*|\(.*\)$/\1|\2/p')"
  count="$(printf '%s' "$records" | grep -c . || true)"
  claimed="$(printf '%s\n' "$output" \
    | sed -n 's/^SHELL-PROOF-END screens=\([0-9]*\)$/\1/p' | tail -1)"
  if [ -z "$claimed" ]; then
    # Also the honest answer for a binary built before the registry existed:
    # "this build does not declare its screens" is a refusal, not an empty list.
    echo "qa: no SHELL-PROOF-END terminator; the run was truncated or this build declares no screens" >&2
    return 1
  fi
  if [ "$claimed" != "$count" ]; then
    echo "qa: the shell claimed $claimed screens and printed $count" >&2
    return 1
  fi
  if [ "$count" -eq 0 ]; then
    echo "qa: the shell declares no screens at all" >&2
    return 1
  fi
  if printf '%s\n' "$records" | grep -q '|$' ; then
    echo "qa: a declared screen has no title" >&2
    return 1
  fi
  printf '%s\n' "$records"
}

# Prints the declared slugs, one per line. Same refusal rules as the parser.
qa_declared_screens() {
  local binary="$1" corpus="$2" output records
  if [ ! -x "$binary" ]; then
    echo "qa: no shell binary at $binary" >&2
    return 1
  fi
  if [ ! -d "$corpus" ]; then
    echo "qa: no fixture corpus at $corpus" >&2
    return 1
  fi
  output="$(env -u HIVE_SHELL_PROOF_MUTATE HIVE_SHELL_PROOF=1 \
    "$binary" --workspace-shell "$corpus" 2>/dev/null)" || {
    echo "qa: the shell refused to report its screens" >&2
    return 1
  }
  records="$(qa_parse_declared_screens "$output")" || return 1
  printf '%s\n' "$records" | cut -d'|' -f1
}
