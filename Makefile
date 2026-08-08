# Local dev build of Hive: consumer-shaped, unsigned, isolated from any
# installed hive.
#
# Public commands:
#
#   make clean       uninstall dev while retaining its configured state
#   make clean-all   uninstall dev with --purge: retention overridden, everything destroyed
#   make build       build + stage the standalone dev release under .dev/
#   make run         run the staged dev build (defaults to this checkout)
#   make test        lint + format + typecheck + bun suites + sessiond (Zig) + Workspace (Swift)
#
# Everything else here is internal structure, never a command to run by hand:
# heals and remediation run inside these five. build is complete every time;
# correctness outranks incrementality.
#
# Isolation: every rendezvous name derives from HIVE_HOME (DEV_HOME below).
# DEV_HOME is a named instance under ~/.hive/instances, which is what that
# directory is for; the dev daemon touches nothing else in ~/.hive except the
# memory state it deliberately shares, and never ~/.local/share/hive or
# ~/.local/bin/hive.

SHELL := /bin/sh
.DEFAULT_GOAL := build

ROOT := $(CURDIR)
# Bare `make run` opens Hive on this checkout; PROJECT=/path wins.
PROJECT ?= $(ROOT)
DEV := $(ROOT)/.dev
DIST := $(DEV)/dist
INSTALL_ROOT := $(DEV)/root
DEV_VERSION := 0.0.0
HIVE_BIN := $(INSTALL_ROOT)/current/hive
DAEMON_STARTUP_LOG := $(DEV)/daemon-startup.log
# Per-checkout dev home, on the persistent volume. hive.db is the board's only
# store, so this must be somewhere the OS will not reclaim: /tmp is swept by
# /usr/libexec/tmp_cleaner, which deletes files untouched for three days, and is
# recreated empty at boot. A dev home there loses the whole board silently, with
# the directory left looking intact because its symlinks are not regular files.
# This spelling is the existing named-instance layout (see namedInstanceHome in
# src/daemon/lifecycle/instances.ts), so the dev instance is an ordinary
# instance rather than a fourth home convention.
ROOT_RESOLVED := $(shell cd "$(ROOT)" && pwd -P)
DEV_HOME_TAG := $(shell printf '%s' "$(ROOT_RESOLVED)" | /usr/bin/shasum -a 256 | cut -c1-10)
DEV_HOME := $(HOME)/.hive/instances/dev-$(DEV_HOME_TAG)
# The dev home's memory state (memory/, projects/, project-registry.json,
# models/) is SHARED with the real ~/.hive via symlinks that run's
# scripts/dev/dev-memory-setup.ts creates, so dev testing reuses live lessons.
# Nothing in this Makefile may recursively delete through those links, and the
# uninstaller clean and clean-all delegate to unlinks a symlink rather than
# following it. Daemon runtime state
# (daemon.port, credentials, logs/, hive.db) stays per-home, never linked;
# sessiond's runtime tree is not in the home at all.
LOCK := $(ROOT)/native/toolchain-lock.json
# Shared per-user cache: zig caches and lock-keyed Ghostty artifacts live
# outside the checkout so worktrees share them. Correctness comes from content
# keys, never the path.
NATIVE_CACHE ?= $(HOME)/.cache/hive/native
DEMO_CACHE := $(NATIVE_CACHE)/demo
export HIVE_NATIVE_CACHE := $(NATIVE_CACHE)

UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),arm64)
CLI_ASSET := hive-darwin-arm64
SESSIOND_ASSET := hive-sessiond-darwin-arm64
ZIG_ARCH := aarch64
else ifeq ($(UNAME_M),x86_64)
CLI_ASSET := hive-darwin-x64
SESSIOND_ASSET := hive-sessiond-darwin-x64
ZIG_ARCH := x86_64
else
$(error unsupported host architecture $(UNAME_M); expected arm64 or x86_64)
endif

