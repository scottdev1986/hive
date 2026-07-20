# Local dev build of Hive: consumer-shaped, unsigned, fully isolated from any
# installed hive and its running instances.
#
#   make build                  build + stage the standalone dev release under .dev/
#   make run                    run the staged dev build (defaults to .dev/project)
#   make demo                   build fresh terminal artifacts + launch watched proof
#   make terminal               build fresh artifacts + launch a real login shell
#   make test                   bun suites + sessiond (Zig) + Workspace (Swift)
#   make cleanup                delete all dev artifacts (does NOT stop running dev processes)
#
# `make build && make run` is the developer flow: it builds every artifact the
# dev release needs (pinned Zig, GhosttyKit, ReleaseFast sessiond, the CLI and
# the Workspace app) and launches the staged Workspace. Its terminal panes stay
# blank for now: nothing in the shipped stack starts the sessiond broker yet, so
# `make terminal` remains the entrypoint for a live M1 typeable terminal.
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
DEV_PROJECT := $(DEV)/project
DEV_VERSION := 0.0.0
HIVE_BIN := $(INSTALL_ROOT)/current/hive
LOCK := $(ROOT)/native/toolchain-lock.json
NATIVE_CACHE ?= $(ROOT)/.cache/native
DEMO_CACHE := $(NATIVE_CACHE)/demo
export HIVE_NATIVE_CACHE := $(NATIVE_CACHE)

UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),arm64)
CLI_ASSET := hive-darwin-arm64
ZIG_ARCH := aarch64
ZIG_LOCK_ARCH := arm64
else ifeq ($(UNAME_M),x86_64)
CLI_ASSET := hive-darwin-x64
ZIG_ARCH := x86_64
ZIG_LOCK_ARCH := x86_64
else
$(error unsupported host architecture $(UNAME_M); expected arm64 or x86_64)
endif

ZIG_VERSION := $(shell /usr/bin/plutil -extract zig.version raw -o - $(LOCK))
ZIG_SHA := $(shell /usr/bin/plutil -extract zig.$(ZIG_LOCK_ARCH)Sha256 raw -o - $(LOCK))
BUN_VERSION := $(shell /usr/bin/plutil -extract bun raw -o - $(LOCK))
MACOS_DEPLOYMENT_TARGET := $(shell /usr/bin/plutil -extract deploymentTarget raw -o - $(LOCK))
GHOSTTY_COMMIT := $(shell /usr/bin/plutil -extract ghostty.commit raw -o - $(LOCK))
GHOSTTY_PATCH_SHA := $(shell /usr/bin/plutil -extract ghostty.patchSeriesSha256 raw -o - $(LOCK))
ZIG := $(NATIVE_CACHE)/zig/toolchains/zig-$(ZIG_ARCH)-macos-$(ZIG_VERSION)/zig
TOOLCHAIN_STAMP := $(DEMO_CACHE)/toolchain-$(ZIG_VERSION)-$(ZIG_SHA).stamp
GHOSTTY_ARTIFACT := $(NATIVE_CACHE)/artifacts/ghostty-$(GHOSTTY_COMMIT)-zig-$(ZIG_SHA)
GHOSTTY_ARTIFACT_INFO := $(GHOSTTY_ARTIFACT)/GhosttyKit.xcframework/Info.plist
GHOSTTY_ARTIFACT_STAMP := $(GHOSTTY_ARTIFACT)/.hive-demo-$(GHOSTTY_PATCH_SHA).stamp
GHOSTTYKIT := $(ROOT)/workspace/Vendor/GhosttyKit.xcframework
GHOSTTYKIT_INFO := $(GHOSTTYKIT)/Info.plist
WORKSPACE_BIN := $(ROOT)/workspace/.build/debug/HiveWorkspace
SESSIOND_RELEASE_ROOT := $(DEMO_CACHE)/sessiond-releasefast
SESSIOND_RELEASE_BIN := $(SESSIOND_RELEASE_ROOT)/bin/hive-sessiond
SESSIOND_BIN := $(ROOT)/native/sessiond/zig-out/bin/hive-sessiond
DEMO_PORT := 43117
DEMO_TARGET := demo

GHOSTTY_ENGINE_INPUTS := $(shell find \
	$(ROOT)/vendor/ghostty \
	-type f \( \
	-name '*.zig' -o -name '*.zon' -o -name '*.json' \
	-o -name '*.c' -o -name '*.h' -o -name '*.m' -o -name '*.mm' \
	-o -name '*.swift' -o -name '*.metal' \
	\) \
	! -path '* *' \
	! -path '*/.zig-cache/*' \
	! -path '*/zig-out/*') \
	$(shell find \
	$(ROOT)/native/ghostty-patches \
	$(ROOT)/native/include \
	$(ROOT)/native/abi \
	-type f \
	! -path '*/.zig-cache/*' \
	! -path '*/zig-out/*') \
	$(ROOT)/native/ghostty-upstream-tree.txt
