# Local dev build of Hive: consumer-shaped, unsigned, isolated from any
# installed hive.
#
# The whole command surface (user ruling, 2026-07-21):
#
#   make clean   stop the dev instance, then delete all dev artifacts
#   make build   build + stage the standalone dev release under .dev/
#   make run     run the staged dev build (defaults to this checkout)
#   make test    bun suites + sessiond (Zig) + Workspace (Swift)
#
# Everything else here is internal structure, never a command to run by hand:
# heals and remediation run inside these four. No fifth command. build is
# complete every time; correctness outranks incrementality.
#
# Isolation: every rendezvous name derives from HIVE_HOME (DEV_HOME below).
# Nothing reads or writes ~/.hive, ~/.local/share/hive, or ~/.local/bin/hive.

SHELL := /bin/sh
.DEFAULT_GOAL := build

ROOT := $(CURDIR)
# Bare `make run` opens Hive on this checkout; PROJECT=/path wins.
PROJECT ?= $(ROOT)
DEV := $(ROOT)/.dev
# `#` starts a makefile comment, so tmux formats like #{pid} need the escape.
HASH := \#
DIST := $(DEV)/dist
INSTALL_ROOT := $(DEV)/root
DEV_VERSION := 0.0.0
HIVE_BIN := $(INSTALL_ROOT)/current/hive
# Short per-checkout home: sessiond's canonical host socket path must fit macOS's
# 103-char sun_path (this spelling costs 100). Do not lengthen it. clean hashes
# the same literal string for its tmux socket token.
ROOT_RESOLVED := $(shell cd "$(ROOT)" && pwd -P)
DEV_HOME_TAG := $(shell printf '%s' "$(ROOT_RESOLVED)" | /usr/bin/shasum -a 256 | cut -c1-10)
DEV_HOME := /tmp/hv-$(DEV_HOME_TAG)
LOCK := $(ROOT)/native/toolchain-lock.json
# Shared per-user cache (#46): zig caches and lock-keyed Ghostty artifacts live
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
GHOSTTY_ARTIFACT_HEAL := $(shell "$(ROOT)/scripts/ghostty-artifact-heal.sh" \
  "$(GHOSTTY_ARTIFACT)" "$(LOCK)" "$(GHOSTTY_ARTIFACT_STAMP)")
$(if $(GHOSTTY_ARTIFACT_HEAL),$(info make: $(GHOSTTY_ARTIFACT_HEAL)))
GHOSTTYKIT := $(ROOT)/workspace/Vendor/GhosttyKit.xcframework
GHOSTTYKIT_INFO := $(GHOSTTYKIT)/Info.plist
# Deliberately NOT SwiftPM's name: a debug build's file name becomes its process
# name in the unified log, indistinguishable from the installed app
# (docs/incidents/2026-07-20-workspace-death.md). The rule below renames it.
WORKSPACE_BIN := $(ROOT)/workspace/.build/debug/HiveWorkspaceDev
WORKSPACE_SPM_BIN := $(ROOT)/workspace/.build/debug/HiveWorkspace
# Per-checkout: built from THIS worktree's sources, never the shared cache.
SESSIOND_RELEASE_ROOT := $(ROOT)/.cache/sessiond-releasefast
SESSIOND_RELEASE_BIN := $(SESSIOND_RELEASE_ROOT)/bin/hive-sessiond
SESSIOND_BIN := $(ROOT)/native/sessiond/zig-out/bin/hive-sessiond

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

# TMUX_TMPDIR is deliberately NOT set: the daemon and the user's launcher must
# reach the same tmux server, and the per-instance socket name already isolates
# it. Setting it here broke every root wake (#68).
DEV_ENV := \
	HIVE_HOME=$(DEV_HOME) \
	HIVE_INSTALL_ROOT=$(INSTALL_ROOT) \
	HIVE_BIN_LINK=$(DEV)/bin/hive \
	HIVE_DISABLE_UPDATES=1 \
	HIVE_PORT=0 \
	TMPDIR=$(DEV)/tmp

# The four public commands, then the internal structure they pull in.
.PHONY: clean build run test sessiond toolchain

# System zig (version pinned by the lock) + the hash-verified Ghostty dep cache.
toolchain: $(TOOLCHAIN_STAMP)

$(TOOLCHAIN_STAMP): $(LOCK) \
		$(ROOT)/scripts/provision-native-toolchain.sh \
		$(ROOT)/scripts/validate-native-toolchain-lock.sh \
		$(ROOT)/scripts/ghostty-dependency-cache.ts \
		$(ROOT)/vendor/ghostty/build.zig.zon.json
	@mkdir -p "$(DEMO_CACHE)"
	@"$(ROOT)/scripts/provision-native-toolchain.sh"
	@touch "$@"

