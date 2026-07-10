#!/bin/sh
# Prove your Developer ID and entitlements work — locally, before trusting CI.
#
#   scripts/signing/dry-run.sh              # sign + verify the CLI slices (fast)
#   scripts/signing/dry-run.sh --full       # also build, sign, notarize the .app
#   scripts/signing/dry-run.sh --notarize   # notarize the CLI slices too
#
# This runs the *exact* production path: it sets the same environment variables
# CI sets, calls the same `src/release/build.ts`, and runs the same
# `verify.sh` gate. If this passes with your certificate, CI will too — the only
# difference is where the certificate comes from (your keychain vs a secret).
#
# The reason to run it: a `bun --compile` binary embeds JavaScriptCore, a JIT,
# and the hardened runtime kills a JIT without the right entitlements. This
# builds a real Hive CLI, signs it with your cert and Hive's entitlements, and
# *runs it* — so a signing or entitlement mistake shows up on your machine now,
# not on a user's machine after release.
#
# Prerequisites:
#   - Xcode command-line tools (codesign, xcrun notarytool, stapler).
#   - Your "Developer ID Application" certificate in the login keychain.
#   - For notarization: an App Store Connect API key (.p8) and its ids, passed
#     through MACOS_NOTARY_KEY_PATH / MACOS_NOTARY_KEY_ID / MACOS_NOTARY_ISSUER_ID.
set -eu

cd "$(dirname "$0")/../.."
ENTITLEMENTS="scripts/signing/entitlements.plist"
FULL=0
FORCE_NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --notarize) FORCE_NOTARIZE=1 ;;
    *) printf 'dry-run: unknown argument %s\n' "$arg" >&2; exit 2 ;;
  esac
done

die() { printf 'dry-run: %s\n' "$1" >&2; exit 1; }
say() { printf '\n=== %s ===\n' "$1"; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only"
command -v codesign >/dev/null 2>&1 || die "codesign not found (install Xcode command-line tools)"
[ -f "$ENTITLEMENTS" ] || die "missing $ENTITLEMENTS"

# Resolve the signing identity: honour MACOS_SIGN_IDENTITY, else auto-detect the
# one Developer ID Application certificate in the keychain.
if [ -z "${MACOS_SIGN_IDENTITY:-}" ]; then
  say "Finding your Developer ID Application certificate"
  security find-identity -v -p codesigning || true
  MACOS_SIGN_IDENTITY="$(
    security find-identity -v -p codesigning \
      | grep 'Developer ID Application' | head -n1 \
      | sed -E 's/.*"(.*)".*/\1/'
  )"
  [ -n "$MACOS_SIGN_IDENTITY" ] \
    || die "no 'Developer ID Application' certificate found; set MACOS_SIGN_IDENTITY"
fi
printf 'dry-run: signing as: %s\n' "$MACOS_SIGN_IDENTITY"
export MACOS_SIGN_IDENTITY
export HIVE_SIGN_ENTITLEMENTS="$ENTITLEMENTS"

# Notarization is real work against Apple's service; only do it when asked and
# when credentials are present. Otherwise sign-and-verify locally.
NOTARIZE=0
if [ "$FULL" = 1 ] || [ "$FORCE_NOTARIZE" = 1 ]; then NOTARIZE=1; fi
if [ "$NOTARIZE" = 1 ]; then
  [ -n "${MACOS_NOTARY_KEY_PATH:-}" ] && [ -f "$MACOS_NOTARY_KEY_PATH" ] \
    || die "notarization requested but MACOS_NOTARY_KEY_PATH is unset or missing"
  [ -n "${MACOS_NOTARY_KEY_ID:-}" ] || die "set MACOS_NOTARY_KEY_ID"
  [ -n "${MACOS_NOTARY_ISSUER_ID:-}" ] || die "set MACOS_NOTARY_ISSUER_ID"
else
  # Ensure sign.ts takes the sign-only branch: clear any partial notary env.
  unset MACOS_NOTARY_KEY_PATH MACOS_NOTARY_KEY_ID MACOS_NOTARY_ISSUER_ID || true
fi

OUT="$(mktemp -d)"
BUILD_ARGS="--version 0.0.0-dryrun --commit dryrun --out $OUT"
[ "$FULL" = 1 ] || BUILD_ARGS="$BUILD_ARGS --skip-workspace"

say "Building and signing via the production build.ts"
# shellcheck disable=SC2086
bun run src/release/build.ts $BUILD_ARGS

say "Verifying like CI does"
if [ "$NOTARIZE" = 1 ]; then
  scripts/signing/verify.sh "$OUT" --require-notarization
else
  scripts/signing/verify.sh "$OUT"
fi

say "PASS"
if [ "$NOTARIZE" = 0 ]; then
  cat <<'EOF'
Signed and verified locally. This proves your certificate and Hive's
entitlements produce a strict-valid, runnable, hardened binary.

It did NOT notarize. To prove the full Apple round trip, set the notary
credentials and re-run with --notarize (or --full to include the .app):

  export MACOS_NOTARY_KEY_PATH=~/AuthKey_XXXXXXXXXX.p8
  export MACOS_NOTARY_KEY_ID=XXXXXXXXXX
  export MACOS_NOTARY_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  scripts/signing/dry-run.sh --notarize
EOF
fi
rm -rf "$OUT"
