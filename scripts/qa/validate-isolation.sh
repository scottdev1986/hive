#!/bin/sh
set -eu

canonical() {
  /usr/bin/python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

refuse() {
  echo "refusing: $1" >&2
  exit 2
}

mode=$1
root=$(canonical "$2")
qa=$(canonical "$3")
user_hive=$(canonical "$4")

case "$qa" in
  "$root"|"$root"/*) refuse "QA staging root $qa is inside the hive checkout $root";;
  "$user_hive"|"$user_hive"/*) refuse "QA staging root $qa is under the user Hive home $user_hive";;
esac

case "$mode" in
  build)
    qa_dist=$(canonical "$5")
    qa_graphify_root=$(canonical "$6")
    qa_graphify_manifest=$(canonical "$7")
    qa_build_stamp=$(canonical "$8")
    case "$qa_dist" in
      "$qa"/*) ;;
      *) refuse "QA_DIST $qa_dist is outside QA staging root $qa";;
    esac
    case "$qa_graphify_root" in
      "$qa"/*) ;;
      *) refuse "QA Graphify root $qa_graphify_root is outside QA staging root $qa";;
    esac
    case "$qa_graphify_manifest" in
      "$qa_graphify_root"/*) ;;
      *) refuse "QA Graphify manifest $qa_graphify_manifest is outside its artifact root $qa_graphify_root";;
    esac
    case "$qa_build_stamp" in
      "$qa"/*) ;;
      *) refuse "QA build stamp $qa_build_stamp is outside QA staging root $qa";;
    esac
    ;;
  qa|qa-clean)
    qa_home=$(canonical "$5")
    dev_home=$(canonical "$6")
    requested_user_hive=$(canonical "$7")
    project=$(canonical "$8")
    case "$qa_home" in
      "$user_hive"|"$user_hive"/*) refuse "QA_HOME is under the user hive home $user_hive";;
    esac
    case "$qa_home" in
      "$qa"/*) ;;
      *) refuse "QA_HOME $qa_home is outside QA staging root $qa";;
    esac
    [ "$qa_home" != "$dev_home" ] || refuse "QA_HOME is the live dev home"
    [ "$requested_user_hive" = "$user_hive" ] || \
      refuse "USER_HIVE $requested_user_hive is not the user hive home $user_hive"
    [ -d "$project" ] || refuse "PROJECT does not exist: $project"
    [ "$project" != "$root" ] || refuse "PROJECT is the hive checkout; point at a separate repo"
    case "$project/" in
      "$root/"*) refuse "PROJECT is inside the hive checkout but is not its root; point at a separate repo";;
    esac
    [ -e "$project/.git" ] || \
      refuse "PROJECT must be a git repository (run 'git init' there first): $project"
    ;;
  *)
    echo "unknown isolation guard mode: $mode" >&2
    exit 64
    ;;
esac
