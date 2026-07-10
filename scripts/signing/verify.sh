#!/bin/sh
# Gatekeeper verification gate for the signed release artifacts.
#
#   scripts/signing/verify.sh dist [--require-notarization]
#
# Every check here is a release blocker: any signing defect exits non-zero, and
# in CI this runs before the tag is pushed, so a bad signature can never mint a
# version number. It verifies the exact bytes a user downloads — the CLI slices
# on disk and the .app extracted from its tarball — not some intermediate.
#
# Two levels:
#   default              signature must be valid and hardened (a local dry run,
#                        before notarization exists).
#   --require-notarization  additionally, Gatekeeper must *accept* the artifact,
#                        which only holds once Apple has notarized it. This is
#                        what CI passes.
#
# Standalone CLI binaries cannot be stapled, and `spctl --assess --type execute`
# rejects ANY bare Mach-O — notarized or not — with "does not seem to be an app"
# (verified against Anthropic's and Docker's notarized CLIs). Their notarization
# is instead proven by `codesign --check-notarization -R="notarized"`, which
# looks the CDHash up against Apple's ticket service online. Only the .app is a
# bundle, so only it gets `spctl --assess` and a stapled-ticket check.
set -eu

DIST="${1:?usage: verify.sh <dist-dir> [--require-notarization]}"
REQUIRE_NOTARIZATION=0
[ "${2:-}" = "--require-notarization" ] && REQUIRE_NOTARIZATION=1

fail() { printf 'verify: %s\n' "$1" >&2; exit 1; }
note() { printf 'verify: %s\n' "$1"; }

# codesign --verify --strict: the deterministic gate. Catches the truncated
# signature a mis-built Bun binary produces, a broken seal, a missing runtime.
verify_signature() {
  path="$1"
  note "codesign --verify --strict $path"
  codesign --verify --strict --verbose=2 "$path" \
    || fail "$path failed strict signature verification"
  # Hardened runtime must actually be on; notarization requires it and a plain
  # Developer ID signature without it would pass --verify but fail notarization.
  codesign --display --verbose=2 "$path" 2>&1 | grep -q "flags=.*runtime" \
    || fail "$path is not signed with the hardened runtime"
}

# spctl --assess: what Gatekeeper itself decides. Bundles only — it rejects any
# bare Mach-O regardless of notarization, so this is reserved for the .app.
assess_gatekeeper() {
  path="$1"
  note "spctl --assess --type execute $path"
  out="$(spctl --assess --type execute --verbose=4 "$path" 2>&1)" || true
  if printf '%s' "$out" | grep -q "accepted"; then
    note "$path accepted by Gatekeeper"
  else
    printf '%s\n' "$out" >&2
    fail "$path was not accepted by Gatekeeper (spctl --assess rejected it)"
  fi
}

# The notarization proof for a standalone binary: codesign resolves its CDHash
# against Apple's ticket service. Rejects a signed-but-unnotarized binary.
check_notarized_binary() {
  path="$1"
  note "codesign --check-notarization $path"
  codesign --verify --check-notarization -R="notarized" --verbose=2 "$path" \
    || fail "$path has no notarization ticket (codesign --check-notarization rejected it)"
}

for arch in arm64 x64; do
  bin="$DIST/hive-darwin-$arch"
  [ -f "$bin" ] || fail "missing $bin"
  verify_signature "$bin"
  [ "$REQUIRE_NOTARIZATION" = 1 ] && check_notarized_binary "$bin"
done

# Prove the arm64 slice still runs after signing — a hardened-runtime crash from
# a missing JIT entitlement would surface here, not on a user's machine.
note "running hive-darwin-arm64 --version"
chmod +x "$DIST/hive-darwin-arm64"
"$DIST/hive-darwin-arm64" --version >/dev/null || fail "signed hive-darwin-arm64 did not run"

TARBALL="$DIST/HiveWorkspace.tar.gz"
if [ -f "$TARBALL" ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  tar -xzf "$TARBALL" -C "$WORK"
  APP="$WORK/HiveWorkspace.app"
  [ -d "$APP" ] || fail "$TARBALL did not contain HiveWorkspace.app"
  verify_signature "$APP"
  if [ "$REQUIRE_NOTARIZATION" = 1 ]; then
    note "stapler validate HiveWorkspace.app"
    xcrun stapler validate "$APP" || fail "HiveWorkspace.app has no stapled notarization ticket"
    assess_gatekeeper "$APP"
  fi
fi

note "all artifacts passed"