GHOSTTY_BUILD_INPUTS := $(GHOSTTY_ENGINE_INPUTS) \
	$(LOCK) \
	$(ROOT)/scripts/build-ghosttykit.sh \
	$(ROOT)/scripts/check-ghostty-abi.sh \
	$(ROOT)/scripts/preflight-native-toolchain.sh \
	$(ROOT)/scripts/prepare-zig-xcode-overlay.sh \
	$(ROOT)/scripts/qualify-ghostty-checkpoint.sh \
	$(ROOT)/scripts/qualify-ghostty-release-lock.sh \
	$(ROOT)/scripts/vendor-ghostty.sh \
	$(ROOT)/scripts/write-ghostty-artifact-metadata.ts
WORKSPACE_INPUTS := $(shell find \
	$(ROOT)/workspace/Sources \
	$(ROOT)/workspace/Resources \
	-type f \
	! -path '* *') \
	$(ROOT)/workspace/Package.swift \
	$(ROOT)/workspace/Package.resolved
SESSIOND_INPUTS := $(shell find $(ROOT)/native/sessiond/src -type f) \
	$(ROOT)/native/sessiond/build.zig \
	$(ROOT)/native/sessiond/build.zig.zon \
	$(ROOT)/scripts/prepare-zig-xcode-overlay.sh \
	$(ROOT)/scripts/zig-runner-tools/xcrun \
	$(LOCK) \
	$(GHOSTTY_ENGINE_INPUTS)

# The complete isolation envelope for the dev instance.
DEV_ENV := \
	HIVE_HOME=$(DEV)/home \
	HIVE_INSTALL_ROOT=$(INSTALL_ROOT) \
	HIVE_BIN_LINK=$(DEV)/bin/hive \
	HIVE_DISABLE_UPDATES=1 \
	HIVE_PORT=0 \
	TMPDIR=$(DEV)/tmp \
	TMUX_TMPDIR=$(DEV)/tmux

.PHONY: help build demo terminal demo-artifacts demo-preflight native sessiond workspace \
	ghostty ghosttykit run test test-e2e toolchain clean cleanup deepclean

help:
	@echo "make build                 build + stage the standalone dev release (.dev/)"
	@echo "make run [PROJECT=/path]   run the dev build (defaults to the .dev/project scratch repo)"
	@echo "make demo                  build fresh artifacts + launch watched typeable proof"
	@echo "make terminal              build fresh artifacts + launch a real typeable login shell (live M1 terminal)"
	@echo "make demo-artifacts        build only the proof's Ghostty/Swift/sessiond artifacts"
	@echo "make native                build + stage the ReleaseFast sessiond proof binary"
	@echo "make ghostty               build + stage the lock-pinned GhosttyKit"
	@echo "make workspace             build the Workspace Swift executable"
	@echo "make test                  run all suites (bun, sessiond/Zig, Workspace/Swift)"
	@echo "make test-e2e              opt-in real-CLI e2e suite (needs tmux on PATH)"
	@echo "make cleanup               delete all dev artifacts (quit the dev app first; see #44)"
	@echo "make deepclean             cleanup + delete native toolchain/build caches"
	@echo "demo/terminal need Bun $(BUN_VERSION), Xcode/Swift + Metal Toolchain, and an unlocked Aqua GUI session"

# Pinned Zig toolchain + Ghostty dependency cache (native/toolchain-lock.json).
# The brew zig is not used; the preflight enforces the locked 0.15.x.
toolchain: $(TOOLCHAIN_STAMP)

$(TOOLCHAIN_STAMP): $(LOCK) \
		$(ROOT)/scripts/provision-native-toolchain.sh \
		$(ROOT)/scripts/validate-native-toolchain-lock.sh \
		$(ROOT)/scripts/ghostty-dependency-cache.ts \
		$(ROOT)/vendor/ghostty/build.zig.zon.json
	@mkdir -p "$(DEMO_CACHE)"
	@"$(ROOT)/scripts/provision-native-toolchain.sh"
	@test -x "$(ZIG)" || { echo "make: pinned Zig was not provisioned; rerun 'make toolchain'" >&2; exit 1; }
	@touch "$@"

# File-backed rules make source and lock changes invalidate every demo artifact.
ghostty ghosttykit: $(GHOSTTYKIT_INFO)