ZIG_VERSION := $(shell /usr/bin/plutil -extract zig.version raw -o - $(LOCK))
MACOS_DEPLOYMENT_TARGET := $(shell /usr/bin/plutil -extract deploymentTarget raw -o - $(LOCK))
GHOSTTY_COMMIT := $(shell /usr/bin/plutil -extract ghostty.commit raw -o - $(LOCK))
GHOSTTY_PATCH_SHA := $(shell /usr/bin/plutil -extract ghostty.patchSeriesSha256 raw -o - $(LOCK))
# The system zig on PATH is the compiler; the lock pins its exact version.
ZIG := zig
TOOLCHAIN_STAMP := $(DEMO_CACHE)/toolchain-$(ZIG_VERSION).stamp
GHOSTTY_ARTIFACT := $(NATIVE_CACHE)/artifacts/ghostty-$(GHOSTTY_COMMIT)-zig-$(ZIG_VERSION)
GHOSTTY_ARTIFACT_INFO := $(GHOSTTY_ARTIFACT)/GhosttyKit.xcframework/Info.plist
# Content key, not mtime: the stamp name digests the whole lock, so any locked
# input change forces a rebuild while a fresh worktree still reuses the artifact.
LOCK_SHA := $(shell /usr/bin/shasum -a 256 $(LOCK) | cut -c1-16)
GHOSTTY_ARTIFACT_STAMP := $(GHOSTTY_ARTIFACT)/.hive-lock-$(LOCK_SHA).stamp
# The artifact key omits most locked inputs, so a stale artifact can wear a
# current stamp. This must stay at PARSE time: make stats a target and decides
# to remake it before any prerequisite's recipe could drop the stamp.
GHOSTTY_ARTIFACT_HEAL := $(shell "$(ROOT)/scripts/native/ghostty-artifact-heal.sh" \
  "$(GHOSTTY_ARTIFACT)" "$(LOCK)" "$(GHOSTTY_ARTIFACT_STAMP)")
$(if $(GHOSTTY_ARTIFACT_HEAL),$(info make: $(GHOSTTY_ARTIFACT_HEAL)))
GHOSTTYKIT := $(ROOT)/workspace/Vendor/GhosttyKit.xcframework
GHOSTTYKIT_INFO := $(GHOSTTYKIT)/Info.plist
# Deliberately NOT SwiftPM's name: a debug build's file name becomes its process
# name in the unified log, indistinguishable from the installed app. The rule
# below renames it so clean and process binding can tell them apart.
WORKSPACE_BIN := $(ROOT)/workspace/.build/debug/HiveWorkspaceDev
# The QA executable, not the shipped one: it is the app plus the headless smoke
# checks and the frozen-corpus shell, which the product no longer carries. The
# evidence flows launch this file, so they keep working unchanged.
WORKSPACE_SPM_BIN := $(ROOT)/workspace/.build/debug/HiveWorkspaceQA
# Per-checkout: built from THIS worktree's sources, never the shared cache.
SESSIOND_RELEASE_ROOT := $(ROOT)/.cache/sessiond-releasefast
SESSIOND_RELEASE_BIN := $(SESSIOND_RELEASE_ROOT)/bin/hive-sessiond
SESSIOND_BIN := $(ROOT)/native/sessiond/zig-out/bin/hive-sessiond
GRAPHIFY_LOCAL_DIR := $(DEV)/graphify
GRAPHIFY_LOCAL_MANIFEST := $(GRAPHIFY_LOCAL_DIR)/graphify-runtime.json

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
	$(ROOT)/scripts/native/build-ghosttykit.sh \
	$(ROOT)/scripts/native/check-ghostty-abi.sh \
	$(ROOT)/scripts/native/preflight-native-toolchain.sh \
	$(ROOT)/scripts/native/prepare-zig-xcode-overlay.sh \
	$(ROOT)/scripts/native/qualify-ghostty-checkpoint.sh \
	$(ROOT)/scripts/native/qualify-ghostty-release-lock.sh \
	$(ROOT)/scripts/native/vendor-ghostty.sh \
	$(ROOT)/scripts/native/write-ghostty-artifact-metadata.ts
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
	$(ROOT)/scripts/native/prepare-zig-xcode-overlay.sh \
	$(ROOT)/scripts/native/zig-runner-tools/xcrun \
	$(LOCK) \
	$(GHOSTTY_ENGINE_INPUTS)

# HIVE_EMBEDDINGS_SOURCE points provisioning at this checkout's node_modules, so
# `hive init` stages the embedding runtime from source instead of downloading a
# release the dev version is not pinned to. A dev run provisions through init
# like every other path — there is no separate install command — and
# scripts/dev/verify-dev-run.ts refuses to hand over a daemon whose embeddings are
# not "ready" after a live recall probe.
#
# OTUI_ASSET_ROOT makes every compiled dev binary load OpenTUI's native dylib and
# tree-sitter assets straight out of node_modules. Without it, Bun materializes a
# fresh copy of the embedded libopentui.dylib into TMPDIR on every process that
# initializes a renderer and never deletes it — with TMPDIR pinned to .dev/tmp
# that accumulated 4.5 MB per agent-ui/daemon process forever. The variable names
# a complete asset set: OpenTUI throws if any asset it resolves is missing under
# the root, and node_modules is the only tree that has all of them.
DEV_ENV := \
	HIVE_HOME=$(DEV_HOME) \
	HIVE_EMBEDDINGS_SOURCE=$(ROOT) \
	HIVE_INSTALL_ROOT=$(INSTALL_ROOT) \
	HIVE_BIN_LINK=$(DEV)/bin/hive \
	HIVE_DISABLE_UPDATES=1 \
	HIVE_GRAPHIFY_MANIFEST=$(GRAPHIFY_LOCAL_MANIFEST) \
	HIVE_PORT=0 \
	OTUI_ASSET_ROOT=$(ROOT)/node_modules \
	TMPDIR=$(DEV)/tmp

