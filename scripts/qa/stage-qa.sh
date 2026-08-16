#!/bin/sh
# Stage a qa-variant CLI next to the already-built sessiond and Workspace
# from a `make build` dist. The CLI is the only artifact that carries the
# compiled-in variant; sessiond and the app are variant-identical.
set -eu

die() { printf 'stage-qa: %s\n' "$1" >&2; exit 2; }

[ "$#" -eq 5 ] || die "usage: $0 <repo-root> <dev-dist> <qa-dist> <version> <cli-asset>"

root="$1"
dev_dist="$2"
qa_dist="$3"
version="$4"
cli_asset="$5"

arch_suffix="${cli_asset#hive-}"
sessiond_asset="hive-sessiond-$arch_suffix"

[ -f "$dev_dist/$cli_asset" ] || die "dev dist missing $cli_asset; run 'make build' first"
[ -f "$dev_dist/$sessiond_asset" ] || die "dev dist missing $sessiond_asset; run 'make build' first"
[ -f "$dev_dist/HiveWorkspace.tar.gz" ] || die "dev dist missing HiveWorkspace.tar.gz; run 'make build' first"

mkdir -p "$qa_dist"
cp "$dev_dist/$sessiond_asset" "$qa_dist/$sessiond_asset"
cp "$dev_dist/HiveWorkspace.tar.gz" "$qa_dist/HiveWorkspace.tar.gz"

commit="$(git -C "$root" rev-parse --short HEAD)"
bun run "$root/src/release/build.ts" \
  --version "$version" \
  --variant qa \
  --commit "$commit" \
  --out "$qa_dist" \
  --skip-sessiond \
  --skip-workspace \
  --skip-embeddings

[ -f "$qa_dist/$cli_asset" ] || die "qa compile produced no $cli_asset"
[ -f "$qa_dist/$sessiond_asset" ] || die "qa dist lost $sessiond_asset"
[ -f "$qa_dist/HiveWorkspace.tar.gz" ] || die "qa dist lost HiveWorkspace.tar.gz"
printf 'stage-qa: compiled qa CLI into %s\n' "$qa_dist"