$(GHOSTTY_ARTIFACT_STAMP): $(GHOSTTY_BUILD_INPUTS) | toolchain
	@echo "building lock-pinned GhosttyKit"
	@"$(ROOT)/scripts/build-ghosttykit.sh"
	@test -f "$(GHOSTTY_ARTIFACT_INFO)" || { echo "make: GhosttyKit build produced no artifact; rerun 'make ghostty'" >&2; exit 1; }
	@ls "$(GHOSTTY_ARTIFACT)"/GhosttyKit.xcframework/macos-*/lib*.a >/dev/null 2>&1 || { echo "make: GhosttyKit macOS archive is invalid; rerun 'make ghostty'" >&2; exit 1; }
	@test -f "$(GHOSTTY_ARTIFACT)/checkpoint-fixtures/$(UNAME_M)/corpus.hvg6" || { echo "make: GhosttyKit checkpoint corpus is missing; rerun 'make ghostty'" >&2; exit 1; }
	@touch "$@"

$(GHOSTTYKIT_INFO): $(GHOSTTY_ARTIFACT_STAMP)
	@echo "staging lock-pinned GhosttyKit for SwiftPM"
	@/bin/rm -rf "$(GHOSTTYKIT)" "$(ROOT)/workspace/Vendor/checkpoint-fixtures"
	@mkdir -p "$(ROOT)/workspace/Vendor"
	@/usr/bin/ditto "$(GHOSTTY_ARTIFACT)/GhosttyKit.xcframework" "$(GHOSTTYKIT)"
	@/usr/bin/ditto "$(GHOSTTY_ARTIFACT)/checkpoint-fixtures" "$(ROOT)/workspace/Vendor/checkpoint-fixtures"
	@test -f "$@" || { echo "make: GhosttyKit staging failed; rerun 'make ghostty'" >&2; exit 1; }
	@touch "$@"

workspace: $(WORKSPACE_BIN)

$(WORKSPACE_BIN): $(WORKSPACE_INPUTS) $(GHOSTTYKIT_INFO)
	@echo "building Workspace Swift executable"
	@swift build --package-path "$(ROOT)/workspace"
	@test -x "$@" || { echo "make: Workspace build produced no executable; rerun 'make workspace'" >&2; exit 1; }
	@touch "$@"

native: sessiond

sessiond: $(SESSIOND_BIN)
	@if ! /usr/bin/cmp -s "$(SESSIOND_RELEASE_BIN)" "$(SESSIOND_BIN)"; then \
		echo "replacing non-ReleaseFast sessiond proof binary"; \
		/bin/cp "$(SESSIOND_RELEASE_BIN)" "$(SESSIOND_BIN)"; \
		/bin/chmod 755 "$(SESSIOND_BIN)"; \
	fi
	@/usr/bin/cmp -s "$(SESSIOND_RELEASE_BIN)" "$(SESSIOND_BIN)" || { echo "make: sessiond is not the ReleaseFast proof build; rerun 'make native'" >&2; exit 1; }

$(SESSIOND_BIN): $(SESSIOND_RELEASE_BIN)
	@mkdir -p "$(@D)"
	@/bin/cp "$(SESSIOND_RELEASE_BIN)" "$@"
	@/bin/chmod 755 "$@"

$(SESSIOND_RELEASE_BIN): $(SESSIOND_INPUTS) $(GHOSTTY_ARTIFACT_STAMP) | toolchain
	@echo "building ReleaseFast sessiond for $(ZIG_ARCH)-macos.$(MACOS_DEPLOYMENT_TARGET)"
	@mkdir -p "$(SESSIOND_RELEASE_ROOT)"
	@/bin/rm -f "$@"
	@set -e; \
		overlay=$$("$(ROOT)/scripts/prepare-zig-xcode-overlay.sh"); \
		cd "$(ROOT)/native/sessiond"; \
		PATH="$(ROOT)/scripts/zig-runner-tools:$$PATH" "$(ZIG)" build install \
			--prefix "$(SESSIOND_RELEASE_ROOT)" \
			--global-cache-dir "$(NATIVE_CACHE)/zig-global" \
			-Dtarget=$(ZIG_ARCH)-macos.$(MACOS_DEPLOYMENT_TARGET) \
			-Doptimize=ReleaseFast \
			--sysroot "$$overlay"
	@test -x "$@" || { echo "make: ReleaseFast sessiond build produced no binary; rerun 'make native'" >&2; exit 1; }
	@touch "$@"

demo-artifacts: ghosttykit workspace sessiond