# The five public commands, then the internal structure they pull in.
.PHONY: clean clean-all build run test sessiond toolchain graphify-local

graphify-local: $(GRAPHIFY_LOCAL_MANIFEST)

$(GRAPHIFY_LOCAL_MANIFEST): graphify.lock $(shell find "$(ROOT)/scripts/graphify" -type f)
	@mkdir -p "$(GRAPHIFY_LOCAL_DIR)"
	@"$(ROOT)/scripts/graphify/build.sh" --arch "$(if $(filter arm64,$(UNAME_M)),arm64,x64)" --out "$(GRAPHIFY_LOCAL_DIR)"
	@bun run "$(ROOT)/scripts/graphify/write-manifest.ts" \
	  --out "$(GRAPHIFY_LOCAL_DIR)" --manifest "$@" --build 1 \
	  --source "$$(git rev-parse HEAD)"

# System zig (version pinned by the lock) + the hash-verified Ghostty dep cache.
toolchain: $(TOOLCHAIN_STAMP)

$(TOOLCHAIN_STAMP): $(LOCK) \
		$(ROOT)/scripts/native/provision-native-toolchain.sh \
		$(ROOT)/scripts/native/validate-native-toolchain-lock.sh \
		$(ROOT)/scripts/native/ghostty-dependency-cache.ts \
		$(ROOT)/vendor/ghostty/build.zig.zon.json
	@mkdir -p "$(DEMO_CACHE)"
	@"$(ROOT)/scripts/native/provision-native-toolchain.sh"
	@touch "$@"

# Catches vendor-tree drift the lock does not record. Runs on every build and
# test, so it stays git-cheap; the byte-level prover lives in the artifact build.
.PHONY: vendor-verify
vendor-verify:
	@set -e; \
	dirty=$$(git -C "$(ROOT)" status --porcelain -- vendor/ghostty); \
	if [ -n "$$dirty" ]; then \
	  echo "make: vendor/ghostty has uncommitted changes; commit them, update native/toolchain-lock.json (ghostty.patchedTree), and prove with scripts/native/vendor-ghostty.sh verify:" >&2; \
	  printf '%s\n' "$$dirty" | head >&2; exit 1; \
	fi; \
	tree=$$(git -C "$(ROOT)" rev-parse HEAD:vendor/ghostty); \
	locked=$$(/usr/bin/plutil -extract ghostty.patchedTree raw -o - "$(LOCK)"); \
	if [ "$$tree" != "$$locked" ]; then \
	  echo "make: vendor/ghostty tree $$tree does not match lock patchedTree $$locked; run scripts/native/vendor-ghostty.sh verify" >&2; exit 1; \
	fi

# No mtime prerequisites on purpose: the stamp name is the content key, so a
# fresh worktree reuses the artifact instead of a full rebuild.
$(GHOSTTY_ARTIFACT_STAMP): | toolchain
	@echo "building lock-pinned GhosttyKit"
	@"$(ROOT)/scripts/native/build-ghosttykit.sh"
	@test -f "$(GHOSTTY_ARTIFACT_INFO)" || { echo "make: GhosttyKit build produced no artifact; rerun 'make build'" >&2; exit 1; }
	@ls "$(GHOSTTY_ARTIFACT)"/GhosttyKit.xcframework/macos-*/lib*.a >/dev/null 2>&1 || { echo "make: GhosttyKit macOS archive is invalid; rerun 'make build'" >&2; exit 1; }
	@test -f "$(GHOSTTY_ARTIFACT)/checkpoint-fixtures/$(UNAME_M)/corpus.hvg6" || { echo "make: GhosttyKit checkpoint corpus is missing; rerun 'make build'" >&2; exit 1; }
	@touch "$@"