# Catches vendor-tree drift the lock does not record. Runs on every build and
# test, so it stays git-cheap; the byte-level prover lives in the artifact build.
.PHONY: vendor-verify
vendor-verify:
	@set -e; \
	dirty=$$(git -C "$(ROOT)" status --porcelain -- vendor/ghostty); \
	if [ -n "$$dirty" ]; then \
	  echo "make: vendor/ghostty has uncommitted changes; commit them, update native/toolchain-lock.json (ghostty.patchedTree), and prove with scripts/vendor-ghostty.sh verify:" >&2; \
	  printf '%s\n' "$$dirty" | head >&2; exit 1; \
	fi; \
	tree=$$(git -C "$(ROOT)" rev-parse HEAD:vendor/ghostty); \
	locked=$$(/usr/bin/plutil -extract ghostty.patchedTree raw -o - "$(LOCK)"); \
	if [ "$$tree" != "$$locked" ]; then \
	  echo "make: vendor/ghostty tree $$tree does not match lock patchedTree $$locked; run scripts/vendor-ghostty.sh verify" >&2; exit 1; \
	fi

# No mtime prerequisites on purpose: the stamp name is the content key, so a
# fresh worktree reuses the artifact instead of a 25-40 minute rebuild (#46).
$(GHOSTTY_ARTIFACT_STAMP): | toolchain
	@echo "building lock-pinned GhosttyKit"
	@"$(ROOT)/scripts/build-ghosttykit.sh"
	@test -f "$(GHOSTTY_ARTIFACT_INFO)" || { echo "make: GhosttyKit build produced no artifact; rerun 'make build'" >&2; exit 1; }
	@ls "$(GHOSTTY_ARTIFACT)"/GhosttyKit.xcframework/macos-*/lib*.a >/dev/null 2>&1 || { echo "make: GhosttyKit macOS archive is invalid; rerun 'make build'" >&2; exit 1; }
	@test -f "$(GHOSTTY_ARTIFACT)/checkpoint-fixtures/$(UNAME_M)/corpus.hvg6" || { echo "make: GhosttyKit checkpoint corpus is missing; rerun 'make build'" >&2; exit 1; }
	@touch "$@"

# sessiond compiles the engine from vendor/ghostty; the app links this staged
# archive. Nothing structural makes them equal — the lock check is what does, and
# without it a stale artifact stages silently and every pane attach dies.
$(GHOSTTYKIT_INFO): $(GHOSTTY_ARTIFACT_STAMP)
	@"$(ROOT)/scripts/ghostty-artifact-lock-check.sh" "$(GHOSTTY_ARTIFACT)" "$(LOCK)" || { echo "make: cached GhosttyKit artifact does not record the toolchain lock's ghostty source identity; refusing to stage it (rerun 'make build')" >&2; exit 1; }
	@echo "staging lock-pinned GhosttyKit for SwiftPM"
	@/bin/rm -rf "$(GHOSTTYKIT)" "$(ROOT)/workspace/Vendor/checkpoint-fixtures"
	@mkdir -p "$(ROOT)/workspace/Vendor"
	@/usr/bin/ditto "$(GHOSTTY_ARTIFACT)/GhosttyKit.xcframework" "$(GHOSTTYKIT)"
	@/usr/bin/ditto "$(GHOSTTY_ARTIFACT)/checkpoint-fixtures" "$(ROOT)/workspace/Vendor/checkpoint-fixtures"
	@test -f "$@" || { echo "make: GhosttyKit staging failed; rerun 'make build'" >&2; exit 1; }
	@touch "$@"

# Not reached by the four: release builds its own. This is for the attach/smoke
# harness (scripts/b22-live-attach-proof.ts), which builds it by absolute path.
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
		overlay=$$("$(ROOT)/scripts/prepare-zig-xcode-overlay.sh"); \
		cd "$(ROOT)/native/sessiond"; \
		PATH="$(ROOT)/scripts/zig-runner-tools:$$PATH" "$(ZIG)" build install \
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
build: toolchain vendor-verify $(GHOSTTYKIT_INFO) sessiond
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
	mkdir -p "$(DEV_HOME)" "$(DEV)/bin" "$(DEV)/tmp" "$(DEV)/tmux"; \
	cd "$$proj" && env $(DEV_ENV) "$(HIVE_BIN)" init --no-graphify && exec env $(DEV_ENV) "$(HIVE_BIN)"

# No pipes anywhere: a red suite must exit red. The real-CLI e2e suite is already
# inside `bun run test` and self-skips unless HIVE_E2E=1; opting in is
# `HIVE_E2E=1 bun test src/cli/e2e-real.test.ts`, which is what CI runs.
test: toolchain vendor-verify $(GHOSTTYKIT_INFO)
	bun install --frozen-lockfile
	bun run test
	cd workspace && swift test