demo-preflight:
	@command -v bun >/dev/null 2>&1 || { echo "make $(DEMO_TARGET): Bun is missing; install Bun $(BUN_VERSION)" >&2; exit 2; }
	@actual=$$(bun --version); [ "$$actual" = "$(BUN_VERSION)" ] || { echo "make $(DEMO_TARGET): Bun $$actual does not match lock $(BUN_VERSION)" >&2; exit 2; }
	@command -v swift >/dev/null 2>&1 && xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 || { echo "make $(DEMO_TARGET): Xcode/Swift is unavailable; select the locked Xcode toolchain first" >&2; exit 2; }
	@if /usr/sbin/lsof -nP -iTCP:$(DEMO_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "make $(DEMO_TARGET): port $(DEMO_PORT) is in use; stop that listener and rerun 'make $(DEMO_TARGET)'" >&2; exit 2; \
	fi
	@console_user=$$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null || true); \
	[ "$$console_user" = "$$USER" ] || { echo "make $(DEMO_TARGET): log into an unlocked Aqua session as $$USER, then rerun 'make $(DEMO_TARGET)'" >&2; exit 2; }

demo: DEMO_TARGET := demo
demo: demo-preflight demo-artifacts
	@echo "launching watched typeable-terminal proof (keep the Aqua session unlocked)"
	@unset HIVE_B22_HOME; HIVE_B22_NO_APP=0 HIVE_B22_PORT=$(DEMO_PORT) bun "$(ROOT)/scripts/b22-live-attach-proof.ts"

terminal: DEMO_TARGET := terminal
terminal: demo-preflight demo-artifacts
	@echo "launching a real interactive login shell (keep the Aqua session unlocked)"
	@unset HIVE_B22_HOME; HIVE_B22_REAL_SHELL=1 HIVE_B22_NO_APP=0 HIVE_B22_PORT=$(DEMO_PORT) bun "$(ROOT)/scripts/b22-live-attach-proof.ts"

# Same pipeline the real installer consumes (src/release/build.ts), unsigned
# because no Developer ID is in the environment, then staged in the exact
# versions/<v> + current layout install.sh produces.
build: toolchain ghosttykit sessiond
	bun install --frozen-lockfile
	bun run src/release/build.ts --version $(DEV_VERSION) \
	  --commit $$(git rev-parse --short HEAD) --out "$(DIST)"
	rm -rf "$(INSTALL_ROOT)/versions/$(DEV_VERSION)"
	mkdir -p "$(INSTALL_ROOT)/versions/$(DEV_VERSION)" "$(DEV)/bin"
	install -m 755 "$(DIST)/$(CLI_ASSET)" "$(INSTALL_ROOT)/versions/$(DEV_VERSION)/hive"
	tar -xzf "$(DIST)/HiveWorkspace.tar.gz" -C "$(INSTALL_ROOT)/versions/$(DEV_VERSION)"
	ln -shf "versions/$(DEV_VERSION)" "$(INSTALL_ROOT)/current"
	@echo "staged: $$("$(HIVE_BIN)" --version)"

# With no PROJECT, the dev Workspace opens a scratch git repo inside the dev
# sandbox, created on demand and deleted by make clean along with the rest of
# .dev. An explicit PROJECT must be a git repo OUTSIDE this checkout, so the
# dev Workspace never opens the hive repo itself.
run:
	@set -e; \
	[ -x "$(HIVE_BIN)" ] || { echo "no dev build staged; run 'make build' first" >&2; exit 2; }; \
	if [ -n "$(PROJECT)" ]; then \
	  proj=$$(cd "$(PROJECT)" 2>/dev/null && pwd -P) || { echo "PROJECT does not exist: $(PROJECT)" >&2; exit 2; }; \
	  case "$$proj/" in "$(ROOT)/"*) \
	    echo "refusing: PROJECT is the hive repo (or inside it); point at a separate test repo" >&2; exit 2;; esac; \
	  [ -d "$$proj/.git" ] || { echo "PROJECT must be a git repository (run 'git init' there first): $$proj" >&2; exit 2; }; \
	else \
	  mkdir -p "$(DEV_PROJECT)"; \
	  proj=$$(cd "$(DEV_PROJECT)" && pwd -P); \
	  if [ ! -d "$$proj/.git" ]; then \
	    echo "creating dev scratch project $$proj"; \
	    git init -q "$$proj"; \
	    git -C "$$proj" -c user.name=hive -c user.email=dev@hive.local \
	      commit -q --allow-empty -m "dev scratch project"; \
	  fi; \
	fi; \
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

# Delete every dev artifact. This does NOT reliably stop a running dev
# instance: both kills below are best-effort and swallow failure, and the
# Workspace app is launched through `open -n` so it is nobody's child here and
# is never signalled at all. Survivors are left bound to the deleted .dev/.
# Quit the dev app first; issue #44 tracks making this stop the instance.
# The tmux server name derives from .dev/home, so the kill can only ever hit
# the dev server; the daemon is killed only if its pid still names a binary
# under .dev/.
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
