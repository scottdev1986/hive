# Local dev build of Hive: consumer-shaped, unsigned, fully isolated from any
# installed hive and its running instances.
#
#   make build                  build + stage the standalone dev release under .dev/
#   make run                    run the staged dev build (defaults to .dev/project)
#   make demo                   build fresh terminal artifacts + launch watched proof
#   make terminal               build fresh artifacts + launch a real login shell
#   make test                   bun suites + sessiond (Zig) + Workspace (Swift)
#   make cleanup                stop the dev instance and delete all dev artifacts
#
# `make build && make run` is the developer flow: it builds every artifact the
# dev release needs (pinned Zig, GhosttyKit, ReleaseFast sessiond, the CLI and
# the Workspace app) and launches the staged Workspace. Its terminal panes stay
# blank for now: nothing in the shipped stack starts the sessiond broker yet, so
# `make terminal` remains the entrypoint for a live M1 typeable terminal.
#
# Isolation: every rendezvous name (tmux socket/sessions, sessiond broker,
# daemon port/pid, sqlite db, project registry) derives from HIVE_HOME. make
# run points HIVE_HOME at a short per-checkout path under /tmp (see DEV_HOME
# below), not at .dev/home: sessiond places AF_UNIX sockets under
# $HIVE_HOME/runtime/sessiond/..., and macOS sun_path (~104 bytes) rejects a
# deep worktree path with SocketPathTooLong. Staged binaries stay under .dev/;
# HIVE_INSTALL_ROOT points at the staged dev root so the dev CLI launches the
# dev-built HiveWorkspace.app, never the installed one. Nothing here reads or
# writes ~/.hive, ~/.local/share/hive, or ~/.local/bin/hive.

SHELL := /bin/sh
.DEFAULT_GOAL := help

ROOT := $(CURDIR)
DEV := $(ROOT)/.dev
# `#` opens a comment in makefile text, so a tmux format like #{pid} cannot be
# written inline; escaping it reaches the shell as a literal backslash.
HASH := \#
DIST := $(DEV)/dist
INSTALL_ROOT := $(DEV)/root
DEV_PROJECT := $(DEV)/project
DEV_VERSION := 0.0.0
HIVE_BIN := $(INSTALL_ROOT)/current/hive
# Short per-checkout HIVE_HOME: digest of the resolved checkout path keeps
# worktrees isolated from each other while the path itself stays short enough
# for sessiond host sockets. clean hashes this same literal string for the
# tmux socket token (axis 3) so it still finds the live server after a move.
ROOT_RESOLVED := $(shell cd "$(ROOT)" && pwd -P)
DEV_HOME_TAG := $(shell printf '%s' "$(ROOT_RESOLVED)" | /usr/bin/shasum -a 256 | cut -c1-10)
DEV_HOME := /tmp/hive-dev-$(DEV_HOME_TAG)
LOCK := $(ROOT)/native/toolchain-lock.json
NATIVE_CACHE ?= $(ROOT)/.cache/native
DEMO_CACHE := $(NATIVE_CACHE)/demo
export HIVE_NATIVE_CACHE := $(NATIVE_CACHE)

UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),arm64)
CLI_ASSET := hive-darwin-arm64
SESSIOND_ASSET := hive-sessiond-darwin-arm64
ZIG_ARCH := aarch64
ZIG_LOCK_ARCH := arm64
else ifeq ($(UNAME_M),x86_64)
CLI_ASSET := hive-darwin-x64
SESSIOND_ASSET := hive-sessiond-darwin-x64
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
	HIVE_HOME=$(DEV_HOME) \
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
	@echo "make cleanup               stop the dev instance, then delete all dev artifacts"
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
	install -m 755 "$(DIST)/$(SESSIOND_ASSET)" \
	  "$(INSTALL_ROOT)/versions/$(DEV_VERSION)/hive-sessiond"
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
	mkdir -p "$(DEV_HOME)" "$(DEV)/bin" "$(DEV)/tmp" "$(DEV)/tmux"; \
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