# Stop the dev instance, then delete every dev artifact — never the second
# without the first (#44). Load-bearing invariants, each easy to break silently:
#   - No kill is trusted: the sweep re-reads the process table and rm -rf runs
#     only on an empty readback; a survivor refuses and exits non-zero.
#   - Select by executable path and argv, never by process name — the user's
#     installed hive runs its own Workspace, tmux server and vendor CLIs.
#   - Three binding axes: executable under .dev/, .dev/ or HIVE_HOME in argv,
#     the dev tmux socket (digest of the literal DEV_HOME string).
#   - Naming is not being: argv only nominates a candidate; exec path, lsof or
#     tmux membership binds it. Mentioners are reported, never signalled.
#   - Three spellings each for .dev and the home (literal, physical, deepest
#     surviving ancestor) so a clean still works once a directory is gone.
#   - Empty derivations refuse instead of defaulting: an empty dev path would
#     prefix-match every absolute path on the machine.
#   - The invoker's whole ancestor chain is excluded, walked to pid 1.
clean:
	@set -e; \
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
	tmux -L "hive-$$suffix" kill-server 2>/dev/null || true; \
	pidfile=""; \
	if [ -f "$$home/daemon.pid" ]; then pidfile="$$home/daemon.pid"; \
	elif [ -f "$$dev/home/daemon.pid" ]; then pidfile="$$dev/home/daemon.pid"; fi; \
	if [ -n "$$pidfile" ]; then \
	  pid=$$(cat "$$pidfile" 2>/dev/null) || true; \
	  [ -n "$$pid" ] || { echo "refusing: daemon.pid exists but could not be read" >&2; exit 1; }; \
	  command=$$(ps -p "$$pid" -o comm= 2>/dev/null || true); \
	  case "$$command" in "$$dev"/*) kill "$$pid" 2>/dev/null || true;; esac; \
	fi; \
	is_mine() { q=$$1; k=0; \
	  while [ $$k -lt 8 ]; do \
	    [ "$$q" = "$$self" ] && return 0; \
	    q=$$(ps -p "$$q" -o ppid= 2>/dev/null | tr -d ' '); \
	    [ -n "$$q" ] || return 0; [ "$$q" = "1" ] && return 1; \
	    k=$$((k + 1)); \
	  done; return 1; }; \
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
	devl="$(DEV)"; \
	devp="$$dev"; d="$$dev"; rest=""; \
	while [ ! -d "$$d" ] && [ "$$d" != "/" ] && [ -n "$$d" ]; do \
	  b=$$(basename "$$d") || true; \
	  [ -n "$$b" ] || { echo "refusing: could not basename a deleted-dev path component" >&2; exit 1; }; \
	  rest="/$$b$$rest"; \
	  d=$$(dirname "$$d") || true; \
	  [ -n "$$d" ] || { echo "refusing: could not walk to a surviving ancestor of the dev path" >&2; exit 1; }; \
	done; \
	if [ -d "$$d" ]; then \
	  base=$$(cd "$$d" && pwd -P) || true; \
	  [ -n "$$base" ] || { echo "refusing: could not resolve the physical dev path" >&2; exit 1; }; \
	  devp="$$base$$rest"; \
	fi; \
	[ -n "$$devp" ] || { echo "refusing: could not resolve the physical dev path" >&2; exit 1; }; \
	homel="$(DEV_HOME)"; \
	homep="$$home"; hd="$$home"; hrest=""; \
	while [ ! -d "$$hd" ] && [ "$$hd" != "/" ] && [ -n "$$hd" ]; do \
	  hb=$$(basename "$$hd") || true; \
	  [ -n "$$hb" ] || { echo "refusing: could not basename a deleted-home path component" >&2; exit 1; }; \
	  hrest="/$$hb$$hrest"; \
	  hd=$$(dirname "$$hd") || true; \
	  [ -n "$$hd" ] || { echo "refusing: could not walk to a surviving ancestor of the dev HIVE_HOME" >&2; exit 1; }; \
	done; \
	if [ -d "$$hd" ]; then \
	  hbase=$$(cd "$$hd" && pwd -P) || true; \
	  [ -n "$$hbase" ] || { echo "refusing: could not resolve the physical dev HIVE_HOME" >&2; exit 1; }; \
	  homep="$$hbase$$hrest"; \
	fi; \
	[ -n "$$homep" ] || { echo "refusing: could not resolve the physical dev HIVE_HOME" >&2; exit 1; }; \
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
	dev_pids() { candidates | while read -r p; do is_bound "$$p" && echo "$$p"; done; :; }; \
	mentioners() { candidates | while read -r p; do is_bound "$$p" || echo "$$p"; done; :; }; \
	pids=$$(dev_pids) || true; \
	named=$$(mentioners) || true; \
	[ -z "$$named" ] || echo "found mentioners, not killing:" $$named; \
	if [ ! -d "$(DEV)" ] && [ ! -d "$$home" ] && [ -z "$$pids" ]; then exit 0; \
	fi; \
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