# sessiond compiles the engine from vendor/ghostty; the app links this staged
# archive. Nothing structural makes them equal — the lock check is what does, and
# without it a stale artifact stages silently and every pane attach dies.
$(GHOSTTYKIT_INFO): $(GHOSTTY_ARTIFACT_STAMP)
	@"$(ROOT)/scripts/native/ghostty-artifact-lock-check.sh" "$(GHOSTTY_ARTIFACT)" "$(LOCK)" || { echo "make: cached GhosttyKit artifact does not record the toolchain lock's ghostty source identity; refusing to stage it (rerun 'make build')" >&2; exit 1; }
	@echo "staging lock-pinned GhosttyKit for SwiftPM"
	@/bin/rm -rf "$(GHOSTTYKIT)" "$(ROOT)/workspace/Vendor/checkpoint-fixtures"
	@mkdir -p "$(ROOT)/workspace/Vendor"
	@/usr/bin/ditto "$(GHOSTTY_ARTIFACT)/GhosttyKit.xcframework" "$(GHOSTTYKIT)"
	@/usr/bin/ditto "$(GHOSTTY_ARTIFACT)/checkpoint-fixtures" "$(ROOT)/workspace/Vendor/checkpoint-fixtures"
	@test -f "$@" || { echo "make: GhosttyKit staging failed; rerun 'make build'" >&2; exit 1; }
	@touch "$@"

# Not reached by the four: release builds its own. This is for the attach/smoke
# harness (scripts/qa/b22-live-attach-proof.ts), which builds it by absolute path.
$(WORKSPACE_BIN): $(WORKSPACE_INPUTS) $(GHOSTTYKIT_INFO)
	@echo "building Workspace Swift executable"
	@swift build --package-path "$(ROOT)/workspace"
	@test -x "$(WORKSPACE_SPM_BIN)" || { echo "make: Workspace build produced no executable" >&2; exit 1; }
	@/bin/mv -f "$(WORKSPACE_SPM_BIN)" "$@"
	@test -x "$@" || { echo "make: could not rename the Workspace executable to $@" >&2; exit 1; }
	@touch "$@"

sessiond: $(SESSIOND_BIN)
	@if ! /usr/bin/cmp -s "$(SESSIOND_RELEASE_BIN)" "$(SESSIOND_BIN)"; then \
		echo "replacing non-ReleaseFast sessiond proof binary"; \
		/bin/cp "$(SESSIOND_RELEASE_BIN)" "$(SESSIOND_BIN)"; \
		/bin/chmod 755 "$(SESSIOND_BIN)"; \
	fi
	@/usr/bin/cmp -s "$(SESSIOND_RELEASE_BIN)" "$(SESSIOND_BIN)" || { echo "make: sessiond is not the ReleaseFast proof build; rerun 'make build'" >&2; exit 1; }

$(SESSIOND_BIN): $(SESSIOND_RELEASE_BIN)
	@mkdir -p "$(@D)"
	@/bin/cp "$(SESSIOND_RELEASE_BIN)" "$@"
	@/bin/chmod 755 "$@"

$(SESSIOND_RELEASE_BIN): $(SESSIOND_INPUTS) $(GHOSTTY_ARTIFACT_STAMP) | toolchain
	@echo "building ReleaseFast sessiond for $(ZIG_ARCH)-macos.$(MACOS_DEPLOYMENT_TARGET)"
	@mkdir -p "$(SESSIOND_RELEASE_ROOT)"
	@/bin/rm -f "$@"
	@set -e; \
		overlay=$$("$(ROOT)/scripts/native/prepare-zig-xcode-overlay.sh"); \
		cd "$(ROOT)/native/sessiond"; \
		PATH="$(ROOT)/scripts/native/zig-runner-tools:$$PATH" "$(ZIG)" build install \
			--prefix "$(SESSIOND_RELEASE_ROOT)" \
			--cache-dir "$(NATIVE_CACHE)/zig-local/sessiond" \
			--global-cache-dir "$(NATIVE_CACHE)/zig-global" \
			-Dtarget=$(ZIG_ARCH)-macos.$(MACOS_DEPLOYMENT_TARGET) \
			-Doptimize=ReleaseFast \
			--sysroot "$$overlay"
	@test -x "$@" || { echo "make: ReleaseFast sessiond build produced no binary; rerun 'make build'" >&2; exit 1; }
	@touch "$@"