# Stop the dev instance, then delete every dev artifact — and never the second
# without the first. Deleting .dev/ out from under a live app was the defect
# (#44): the Workspace is launched through open -n, so it is nobody's child
# here and no signal ever reached it, and the two targeted kills below are
# best-effort by nature, so a miss was undetectable.
#
# The fix is not a louder kill. Nothing here trusts a kill: the sweep re-reads
# the process table afterwards, and rm -rf runs only if that readback is
# empty. A survivor refuses the delete and exits non-zero, because reporting
# success over a live process is what made this silent for so long.
#
# Selection is by PATH and ARGUMENTS, never by process name. The user's
# installed instance runs its own Workspace, its own tmux server and its own
# vendor CLI children; matching HiveWorkspace or tmux would kill those.
# Three axes are needed because dev processes are bound three different ways:
#
#   1. executable under .dev/     — the Workspace app, staged dev binaries
#   2. .dev/ OR HIVE_HOME in args — tmux/vendor children and settings paths;
#                                   HIVE_HOME is the short /tmp/hive-dev-* path
#   3. dev tmux socket in args    — hash of the short HIVE_HOME literal (same
#                                   string make run exports / hiveInstanceSuffix)
#
# A clean must also work when .dev/ and/or the short home is ALREADY GONE.
# The guard is: either directory exists OR the sweep finds processes bound
# to either.
#
# The socket digest hashes the short HIVE_HOME literal — not a path under
# .dev/. That has no dependency on either directory existing.
#
# Every refusal below is deliberate. An empty path or an empty digest must STOP
# the target. An empty dev would make the axis-1 prefix match every absolute
# path on the machine.
#
# NAMING THE DEV INSTANCE IS NOT BEING IT. Argv only nominates a CANDIDATE.
# Killing requires binding evidence that outlives the directory:
#   - executable under the dev path (any of its three spellings)
#   - cwd or an open file under the dev path OR the short HIVE_HOME path,
#     per lsof, with literal component-boundary matching
#   - being the tmux server for the dev socket, or one of its clients
# Anything else is a mentioner: reported, never signalled.
#
# SHORT-HOME SPELLINGS: HIVE_HOME is /tmp/hive-dev-TAG. On macOS /tmp links
# to /private/tmp, so the same three-spelling discipline applies to home:
# homel is the literal DEV_HOME string (argv + socket digest), home is that
# string after emptiness checks, homep is the deepest-surviving-ancestor
# physical form for lsof. The socket digest always hashes the literal home
# string, never realpath. Component boundary stops home-sibling matches.
#
# The invoking process whole ancestor chain is excluded (full walk to pid 1).
#
# Prefer stranding to killing: wrong inclusion is unbounded; wrong exclusion
# is recoverable. The found-mentioners line is load-bearing.
#
# Survivor readback gates BOTH deletions: if anything bound to .dev or the
# short home is still alive, neither directory is removed.
clean:
	@set -e; \
	: "every command substitution below is guarded against errexit aborting the target on a non-interesting failure; required values are refused when empty rather than defaulted"; \
	if [ -d "$(DEV)" ]; then dev=$$(cd "$(DEV)" && pwd -P) || true; else dev="$(DEV)"; fi; \
	[ -n "$$dev" ] || { echo "refusing: could not determine the dev directory path" >&2; exit 1; }; \
	case "$$dev" in /*) ;; *) echo "refusing: dev path is not absolute ($$dev)" >&2; exit 1;; esac; \
	home="$(DEV_HOME)"; \
	[ -n "$$home" ] || { echo "refusing: could not determine the dev HIVE_HOME path" >&2; exit 1; }; \
	case "$$home" in /*) ;; *) echo "refusing: dev HIVE_HOME is not absolute ($$home)" >&2; exit 1;; esac; \
	self=$$$$; \
	suffix=$$(printf '%s' "$$home" | /usr/bin/shasum -a 256 | cut -c1-10) || true; \
	[ -n "$$suffix" ] || { echo "refusing: could not derive the dev tmux socket name" >&2; exit 1; }; \
	TMUX_TMPDIR="$$dev/tmux" tmux -L "hive-$$suffix" kill-server 2>/dev/null || true; \
	if [ -f "$$home/daemon.pid" ]; then \
	  pid=$$(cat "$$home/daemon.pid" 2>/dev/null) || true; \
	  [ -n "$$pid" ] || { echo "refusing: could not read daemon.pid under HIVE_HOME" >&2; exit 1; }; \
	  command=$$(ps -p "$$pid" -o comm= 2>/dev/null || true); \
	  case "$$command" in "$$dev"/*) kill "$$pid" 2>/dev/null || true;; esac; \
	fi; \
	is_mine() { q=$$1; k=0; \
	  : "a pid whose ancestry cannot be resolved has already exited"; \
	  while [ $$k -lt 8 ]; do \
	    [ "$$q" = "$$self" ] && return 0; \
	    q=$$(ps -p "$$q" -o ppid= 2>/dev/null | tr -d ' '); \
	    [ -n "$$q" ] || return 0; [ "$$q" = "1" ] && return 1; \
	    k=$$((k + 1)); \
	  done; return 1; }; \
	: "full ancestor walk terminates on pid 1, pid 0, or unresolvable parent; 4096 is a cycle backstop that refuses"; \
	ancestors=" "; a=$$self; k=0; complete=no; \
	while [ $$k -lt 4096 ]; do \
	  a=$$(ps -p "$$a" -o ppid= 2>/dev/null | tr -d ' '); \
	  [ -n "$$a" ] || { complete=yes; break; }; \
	  [ "$$a" = "0" ] && { complete=yes; break; }; \
	  ancestors="$$ancestors$$a "; \
	  [ "$$a" = "1" ] && { complete=yes; break; }; \
	  k=$$((k + 1)); \
	done; \
	[ "$$complete" = yes ] || { \
	  echo "refusing: could not walk the full ancestor chain; some ancestor would be kill-eligible" >&2; exit 1; }; \
	excluded() { case "$$ancestors" in *" $$1 "*) return 0;; esac; is_mine "$$1"; }; \
	tmuxpids=" $$( { tmux -L "hive-$$suffix" display -p '$(HASH){pid}' 2>/dev/null; \
	    tmux -L "hive-$$suffix" list-clients -F '$(HASH){client_pid}' 2>/dev/null; \
	  } | tr '\n' ' ')"; \
	: "three spellings for .dev: literal caller path, pwd-P when present, deepest surviving ancestor for deleted dirs"; \
	devl="$(DEV)"; \
	devp="$$dev"; d="$$dev"; rest=""; \
	while [ ! -d "$$d" ] && [ "$$d" != "/" ] && [ -n "$$d" ]; do \
	  b=$$(basename "$$d") || true; \
	  [ -n "$$b" ] || { echo "refusing: could not basename a deleted-dev path component" >&2; exit 1; }; \
	  rest="/$$b$$rest"; \
	  d=$$(dirname "$$d") || true; \
	  [ -n "$$d" ] || { echo "refusing: could not dirname a deleted-dev path component" >&2; exit 1; }; \
	done; \
	if [ -d "$$d" ]; then \
	  base=$$(cd "$$d" && pwd -P) || true; \
	  [ -n "$$base" ] || { echo "refusing: could not resolve surviving ancestor of the dev path" >&2; exit 1; }; \
	  devp="$$base$$rest"; \
	fi; \
	: "same three-spelling discipline for short HIVE_HOME under tmp"; \
	homel="$(DEV_HOME)"; \
	homep="$$home"; hd="$$home"; hrest=""; \
	while [ ! -d "$$hd" ] && [ "$$hd" != "/" ] && [ -n "$$hd" ]; do \
	  hb=$$(basename "$$hd") || true; \
	  [ -n "$$hb" ] || { echo "refusing: could not basename a deleted-home path component" >&2; exit 1; }; \
	  hrest="/$$hb$$hrest"; \
	  hd=$$(dirname "$$hd") || true; \
	  [ -n "$$hd" ] || { echo "refusing: could not dirname a deleted-home path component" >&2; exit 1; }; \
	done; \
	if [ -d "$$hd" ]; then \
	  hbase=$$(cd "$$hd" && pwd -P) || true; \
	  [ -n "$$hbase" ] || { echo "refusing: could not resolve surviving ancestor of HIVE_HOME" >&2; exit 1; }; \
	  homep="$$hbase$$hrest"; \
	fi; \
	: "is_bound: executable under any spelling, any open fd under any spelling with literal component boundary, or tmux server or client pid"; \
	is_bound() { \
	  case "$$(ps -p "$$1" -o comm= 2>/dev/null)" in \
	    "$$dev"/*|"$$devp"/*|"$$devl"/*|"$$home"/*|"$$homep"/*|"$$homel"/*) return 0;; esac; \
	  if lsof -n -P -a -p "$$1" -Fn 2>/dev/null \
	    | awk -v d="$$dev" -v dp="$$devp" -v dl="$$devl" \
	          -v h="$$home" -v hp="$$homep" -v hl="$$homel" ' \
	        /^n/ { p = substr($$0, 2); \
	               if (p == d  || index(p, d  "/") == 1) { found = 1; exit } \
	               if (p == dp || index(p, dp "/") == 1) { found = 1; exit } \
	               if (p == dl || index(p, dl "/") == 1) { found = 1; exit } \
	               if (p == h  || index(p, h  "/") == 1) { found = 1; exit } \
	               if (p == hp || index(p, hp "/") == 1) { found = 1; exit } \
	               if (p == hl || index(p, hl "/") == 1) { found = 1; exit } } \
	        END { exit(found ? 0 : 1) }'; then return 0; fi; \
	  case "$$tmuxpids " in *" $$1 "*) return 0;; esac; \
	  return 1; }; \
	: "nominate on any spelling of dev or home, on the socket token, and on tmux-reported pids; exclude self and ancestors"; \
	candidates() { \
	  { ps -axo pid=,comm= | while read -r p c; do \
	      case "$$c" in \
	        "$$dev"/*|"$$devp"/*|"$$devl"/*|"$$home"/*|"$$homep"/*|"$$homel"/*) echo "$$p";; \
	      esac; done; \
	    ps -axo pid=,command= | while read -r p rest; do \
	      case "$$rest" in \
	        *"$$dev"/*|*"$$devp"/*|*"$$devl"/*|*"$$home"/*|*"$$homep"/*|*"$$homel"/*) echo "$$p";; \
	      esac; done; \
	    ps -axo pid=,command= | while read -r p rest; do \
	      case "$$rest" in *"hive-$$suffix"*) echo "$$p";; esac; done; \
	    printf '%s\n' $$tmuxpids; \
	  } | sort -u | while read -r p; do \
	    [ -n "$$p" ] || continue; excluded "$$p" || echo "$$p"; done; }; \
	: "filters: empty selection is not a failure; every call site needs its own or-true against errexit"; \
	dev_pids() { candidates | while read -r p; do is_bound "$$p" && echo "$$p"; done; :; }; \
	mentioners() { candidates | while read -r p; do is_bound "$$p" || echo "$$p"; done; :; }; \
	pids=$$(dev_pids) || true; \
	named=$$(mentioners) || true; \
	[ -z "$$named" ] || echo "found mentioners, not killing:" $$named; \
	if [ ! -d "$(DEV)" ] && [ ! -d "$$home" ] && [ -z "$$pids" ]; then exit 0; \
	fi; \
	: "empty sweep is trustworthy only because every derivation refused rather than defaulted"; \
	if [ -n "$$pids" ]; then \
	  echo "stopping dev processes:" $$pids; \
	  for p in $$pids; do kill "$$p" 2>/dev/null || true; done; \
	  alive=""; \
	  i=0; while [ $$i -lt 20 ]; do \
	    alive=$$(dev_pids) || true; [ -n "$$alive" ] || break; sleep 0.5; i=$$((i + 1)); \
	  done; \
	  if [ -n "$$alive" ]; then \
	    echo "refusing to delete $(DEV) / $$home: still running:" $$alive >&2; \
	    echo "they run from files under $(DEV) or $$home; deleting would strand them" >&2; \
	    exit 1; \
	  fi; \
	  echo "all dev processes confirmed stopped"; \
	fi; \
	rm -rf "$(DEV)" "$$home"


cleanup: clean

# Also drop the expensive native caches (pinned Zig, Ghostty artifacts) and
# intermediate build state. The next make build re-provisions from scratch.
deepclean: clean
	rm -rf "$(ROOT)/.cache/native" "$(GHOSTTYKIT)" \
	  "$(ROOT)/workspace/.build" "$(ROOT)/.zig-cache" \
	  "$(ROOT)/native/sessiond/zig-out" "$(ROOT)/native/sessiond/.zig-cache"
