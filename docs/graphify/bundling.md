# Graphify bundling

Updated: 2026-07-23
Source: Hive source tree, 2026-07-23

## Summary

Hive uses Graphify to build the local code graph agents consult for repository structure, symbols, and relationships. Hive packages Graphify as a frozen, self-contained bundle it builds, signs, and publishes itself — no uv, Python, or PyPI on a user's machine. `hive init` fetches the bundle from a Hive-owned release tag and refuses bytes whose SHA-256 does not match the constant compiled into the Hive binary.

## Why a bundle at all

Graphify's upstream Python closure spans native parsers and platform-specific packages. Hive freezes that closure itself so repository setup has one Hive-owned origin, one reviewed dependency lock, and one signed artifact per platform.

The bundle closes all three at once: **one origin** (Hive's own releases — the same trust as `hive update`), **one verification** (a hash over the exact published bytes, embedded in a binary the user already trusted), **zero toolchain**. The whole Python question now exists only on Hive's build machines.

It is also not "vendoring," which was and remains rejected: upstream's *source tree* never enters Hive's repo. Upstream's churn reaches a user only when a Hive developer deliberately bumps the pin and ships new artifacts.

There is no venv anywhere. The daemon invokes `$HIVE_HOME/tools/graphify/<pin>/graphify` and `…/graphify-mcp` by absolute path — nothing on `PATH`, and a `graphify` the user installed themselves is neither touched nor trusted. Repo uninstall removes the graph output and Hive-generated `.graphifyignore`; machine uninstall removes the shared runtime. No uv cache, managed Python, or venv exists.

## Freezing survives tree-sitter (this was the gate)

Graphify is the hard case for PyInstaller. It parses code through **26 separate tree-sitter grammar packages**, each carrying a native `_binding.abi3.so`, loaded not by `import` statements but by `importlib.import_module(config.ts_module)` — **invisible to any static analyzer**. A naive freeze misses every grammar and produces a binary that runs and indexes nothing.

Three collection requirements make it work, and all three are non-obvious (`scripts/graphify/graphify.spec`):

1. **Every `tree_sitter_*` package via `collect_all`** — and *discovered from the installed distributions*, not hardcoded, so a pin bump that adds a grammar cannot silently ship a bundle missing it.
2. **`collect_all("graphify")`** — the package ships data files (`skill-*.md`, `always_on/*.md`) beside its code.
3. **`copy_metadata("graphifyy")`** — the tool calls `importlib.metadata.version()` at runtime and dies without its dist-info.

Verified frozen, with the build venv renamed away so nothing could fall back to it: a nine-language fixture extracts byte-identically to the venv baseline, `query` matches, and `graphify-mcp` completes an MCP handshake and returns real graph content over the loopback Streamable HTTP transport the daemon actually uses. Startup 60–70ms frozen vs 30ms venv — noise against a seven-second graph build, irrelevant for a long-running server.

## The busybox dispatcher

Both upstream console scripts matter (`graphify` and `graphify-mcp`), and freezing each separately would ship the ~123 MB library tree **twice**. Instead one EXE fronts a nine-line busybox-style dispatcher (`scripts/graphify/entry.py`): invoked through the `graphify-mcp` symlink it runs the server, otherwise the CLI.

The alternatives lost cleanly: PyInstaller's **MERGE** machinery (fragile and poorly maintained) and **two full bundles** (double the size). The dispatcher's only cost is that the symlink must survive packaging, which tar preserves.

## The one real portability finding: `cryptography>=49`

The x64 build initially failed, and the failure is a first-class fact about the *lock*, not the freeze: **`cryptography` 49.0.0 publishes no macOS x86_64 wheel** — arm64 only. uv falls back to the sdist, whose Rust build then demands an x86_64 OpenSSL to link against; the cross-build dies in `openssl-sys` on an arm64 machine, and even on a real Intel runner it would cost a Rust toolchain and minutes of compile on every build.

The insult: cryptography reaches the closure via pyjwt, in MCP's **auth stack** — a feature Hive never exercises. Graphify's own extraction never touches it. The import graph does not care.

The fix is one constraint, and it lives in a **committed compile input, not in anyone's memory** (`scripts/graphify/graphify.in` pins `cryptography<49`; `graphify.lock` resolves 48.0.1). Versions 46–48 ship `universal2` wheels covering both architectures, so the entire closure installs from wheels on both arches — no Rust, no OpenSSL, no sdist. The diff against the unconstrained lock is exactly one package.

The cost is holding cryptography one major behind until upstream restores Intel wheels or Hive drops the x64 slice. Building it from a hash-pinned sdist on an Intel runner was rejected while a pure-wheel option exists: it adds a Rust toolchain to the build's trusted surface and minutes to every bump, for zero functional gain.

**The general trap:** any future pin can reintroduce this. A package with no x64 wheel and no universal2 escape hatch breaks the slice, and the *remedy* (constrain, patch, or drop x64) is a real decision, not a script. The wheel-coverage gate catches it at bump time — which is exactly when Hive wants to catch it, before it reaches a user.

## Signing: the entitlement reasoning, and a keychain trap

The bundle's entitlement set is **smaller than Hive's own binary needs, and different in kind** (`scripts/graphify/entitlements.plist`):

- **No `allow-jit`.** Hive's own binary needs it for JavaScriptCore. CPython 3.12 has no JIT.
- **`com.apple.security.cs.allow-unsigned-executable-memory`, and nothing else.** libffi writes closure trampolines into memory it then executes, and cffi is in the closure — via cryptography, the same dependency that caused the wheel problem.
- **No `disable-library-validation`**: every dylib in the bundle is signed with the same identity, so library validation passes on its own merits. Turning it off would have been the lazy fix and a real weakening.

The keychain trap, measured: **a login keychain holding two certificates with the same common name makes `codesign` refuse as "ambiguous."** A local signer must pass the identity's SHA-1 hash instead of its name. CI's throwaway keychain holds one certificate and is immune — which is exactly why this bites only on a developer laptop, where it looks like a broken build rather than a keychain question.

Signing is defense in depth here, not a launch gate: the `hive` binary downloads these artifacts without a quarantine xattr, so Gatekeeper may never evaluate them at all.

## Distribution shape

Hive publishes per-platform artifacts on a dedicated, Hive-owned release tag, versioned independently of Hive (`graphify-v0.9.12-hive.1`; the suffix counts Hive rebuilds of the same upstream pin). The Hive binary embeds the tag, asset name, and SHA-256 for each platform. Keeping the ~25 MB bundle separate lets Hive and Graphify move on their own release cadences without making every `hive update` download unchanged Graphify bytes.

`hive init` downloads the matching artifact and builds the repository graph. If setup is offline or interrupted, Hive reports the degraded graph state and `hive graphify enable` completes the same provisioning path. The Hive release workflow verifies every registry asset before publishing.

## Linux facts (for when the matrix grows)

Hive ships two darwin slices today and `install.sh` refuses non-Darwin machines outright, so there is no Linux Hive to regress. Both Linux slices were nonetheless built and fully smoke-tested (same lock, same spec, same dispatcher), because "would this survive a Linux Hive" is exactly the claim that looks obvious until tree-sitter is involved. Two facts a future pipeline needs:

- **PyInstaller on Linux hard-requires `objdump` (binutils)** — the freeze aborts without it. Measured, not inferred.
- **The frozen binary inherits the build image's glibc as its floor.** The measuring image (Debian 13 / glibc 2.41) is fine for a spike and far too new to ship from; a real build uses the oldest supported base or a manylinux image.

## Honest risks

- **Hive owns the whole runtime.** Every Graphify crash on a user machine is Hive's artifact misbehaving, and fixing one means shipping new artifacts. The degradation rule contains the failure: a broken bundle becomes an honestly reported graphless state while the rest of Hive continues.
- **Emulation-tested is not bare-metal-tested.** darwin-x64 was measured under Rosetta 2; both arm64 slices ran native. Converting it to measured is one CI job on `macos-15-intel`.
- **The bundle is fat and mostly not graphify.** Verilog's grammar alone is 18 MB; numpy 7 MB; the MCP auth stack drags in cryptography for a feature Hive never uses. All of it is upstream's dependency graph, pinned as-is on purpose — trimming forks Hive's closure away from the one upstream tests. Not worth it at 25 MB; revisit if the artifact ever triples.
- **The bump review now covers three pins, not one** (graphify, the interpreter, PyInstaller). PyInstaller is version-pinned but not hash-pinned.

## See Also

- [Integration](integration.md) — provisioning, degradation, and how Hive uses the bundle's binaries
