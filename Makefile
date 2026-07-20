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
# daemon port/pid, sqlite db, project registry) derives from HIVE_HOME, which
# make run points at .dev/home. HIVE_INSTALL_ROOT points at the staged dev
# root so the dev CLI launches the dev-built HiveWorkspace.app, never the
# installed one. Nothing here reads or writes ~/.hive, ~/.local/share/hive,
# or ~/.local/bin/hive.

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

# Stop the dev instance, then delete every dev artifact — and never the second
# without the first. Deleting .dev/ out from under a live app was the defect
# (#44): the Workspace is launched through `open -n`, so it is nobody's child
# here and no signal ever reached it, and the two targeted kills below are
# best-effort by nature, so a miss was undetectable.
#
# The fix is not a louder kill. Nothing here trusts a kill: the sweep re-reads
# the process table afterwards, and `rm -rf` runs only if that readback is
# empty. A survivor refuses the delete and exits non-zero, because reporting
# success over a live process is what made this silent for so long.
#
# Selection is by PATH and ARGUMENTS, never by process name. The user's
# installed instance runs its own Workspace, its own tmux server and its own
# vendor CLI children; matching "HiveWorkspace" or "tmux" would kill those.
# Three axes are needed because dev processes are bound to .dev/ three
# different ways:
#
#   1. executable under .dev/     — the Workspace app, staged dev binaries
#   2. .dev/ path in arguments    — the tmux server and vendor children, whose
#                                   executables are system tmux and ~/.local/bin
#   3. dev tmux socket in args    — dev agents' `tmux attach-session`, which
#                                   names no path at all, only the socket
#
# A clean must also work when .dev/ is ALREADY GONE. That is not a hypothetical:
# it is exactly what a half-finished clean leaves behind — the directory deleted
# and the processes still running — so guarding on `[ -d .dev ]` made the target
# useless in the one state that most needs it. The guard is now "the directory
# exists OR the sweep finds processes bound to its path".
#
# Which forces the socket digest to stop depending on the directory. It used to
# hash `cd .dev/home && pwd -P`; with home deleted that cd fails, the digest is
# taken over an EMPTY string, and axis 3 goes dark exactly when the orphan it
# should catch is a tmux server whose home no longer exists. Hashing the literal
# path string has no such dependency, and it is not a guess: measured against a
# real orphaned dev server whose .dev/home had already been deleted, the literal
# digest reproduced its live socket name exactly, while the cd form could not be
# computed at all.
#
# Every refusal below is deliberate. An empty path or an empty digest must STOP
# the target, never let it proceed or quietly exit 0 — an empty `dev` would make
# the axis-1 prefix `/*`, which matches every absolute path on the machine.
#
# NAMING THE DEV INSTANCE IS NOT BEING IT. Argv matching alone cannot tell a
# process BOUND to this instance from one that merely mentions it — an editor,
# a grep, a log tail, or the very shell that invoked `make clean DEV=<path>`.
# That is not hypothetical: the first real-world run of this target killed its
# own invoking shell (observed; exit 144 and a sweep line naming a pid that was
# neither orphan — the precise match reason remains unproven).
#
# So argv only nominates a CANDIDATE. Killing requires binding evidence that
# outlives the directory:
#   - executable under the dev path
#   - cwd (or an open file) under the dev path, per lsof
#   - being the tmux server for the dev socket, or one of its clients, which
#     tmux answers authoritatively by pid — no argv involved
# Anything else is a mentioner: reported, never signalled.
#
# That the evidence outlives deletion is measured, not assumed: a process whose
# cwd was under a .dev still reported that exact path via lsof AFTER the .dev
# was rm -rf'd, because the kernel holds the vnode. Without that, requiring
# binding evidence would have un-fixed the orphan case above, where .dev is
# gone by definition.
#
# The invoking process's whole ancestor chain is excluded too. `is_mine` walks
# ppid UPWARD from a candidate, so it can recognise self and descendants but an
# ancestor can never reach self and would otherwise stay eligible.
#
# WHY SPARING IS PREFERRED, STATED HONESTLY. An earlier version of this comment
# claimed a wrong exclusion "fails safe" because the survivor readback would
# find the process alive and refuse the delete. THAT IS FALSE, and it was
# disproved by probe rather than argument: the readback calls the same
# dev_pids, so it applies the same classification. A process wrongly judged a
# mentioner is invisible to the readback too — it never appears in `alive`,
# clean exits 0, and .dev is deleted out from under it.
#
# So both errors are real harms and the choice between them is a judgement, not
# a free lunch:
#   wrong INCLUSION -> a bystander is killed. Immediate, unrecoverable, and it
#     can reach the user's installed instance or another agent's work.
#   wrong EXCLUSION -> a genuine dev process is STRANDED against a deleted .dev
#     and keeps running. Recoverable (it can be killed by hand) but silent
#     unless something says so.
# We prefer stranding to killing, because the blast radius of a wrong kill is
# unbounded while a stranded process is inert and fixable. The `found
# mentioners, not killing:` line is what keeps the stranding from being silent,
# and it is therefore load-bearing, not decoration — it is the ONLY signal that
# a spared process may have needed reaping.
clean:
	@set -e; \
	if [ -d "$(DEV)" ]; then dev=$$(cd "$(DEV)" && pwd -P); else dev="$(DEV)"; fi; \
	[ -n "$$dev" ] || { echo "refusing: could not determine the dev directory path" >&2; exit 1; }; \
	case "$$dev" in /*) ;; *) echo "refusing: dev path is not absolute ($$dev)" >&2; exit 1;; esac; \
	self=$$$$; \
	suffix=$$(printf '%s' "$$dev/home" | /usr/bin/shasum -a 256 | cut -c1-10); \
	[ -n "$$suffix" ] || { echo "refusing: could not derive the dev tmux socket name" >&2; exit 1; }; \
	TMUX_TMPDIR="$$dev/tmux" tmux -L "hive-$$suffix" kill-server 2>/dev/null || true; \
	if [ -f "$(DEV)/home/daemon.pid" ]; then \
	  pid=$$(cat "$(DEV)/home/daemon.pid"); \
	  command=$$(ps -p "$$pid" -o comm= 2>/dev/null || true); \
	  case "$$command" in "$$dev"/*) kill "$$pid" 2>/dev/null || true;; esac; \
	fi; \
	is_mine() { q=$$1; k=0; \
	  : "a pid whose ancestry cannot be resolved has already exited — the sweep\
	     spawns short-lived subshells that inherit this recipe's command line\
	     and so match by args; gone is not a survivor"; \
	  while [ $$k -lt 8 ]; do \
	    [ "$$q" = "$$self" ] && return 0; \
	    q=$$(ps -p "$$q" -o ppid= 2>/dev/null | tr -d ' '); \
	    [ -n "$$q" ] || return 0; [ "$$q" = "1" ] && return 1; \
	    k=$$((k + 1)); \
	  done; return 1; }; \
	: "the WHOLE chain, terminating on pid 1 / pid 0 / an unresolvable parent —\
	   not an arbitrary depth. A cap that is silently exceeded leaves real\
	   ancestors eligible to be killed, which is the defect this exclusion\
	   exists to prevent. The 4096 bound is a cycle backstop, not a depth\
	   policy: no process tree reaches it, so hitting it means the walk is not\
	   terminating and the honest response is to REFUSE rather than proceed\
	   with an ancestor set known to be incomplete"; \
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
	: "lsof reports PHYSICAL paths, and a deleted .dev cannot be resolved with\
	   pwd -P. On macOS /tmp is a symlink to /private/tmp, so the literal path\
	   never matches what lsof prints and every cwd-bound orphan was misread as\
	   a mere mentioner. Resolve the deepest ancestor that still exists and\
	   re-attach the deleted remainder, then match on either spelling"; \
	: "three spellings can all name the same directory and each shows up in a\
	   different place: devl is exactly what the caller typed and is what argv\
	   carries; dev is that after pwd -P when it exists; devp resolves the\
	   deepest surviving ancestor so a DELETED dir still compares against the\
	   physical path lsof prints. Match all three everywhere or a process is\
	   missed by whichever spelling the check happens not to hold"; \
	devl="$(DEV)"; \
	devp="$$dev"; d="$$dev"; rest=""; \
	while [ ! -d "$$d" ] && [ "$$d" != "/" ] && [ -n "$$d" ]; do \
	  rest="/$$(basename "$$d")$$rest"; d=$$(dirname "$$d"); \
	done; \
	[ -d "$$d" ] && devp="$$(cd "$$d" && pwd -P)$$rest"; \
	: "EVERY descriptor, not just cwd. An earlier version passed -d cwd here,\
	   which silently narrowed this to the working directory while the comment\
	   above promised 'cwd or an open file' — measured: a process holding a\
	   dev file on fd 3 was classified a mentioner, spared, and then had .dev\
	   deleted out from under it. A held fd is binding evidence exactly as a\
	   cwd is, and lsof keeps reporting both after the file is unlinked"; \
	: "PATHS ARE NOT PATTERNS, AND PREFIXES ARE NOT COMPONENTS. This used to pipe\
	   lsof into a grep anchored on the raw path, which had two ways to kill the\
	   wrong thing:\
	   the path was interpreted as a REGEX, so a '.' matched any character; and\
	   there was no component boundary, so a sibling directory named .dev-other\
	   matched .dev and its holder was killed. Measured, not theorised — the\
	   probe that found it killed a bystander whose only real fd was under\
	   .dev-other. Matching is now literal and component-wise: a name binds only\
	   if it EQUALS a spelling or begins with that spelling plus '/'. The case\
	   patterns quote the variable, which makes any glob character inside the\
	   path literal, so a path containing * or ? cannot widen the match either"; \
	is_bound() { \
	  case "$$(ps -p "$$1" -o comm= 2>/dev/null)" in \
	    "$$dev"/*|"$$devp"/*|"$$devl"/*) return 0;; esac; \
	  : "awk, not shell, for this scan: index(p,d\"/\")==1 is a LITERAL\
	     prefix test with a component boundary — no regex, so a '.' in the path\
	     cannot match any character, and no bare-prefix match, so a sibling\
	     .dev-other cannot pass as .dev. A shell while-read pipeline that broke\
	     early on a match wedged here instead, so this is also the version that\
	     terminates"; \
	  if lsof -n -P -a -p "$$1" -Fn 2>/dev/null \
	    | awk -v d="$$dev" -v dp="$$devp" -v dl="$$devl" ' \
	        /^n/ { p = substr($$0, 2); \
	               if (p == d  || index(p, d  "/") == 1) { found = 1; exit } \
	               if (p == dp || index(p, dp "/") == 1) { found = 1; exit } \
	               if (p == dl || index(p, dl "/") == 1) { found = 1; exit } } \
	        END { exit(found ? 0 : 1) }'; then return 0; fi; \
	  case "$$tmuxpids " in *" $$1 "*) return 0;; esac; \
	  return 1; }; \
	: "BOTH spellings here too, not just in is_bound. argv carries whatever the\
	   caller typed — usually the unresolved /tmp/... — while dev has been\
	   through pwd -P into /private/tmp/... Matching only the resolved form\
	   meant a process naming the symlinked path was never even NOMINATED, so\
	   is_bound never ran and no amount of binding evidence could save it"; \
	candidates() { \
	  { ps -axo pid=,comm= | while read -r p c; do \
	      case "$$c" in "$$dev"/*|"$$devp"/*|"$$devl"/*) echo "$$p";; esac; done; \
	    ps -axo pid=,command= | while read -r p rest; do \
	      case "$$rest" in *"$$dev"/*|*"$$devp"/*|*"$$devl"/*) echo "$$p";; esac; done; \
	    ps -axo pid=,command= | while read -r p rest; do \
	      case "$$rest" in *"hive-$$suffix"*) echo "$$p";; esac; done; \
	    printf '%s\n' $$tmuxpids; \
	  } | sort -u | while read -r p; do \
	    [ -n "$$p" ] || continue; excluded "$$p" || echo "$$p"; done; }; \
	: "these are FILTERS: a final candidate that does not match leaves the loop\
	   with a non-zero status, which under set -e would abort the whole target.\
	   'the last item was not selected' is not a failure, so both end with ':'"; \
	: "the trailing ':' below does NOT make these safe under errexit and must not\
	   be trusted as a guard: set -e reaches inside the command substitution and\
	   aborts at the failing classification, so the ':' never runs. EVERY call\
	   site therefore needs its own '|| true'. Measured the hard way — the\
	   readback assignment lacked one, so a run whose last surviving candidate\
	   was a mentioner aborted with exit 2 and preserved .dev after correctly\
	   killing the bound process"; \
	dev_pids() { candidates | while read -r p; do is_bound "$$p" && echo "$$p"; done; :; }; \
	mentioners() { candidates | while read -r p; do is_bound "$$p" || echo "$$p"; done; :; }; \
	: "set -e reaches inside these command substitutions, so ANY untested failure\
	   in the classification helpers (a gone pid, an lsof miss) would abort the\
	   whole target silently — observed: with a bystander present the recipe\
	   exited 1 having printed nothing at all. An empty result is a legitimate\
	   answer here and is handled explicitly below, so the substitutions are\
	   allowed to fail and the emptiness is what gets acted on"; \
	pids=$$(dev_pids) || true; \
	named=$$(mentioners) || true; \
	[ -z "$$named" ] || echo "found mentioners, not killing:" $$named; \
	if [ ! -d "$(DEV)" ] && [ -z "$$pids" ]; then exit 0; \
	fi; \
	: "reaching here with no directory means the sweep found processes, and an\
	   empty sweep is trustworthy only because every derivation it depends on\
	   refused above rather than defaulting"; \
	if [ -n "$$pids" ]; then \
	  echo "stopping dev processes:" $$pids; \
	  for p in $$pids; do kill "$$p" 2>/dev/null || true; done; \
	  alive=""; \
	  i=0; while [ $$i -lt 20 ]; do \
	    alive=$$(dev_pids) || true; [ -n "$$alive" ] || break; sleep 0.5; i=$$((i + 1)); \
	  done; \
	  if [ -n "$$alive" ]; then \
	    echo "refusing to delete $(DEV): still running:" $$alive >&2; \
	    echo "they run from files under $(DEV); deleting it would strand them" >&2; \
	    exit 1; \
	  fi; \
	  echo "all dev processes confirmed stopped"; \
	fi; \
	rm -rf "$(DEV)"

cleanup: clean

# Also drop the expensive native caches (pinned Zig, Ghostty artifacts) and
# intermediate build state. The next make build re-provisions from scratch.
deepclean: clean
	rm -rf "$(ROOT)/.cache/native" "$(GHOSTTYKIT)" \
	  "$(ROOT)/workspace/.build" "$(ROOT)/.zig-cache" \
	  "$(ROOT)/native/sessiond/zig-out" "$(ROOT)/native/sessiond/.zig-cache"
