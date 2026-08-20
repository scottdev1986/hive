# Project scripts

This directory contains executable tooling and the committed inputs those tools need. It is part of the build and release system, not a generated-output directory.

- `dev/` prepares and verifies the isolated local runtime used by `make run`.
- `graphify/` builds and publishes the pinned Graphify runtime.
- `native/` provisions, builds, verifies, and publishes the Zig/Ghostty toolchain artifacts.
- `qa/` contains isolation, process-ownership, and inventory for the Makefile QA lifecycle. The harness itself lives at the checkout-root `qa/` directory.
- `release/` adapts tested release policy to CI and acceptance workflows.
- `signing/` signs and verifies macOS artifacts and update manifests.

Tests for these tools live under `test/scripts/`. Fixture builders live beside their outputs under `test/fixtures/builders/`.

Run documented commands from the repository root. Temporary evidence generators should not be committed here unless a current test, build, or documented qualification workflow owns them.
