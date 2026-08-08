#!/usr/bin/env bash
set -euo pipefail

bun run "$(cd "$(dirname "$0")" && pwd -P)/mail-bind-root.ts"
set +e
bun run "$(cd "$(dirname "$0")" && pwd -P)/composer-arbitration-matrix.ts"
composer_status=$?
bun run "$(cd "$(dirname "$0")" && pwd -P)/mail-vendor-conformance.ts"
mail_status=$?
set -e
[ "$composer_status" -eq 0 ] || exit "$composer_status"
exit "$mail_status"
