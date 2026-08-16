# qa/qa-home.sh — the one definition of the isolated QA home prefix, the
# default tag, and the owner-stamp collision rule. Sourced by rig.sh.
# docs/qa/u5-terminal-workbench-core.ts mirrors these values; the unit suite
# proves the two copies agree.

QA_HOME_DEFAULT_LABEL="hq"
QA_HOME_DEFAULT_TAG_HEX_LENGTH=5
QA_HOME_OWNER_STAMP_NAME="qa-owner"

qa_default_home_requested() {
  local source_root tag
  source_root="$1"
  tag="$(printf '%s' "$source_root" | /usr/bin/shasum -a 256 | cut -c1-"$QA_HOME_DEFAULT_TAG_HEX_LENGTH")"
  printf '%s\n' "/tmp/${QA_HOME_DEFAULT_LABEL}${tag}"
}

qa_home_is_isolated() {
  case "$1" in
    /tmp/hq*|/private/tmp/hq*|/tmp/hvqa-*|/private/tmp/hvqa-*) return 0 ;;
    *) return 1 ;;
  esac
}

qa_home_owner_refuse() {
  # existing_owner may be empty (no stamp yet). Same-checkout reuse is allowed.
  local existing_owner checkout
  existing_owner="$1"
  checkout="$2"
  [ -n "$existing_owner" ] || return 0
  [ "$existing_owner" = "$checkout" ] && return 0
  echo "QA_HOME is owned by ${existing_owner}, not ${checkout}"
  return 1
}