# The real installer's pipeline (src/release/build.ts), unsigned for want of a
# Developer ID, staged in the exact layout install.sh produces.
build:
	/bin/rm -f "$(HIVE_BIN)"
	$(MAKE) toolchain vendor-verify "$(GHOSTTYKIT_INFO)" sessiond
	bun install --frozen-lockfile --os=darwin --cpu='*'
	$(MAKE) graphify-local
	bun run src/release/build.ts --version $(DEV_VERSION) \
	  --variant dev --commit $$(git rev-parse --short HEAD) --out "$(DIST)"
	HIVE_HOME="$(DEV_HOME)" HIVE_INSTALL_ROOT="$(INSTALL_ROOT)" \
	  HIVE_BIN_LINK="$(DEV)/bin/hive-dev" HIVE_BIN_DIR="$(DEV)/bin" \
	  sh "$(ROOT)/install.sh" --variant dev --from-build "$(DIST)" "$(DEV_VERSION)"
	@echo "staged: $$("$(HIVE_BIN)" --version)"

# PROJECT defaults to this checkout (inside a worktree, that worktree). An
# explicit PROJECT wins, but anything inside this checkout other than its root
# is refused.
run:
	@set -e; \
	[ -x "$(HIVE_BIN)" ] || { echo "no dev build staged; run 'make build' first" >&2; exit 2; }; \
	proj=$$(cd "$(PROJECT)" 2>/dev/null && pwd -P) || { echo "PROJECT does not exist: $(PROJECT)" >&2; exit 2; }; \
	if [ "$$proj" != "$(ROOT)" ]; then \
	  case "$$proj/" in "$(ROOT)/"*) \
	    echo "refusing: PROJECT is inside the hive checkout but is not its root; point at the root or a separate repo" >&2; exit 2;; esac; \
	fi; \
	[ -e "$$proj/.git" ] || { echo "PROJECT must be a git repository (run 'git init' there first): $$proj" >&2; exit 2; }; \
	mkdir -p "$(DEV_HOME)" "$(DEV)/bin" "$(DEV)/tmp"; \
	bun run "$(ROOT)/scripts/dev/dev-memory-setup.ts" "$(DEV_HOME)" "$(HOME)/.hive"; \
	cd "$$proj"; \
	env $(DEV_ENV) "$(HIVE_BIN)" init; \
	/bin/rm -f "$(DAEMON_STARTUP_LOG)"; \
	env $(DEV_ENV) "$(HIVE_BIN)" daemon >"$(DAEMON_STARTUP_LOG)" 2>&1 & daemon_pid=$$!; \
	if ! bun run "$(ROOT)/scripts/dev/verify-dev-run.ts" "$(DAEMON_STARTUP_LOG)" "$(HIVE_BIN)" "$(ROOT)" "$$daemon_pid"; then \
	  kill "$$daemon_pid" 2>/dev/null || true; \
	  wait "$$daemon_pid" 2>/dev/null || true; \
	  exit 1; \
	fi; \
	if ! env $(DEV_ENV) "$(HIVE_BIN)"; then \
	  kill "$$daemon_pid" 2>/dev/null || true; \
	  wait "$$daemon_pid" 2>/dev/null || true; \
	  exit 1; \
	fi; \
	if ! bun run "$(ROOT)/scripts/dev/verify-dev-run.ts" --memory "$(DEV_HOME)"; then \
	  kill "$$daemon_pid" 2>/dev/null || true; \
	  wait "$$daemon_pid" 2>/dev/null || true; \
	  exit 1; \
	fi

# No pipes anywhere: a red suite must exit red. The real-CLI e2e suite is already
# inside `bun run test` and self-skips unless HIVE_E2E=1; opting in is
# `HIVE_E2E=1 bun run scripts/test-sandbox.ts -- bun test test/cli/e2e-real.test.ts`.
test: toolchain vendor-verify $(GHOSTTYKIT_INFO)
	bun install --frozen-lockfile
	bun run check
	bun run test
	cd workspace && swift test

# Clean delegates state ownership and liveness to the same uninstaller every
# native install uses. The binary must exist because source-running a second
# implementation would make clean disagree with the installed variant record.
# clean-all is the same call with --purge: the uninstaller's retention set
# overridden to nothing, never a second sweep.
clean clean-all:
	@set -e; \
	if [ -x "$(HIVE_BIN)" ]; then \
		if [ "$@" = clean-all ]; then env $(DEV_ENV) "$(HIVE_BIN)" uninstall --yes --purge; \
		else env $(DEV_ENV) "$(HIVE_BIN)" uninstall --yes; fi; \
	else echo "no installed dev binary; removing build output only"; fi; \
	rm -rf "$(DEV)" "$(ROOT)"/.*.bun-build
