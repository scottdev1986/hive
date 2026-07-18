# Local dev build of Hive: consumer-shaped, unsigned, fully isolated from any
# installed hive and its running instances.
#
#   make build                  build + stage the standalone dev release under .dev/
#   make run PROJECT=/path      run the staged dev build against a separate test repo
#   make test                   bun suites + sessiond (Zig) + Workspace (Swift)
#   make cleanup                stop the dev instance and delete all dev artifacts
#
# Isolation: every rendezvous name (tmux socket/sessions, sessiond broker,
# daemon port/pid, sqlite db, project registry) derives from HIVE_HOME, which
# make run points at .dev/home. HIVE_INSTALL_ROOT points at the staged dev
# root so the dev CLI launches the dev-built HiveWorkspace.app, never the
# installed one. Nothing here reads or writes ~/.hive, ~/.local/share/hive,
# or ~/.local/bin/hive.

SHELL := /bin/sh
.DEFAULT_GOAL := help

ROOT := $(CURDIR)
DEV := $(ROOT)/.dev
DIST := $(DEV)/dist
INSTALL_ROOT := $(DEV)/root
DEV_VERSION := 0.0.0
HIVE_BIN := $(INSTALL_ROOT)/current/hive

UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),arm64)
CLI_ASSET := hive-darwin-arm64
ZIG_ARCH := aarch64
else
CLI_ASSET := hive-darwin-x64
ZIG_ARCH := x86_64
endif

ZIG_VERSION := $(shell /usr/bin/plutil -extract zig.version raw -o - native/toolchain-lock.json)
ZIG := $(ROOT)/.cache/native/zig/toolchains/zig-$(ZIG_ARCH)-macos-$(ZIG_VERSION)/zig
GHOSTTYKIT := $(ROOT)/workspace/Vendor/GhosttyKit.xcframework

# The complete isolation envelope for the dev instance.
DEV_ENV := \
	HIVE_HOME=$(DEV)/home \
	HIVE_INSTALL_ROOT=$(INSTALL_ROOT) \
	HIVE_BIN_LINK=$(DEV)/bin/hive \
	HIVE_DISABLE_UPDATES=1 \
	HIVE_PORT=0 \
	TMPDIR=$(DEV)/tmp \
	TMUX_TMPDIR=$(DEV)/tmux

.PHONY: help build run test test-e2e toolchain ghosttykit clean cleanup deepclean

help:
	@echo "make build                 build + stage the standalone dev release (.dev/)"
	@echo "make run PROJECT=/path     run the dev build against a separate test repo"
	@echo "make test                  run all suites (bun, sessiond/Zig, Workspace/Swift)"
	@echo "make test-e2e              opt-in real-CLI e2e suite (needs tmux on PATH)"
	@echo "make cleanup               stop the dev instance, delete all dev artifacts"
	@echo "make deepclean             cleanup + delete native toolchain/build caches"

# Pinned Zig toolchain + Ghostty dependency cache (native/toolchain-lock.json).
# The brew zig is not used; the preflight enforces the locked 0.15.x.
toolchain:
	@if [ ! -x "$(ZIG)" ]; then "$(ROOT)/scripts/provision-native-toolchain.sh"; fi

# GhosttyKit.xcframework is a build output (see workspace/Package.swift).
# Reuse the newest cached artifact when one exists and is current; otherwise
# build it. Currency has three independent markers, each learned from a real
# staleness failure: the macOS slice must carry the lib-prefixed archive (the
# SwiftPM rename in build-ghosttykit.sh; without it only the test-bundle link
# fails), it must ship the per-arch gate-6 fixture corpus
# (Gate6SurfaceRestoreTests never skips), and its recorded patch series must
# match native/toolchain-lock.json — the cache dir name embeds only the
# Ghostty commit and Zig hash, so a patch-series regeneration changes the
# required bytes under an UNCHANGED name. This target is phony (re-checked
# every build) because an already-materialized Vendor copy says nothing about
# currency; the trailing ditto is idempotent.
ghosttykit: | toolchain
	@set -e; \
	want=$$(/usr/bin/plutil -extract ghostty.patchSeriesSha256 raw -o - "$(ROOT)/native/toolchain-lock.json"); \
	dir=$$(ls -td "$(ROOT)"/.cache/native/artifacts/ghostty-* 2>/dev/null | head -1); \
	have=$$(/usr/bin/plutil -extract ghostty.patchSeriesSha256 raw -o - "$$dir/provenance/toolchain-lock.json" 2>/dev/null || true); \
	if [ -z "$$dir" ] \
	  || ! ls "$$dir"/GhosttyKit.xcframework/macos-*/lib*.a >/dev/null 2>&1 \
	  || [ ! -f "$$dir/checkpoint-fixtures/$(UNAME_M)/corpus.hvg6" ] \
	  || [ "$$have" != "$$want" ]; then \
	  "$(ROOT)/scripts/build-ghosttykit.sh"; \
	  dir=$$(ls -td "$(ROOT)"/.cache/native/artifacts/ghostty-* | head -1); \
	fi; \
	/usr/bin/ditto "$$dir/GhosttyKit.xcframework" "$(GHOSTTYKIT)"

# Same pipeline the real installer consumes (src/release/build.ts), unsigned
# because no Developer ID is in the environment, then staged in the exact
# versions/<v> + current layout install.sh produces.
build: toolchain ghosttykit
	bun install --frozen-lockfile
	bun run src/release/build.ts --version $(DEV_VERSION) \
	  --commit $$(git rev-parse --short HEAD) --out "$(DIST)"
	rm -rf "$(INSTALL_ROOT)/versions/$(DEV_VERSION)"
	mkdir -p "$(INSTALL_ROOT)/versions/$(DEV_VERSION)" "$(DEV)/bin"
	install -m 755 "$(DIST)/$(CLI_ASSET)" "$(INSTALL_ROOT)/versions/$(DEV_VERSION)/hive"
	tar -xzf "$(DIST)/HiveWorkspace.tar.gz" -C "$(INSTALL_ROOT)/versions/$(DEV_VERSION)"
	ln -shf "versions/$(DEV_VERSION)" "$(INSTALL_ROOT)/current"
	@echo "staged: $$("$(HIVE_BIN)" --version)"

# PROJECT is mandatory and must be a git repo OUTSIDE this checkout, so the
# dev Workspace always opens in the test repo, never in the hive repo.
run:
	@[ -n "$(PROJECT)" ] || { \
	  echo "usage: make run PROJECT=/path/to/test-repo (e.g. ~/Projects/hive-test-project)" >&2; exit 2; }
	@set -e; \
	proj=$$(cd "$(PROJECT)" 2>/dev/null && pwd -P) || { echo "PROJECT does not exist: $(PROJECT)" >&2; exit 2; }; \
	case "$$proj/" in "$(ROOT)/"*) \
	  echo "refusing: PROJECT is the hive repo (or inside it); point at a separate test repo" >&2; exit 2;; esac; \
	[ -d "$$proj/.git" ] || { echo "PROJECT must be a git repository (run 'git init' there first): $$proj" >&2; exit 2; }; \
	[ -x "$(HIVE_BIN)" ] || { echo "no dev build staged; run 'make build' first" >&2; exit 2; }; \
	mkdir -p "$(DEV)/home" "$(DEV)/bin" "$(DEV)/tmp" "$(DEV)/tmux"; \
	cd "$$proj" && env $(DEV_ENV) "$(HIVE_BIN)" init --no-graphify && exec env $(DEV_ENV) "$(HIVE_BIN)"

# The project's own definition of the suites: bun test + sessiond (test.sh
# compiles the C ABI fixtures and runs the Zig daemon tests), then the Swift
# Workspace tests. No pipes anywhere: a red suite must exit red.
test: toolchain ghosttykit
	bun install --frozen-lockfile
	bun run test
	cd workspace && swift test

# Real CLI against a real daemon and a private tmux server; provider CLIs are
# stubbed by the suite so nothing bills. Self-isolating (throwaway HIVE_HOME).
test-e2e:
	HIVE_E2E=1 bun test src/cli/e2e-real.test.ts

# Stop the dev instance (its tmux server name is derived from .dev/home, so
# this can only ever hit the dev server), kill the dev daemon only if the pid
# still names a binary under .dev/, then delete everything.
clean:
	@if [ -d "$(DEV)/home" ]; then \
	  suffix=$$(printf '%s' "$$(cd "$(DEV)/home" && pwd -P)" | /usr/bin/shasum -a 256 | cut -c1-10); \
	  TMUX_TMPDIR="$(DEV)/tmux" tmux -L "hive-$$suffix" kill-server 2>/dev/null || true; \
	fi
	@if [ -f "$(DEV)/home/daemon.pid" ]; then \
	  pid=$$(cat "$(DEV)/home/daemon.pid"); \
	  command=$$(ps -p "$$pid" -o comm= 2>/dev/null || true); \
	  case "$$command" in "$(DEV)/"*) kill "$$pid" 2>/dev/null || true;; esac; \
	fi
	rm -rf "$(DEV)"

cleanup: clean

# Also drop the expensive native caches (pinned Zig, Ghostty artifacts) and
# intermediate build state. The next make build re-provisions from scratch.
deepclean: clean
	rm -rf "$(ROOT)/.cache/native" "$(GHOSTTYKIT)" \
	  "$(ROOT)/workspace/.build" "$(ROOT)/.zig-cache" \
	  "$(ROOT)/native/sessiond/zig-out" "$(ROOT)/native/sessiond/.zig-cache"
