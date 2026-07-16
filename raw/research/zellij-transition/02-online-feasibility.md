# Online feasibility: bundled Zellij terminal stack

Checked: 2026-07-15 (America/New_York)

Scope: the online half of the spike, limited to hypotheses H1-H5, prototype
scope items 1-2, the research anchors, and the go/no-go rules. All version,
flag, API, issue, and behavior claims below were checked against linked vendor
documentation, tagged source, release metadata, or vendor issue trackers. Issue
reports are evidence of current risk, not independent reproductions by this
research pass.

## Decision

**No-go for the proposed full production migration without architecture changes.**

The Unix prototype is worth continuing, but the current public evidence trips
two of the spike's explicit no-go conditions:

1. Zellij 0.44.3 has a detailed native-Windows reproducer in which multiline
   bracketed-paste input is delivered in reverse line order. This directly
   conflicts with the safe automated-input requirement
   ([zellij#5333](https://github.com/zellij-org/zellij/issues/5333)).
2. Zellij exposes private socket, config, layout, and plugin-data locations, but
   no cache-directory override. On Windows its pinned directory library derives
   cache storage from `FOLDERID_LocalAppData`, not an application-specific
   environment override. A stock bundled build therefore cannot guarantee that
   its cache is isolated from a user-installed Zellij running as the same OS
   user ([Zellij cache constants](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/src/consts.rs),
   [`directories` 5.0.1 paths](https://docs.rs/directories/5.0.1/directories/struct.ProjectDirs.html)).

The strongest replacement design is a small, persistent Hive session daemon
that owns every PTY and is the only writer. Electron renderers reconnect to it;
human input and automation enter the same ordered input queue. Zellij can remain
an optional Unix durability layer behind the daemon while native Windows uses
the daemon's direct ConPTY. This follows VS Code's process-reconnection model
and Wave's remote job-manager model while avoiding a second input path through a
Zellij plugin.

## Hypothesis verdicts

| Hypothesis | Verdict | Current public evidence |
| --- | --- | --- |
| H1 — invisible Zellij substrate | **At-risk** | An empty `clear-defaults` key map, a borderless one-pane layout, disabled frames/mouse/background plugins, and CLI lifecycle actions can remove visible UI and Zellij shortcuts. However, fully private cache placement is not configurable, Windows rename/attach is broken, and recent detach/reattach reports affect a vendor CLI. |
| H2 — xterm.js + node-pty fidelity | **At-risk** | xterm.js 6.0.0 supports the central VT features, IME, SGR mouse, bracketed paste, OSC 8, and OSC 52 through its clipboard addon. Its SGR table is still partial, the grapheme addon is explicitly experimental, resize/reflow remains a cross-layer behavior, and current Zellij issues cover alternate-screen capture, mouse modifiers, CJK redraw, and double-width emoji. |
| H3 — Electron-owned layout and resize | **Supported** | DOM/CSS layout is independent of PTY layout; `FitAddon` and xterm.js's resize API expose the required rows/columns, and xterm.js explicitly recommends debouncing resize before notifying the PTY. Acceptance still requires the spike's animation fixture. |
| H4 — single-writer draft protection | **At-risk** | The stack does not supply this policy. It is feasible only if Hive places human and automated input behind one authority. Sending human bytes through the attached node-pty while a WASM plugin writes automation creates two writers and cannot establish the required total order. |
| H5 — same native-Windows architecture | **Refuted** | Native ConPTY support first shipped in 0.44.0, but 0.44.3 still has open, directly relevant input and lifecycle defects. Official 0.44.3 release assets also provide Windows x64 only, not Windows ARM64. |

## 1. Zellij as an invisible, private substrate

### Version and cadence

Pin **Zellij v0.44.3**, the current latest stable release, by exact archive and
published SHA-256, not by a floating download URL. It was released 2026-05-13
and fixes regressions in 0.44.2 involving stalled stdin, blocked popup panes,
and mouse-plus-key control characters
([v0.44.3 release](https://github.com/zellij-org/zellij/releases/tag/v0.44.3)).

The tagged changelog gives this recent cadence:

| Version | Date |
| --- | --- |
| 0.43.1 | 2025-08-08 |
| 0.44.0 | 2026-03-23 |
| 0.44.1 | 2026-04-07 |
| 0.44.2 | 2026-05-05 |
| 0.44.3 | 2026-05-13 |

That is an irregular feature cadence followed by four releases in about seven
weeks, including regression fixes. Budget for a pinned-version qualification
suite and deliberate upgrades, not automatic patch uptake
([tagged changelog](https://github.com/zellij-org/zellij/blob/v0.44.3/CHANGELOG.md)).

### Minimal no-UI configuration

Use a standalone file, not a generated edit of the user's config:

```kdl
keybinds clear-defaults=true {
}

load_plugins {
}

pane_frames false
auto_layout false
mouse_mode false
copy_on_select false
advanced_mouse_actions false
mouse_hover_effects false
session_serialization false
serialize_pane_viewport false
web_server false
web_sharing "disabled"
show_release_notes false
```

Use a separate, absolute-path layout containing exactly one terminal pane:

```kdl
layout {
    pane borderless=true {
        command "/absolute/path/to/vendor-cli"
        args "..."
    }
}
```

Why every material line is present:

- `keybinds clear-defaults=true {}` is the documented way to discard the
  built-in bindings. An empty body leaves no Zellij-owned keyboard shortcut
  ([keybinding configuration](https://zellij.dev/documentation/keybindings-binding.html)).
- `pane_frames false` plus `borderless=true` removes pane borders. The layout
  deliberately contains no `tab-bar`, `status-bar`, `compact-bar`, or other
  plugin pane. Those bars are ordinary panes explicitly added by the stock
  layouts; `simplified_ui` only changes glyph styling and does not hide them
  ([creating a layout](https://zellij.dev/documentation/creating-a-layout.html),
  [options](https://zellij.dev/documentation/options.html)).
- `load_plugins {}` is necessary. The 0.44.3 default config starts the
  `zellij:link` background plugin, and tagged parsing source shows that an
  explicitly present `load_plugins` block replaces the default set
  ([default config](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/assets/config/default.kdl),
  [KDL parser](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/src/kdl/mod.rs)).
- Disabling Zellij mouse handling, selection copy, and advanced mouse actions
  avoids a hidden second consumer for mouse gestures intended for a vendor TUI.
  This needs an SGR-mouse fixture because it trades away Zellij scroll/select
  behavior intentionally.
- Disabling auto-layout, serialization, the web server, web sharing, and
  release notes removes implicit layout changes, cache-backed resurrection, and
  surprise UI/network surfaces. Live-session persistence still comes from the
  Zellij server remaining alive.

Launch with the bundled absolute binary and an absolute layout/config, for
example `zellij --config <private>/config/config.kdl --config-dir
<private>/config --data-dir <private>/data --layout
<private>/layouts/hive.kdl attach --create <opaque-session-id>`. Do not put a
vendor prompt in the session name or any argument.

The official configuration search order honors `--config-dir`, then
`ZELLIJ_CONFIG_DIR`, then user and platform defaults; `--config` or
`ZELLIJ_CONFIG_FILE` names the file directly
([configuration](https://zellij.dev/documentation/configuration.html)). The
absolute flags should be authoritative even when the environment variables are
also set defensively.

### Isolation matrix

| State | Supported control in 0.44.3 | Recommendation |
| --- | --- | --- |
| Server socket/runtime | `ZELLIJ_SOCKET_DIR` | Set to a short, mode-0700 Hive directory. Zellij appends its contract-version directory. Keep Unix paths comfortably below the source's 104-byte macOS/108-byte Linux socket limits. |
| Config | `--config`, `--config-dir`; `ZELLIJ_CONFIG_FILE`, `ZELLIJ_CONFIG_DIR` | Set both absolute flags; point the environment variables at the same private tree so child CLI actions inherit it. |
| Layouts | `ZELLIJ_LAYOUT_DIR` and the absolute `--layout` path | Use an immutable bundled layout or a per-session generated layout containing no plugin panes. |
| Plugin data | global `--data-dir` | Set an absolute private directory. This is not the cache directory. |
| Temporary files/logs | platform temp directory (`TMPDIR` on Unix; `TEMP`/`TMP` on Windows) | Give the Zellij server a private temp root and restore the normal values inside the vendor pane if required. |
| Cache, permissions, session metadata, plugin artifacts | **No Zellij flag or environment variable**; `ProjectDirs::cache_dir()` | Linux: private `XDG_CACHE_HOME`. macOS: private server `HOME`. Windows: no documented same-user environment override because `FOLDERID_LocalAppData` is used. |

The authoritative names and path construction are visible in the tagged
[`consts.rs`](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/src/consts.rs),
[`envs.rs`](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/src/envs.rs),
[`cli.rs`](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/src/cli.rs),
and platform home modules
([Unix](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/src/home.rs),
[Windows](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-utils/src/home_windows.rs)).

For Linux, launch the server with private `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, and `XDG_RUNTIME_DIR`, in addition to the explicit Zellij
controls. For macOS, launch it with a private `HOME` so `~/Library/Caches` is
private. In either case, restore the user's real `HOME`/XDG values inside the
one vendor pane through the layout/config `env` block; otherwise shell startup
and vendor configuration will accidentally use the isolation home.

For Windows, setting `APPDATA` or `LOCALAPPDATA` is not enough evidence:
`directories` documents Windows cache as `FOLDERID_LocalAppData`, obtained via
the Known Folder API. The production choices are therefore:

1. add/upstream a Zellij `--cache-dir` override and bundle that audited build;
2. run Zellij under a separate OS profile; or
3. accept shared cache state and fail the stated “user-installed Zellij can
   never interfere” requirement.

Option 1 is the smallest credible fix. The top-level MIT license permits the
patch, but Hive then owns rebases, builds, notices, and provenance.

### Lifecycle surface

The CLI exposes attach/create, detach, kill/list sessions, resize,
`list-panes --json`, `dump-screen`, and input actions
([CLI actions](https://zellij.dev/documentation/cli-actions.html)). These cover
prototype scope items 1-2, but two cautions matter:

- `dump-screen` is a screen snapshot, not a structured control protocol. An
  open issue reports stale alternate-screen rows after resize
  ([zellij#5311](https://github.com/zellij-org/zellij/issues/5311)).
- A current report says a Codex CLI pane stops accepting keyboard input after
  detach/reattach. The report is on Ubuntu, not native Windows, but it targets
  the exact vendor/lifecycle path Hive needs
  ([zellij#5365](https://github.com/zellij-org/zellij/issues/5365)).

## 2. Safe automated input of large multiline payloads

### CLI actions are not safe for prompt content

`zellij action write` accepts decimal byte values in arguments;
`write-chars` and `paste` accept text in arguments. They therefore expose
prompt content through process arguments and are subject to OS argument-size
limits. None is acceptable for a secret or a payload of at least 1 MiB
([CLI `write`, `write-chars`, and `paste`](https://zellij.dev/documentation/cli-actions.html)).

### The plugin pipe is stdin-safe, but text-framed

`zellij pipe` without an inline payload listens on stdin and forwards multiple
messages to a plugin with flow control. The receiving `PipeMessage` contains an
optional string payload plus name/args/source/private metadata
([plugin pipes](https://zellij.dev/documentation/plugin-pipes.html),
[CLI-to-plugin pipe](https://zellij.dev/documentation/zellij-plugin-and-pipe.html)).

A WASM plugin can call:

- `write(Vec<u8>)` for the focused pane;
- `write_to_pane_id(Vec<u8>, PaneId)` for an explicit pane;
- string equivalents `write_chars*`.

Those calls require the `WriteToStdin` permission
([plugin API commands](https://zellij.dev/documentation/plugin-api-commands.html),
[plugin permissions](https://zellij.dev/documentation/plugin-api-permissions.html)).
Thus a small bundled plugin can receive stdin-delivered chunks and write decoded
bytes to the sole terminal pane without placing the prompt in argv.

Important limits:

- The documented pipe payload is serializable text (`String`), not an arbitrary
  binary stream. Binary/control-rich payloads need a framed encoding such as
  base64, reassembly, an explicit end marker, size limits, and integrity checks.
- Pre-authorize exactly `WriteToStdin` in Hive's isolated permission cache. A
  first-use permission dialog would violate invisibility.
- Use `write_to_pane_id`, never “focused pane.”
- No public contract promises that a 1 MiB logical message is atomic. Chunking
  and reassembly belong in Hive/plugin protocol tests.
- Native Windows currently reverses multiline bracketed-paste lines even for a
  direct `zellij action write` reproducer, so the fact that the transport avoids
  argv does not make current Windows delivery safe
  ([zellij#5333](https://github.com/zellij-org/zellij/issues/5333)).

### Better input path

The plugin bridge is unnecessary when a persistent Hive process owns the active
node-pty attachment. `node-pty` accepts `write(string | Buffer)`, so both
renderer `onData` and automation can feed one Hive queue and one PTY handle
without prompt content in argv
([node-pty 1.1.0 API](https://github.com/microsoft/node-pty/blob/v1.1.0/typings/node-pty.d.ts)).

That design is also the only clean way to satisfy H4. If human keys go through
the attached PTY while automation goes through a plugin, Zellij receives two
independent writers. Hive cannot prove byte order or uphold a latched human
draft across them. Put both sources behind a daemon state machine:

```text
xterm onData ─┐
              ├─> session daemon / draft arbiter ─> one node-pty.write()
automation ───┘
```

The arbiter must latch human ownership with no timer, queue automation, and
release only on explicit submit/cancel/transfer or terminal-state evidence. A
bracketed-paste transaction should be emitted as one ordered queue item after
the application has enabled mode 2004; the ≥1 MiB test must apply backpressure
rather than split writes concurrently.

## 3. Native Windows and ConPTY

Zellij called v0.44.0 its first native Windows release. Its Windows server uses
ConPTY directly, and v0.44.1 fixed several Windows, CJK IME, Codex scrollback,
and OSC 52 problems
([v0.44.0](https://github.com/zellij-org/zellij/releases/tag/v0.44.0),
[v0.44.1](https://github.com/zellij-org/zellij/releases/tag/v0.44.1),
[tagged Windows backend](https://github.com/zellij-org/zellij/blob/v0.44.3/zellij-server/src/os_input_output_windows.rs)).
That establishes implementation, not maturity.

Open issues checked 2026-07-15 include:

| Issue | Why it matters to Hive |
| --- | --- |
| [#5333](https://github.com/zellij-org/zellij/issues/5333) — multiline bracketed paste reversed | Reproduced on 0.44.3 and main by the reporter; directly violates safe ordered automation. |
| [#4998](https://github.com/zellij-org/zellij/issues/4998) — cannot attach after rename | The marker file is renamed but the Windows named pipe is not; attach/kill can fail or hang. Hive can avoid rename, but lifecycle parity is false. |
| [#5017](https://github.com/zellij-org/zellij/issues/5017) — Ctrl combinations emit CSI-u text in Windows Terminal 1.25+ | A vendor TUI can receive visible garbage instead of control keys. |
| [#5009](https://github.com/zellij-org/zellij/issues/5009) — dead Windows session | Reports a PTY-stream panic/dead session. It has little reproduction detail, so treat it as weaker corroboration, not a decisive defect. |

Cross-platform open issues add relevant fidelity risk:

- detach/reattach stops input to Codex CLI
  ([#5365](https://github.com/zellij-org/zellij/issues/5365));
- `dump-screen` retains stale alternate-screen rows after resize
  ([#5311](https://github.com/zellij-org/zellij/issues/5311));
- mouse scroll modifiers are forwarded incorrectly
  ([#5306](https://github.com/zellij-org/zellij/issues/5306));
- CJK backgrounds split on incremental redraw
  ([#5091](https://github.com/zellij-org/zellij/issues/5091)); and
- double-wide emoji render incorrectly
  ([#5036](https://github.com/zellij-org/zellij/issues/5036)).

The v0.44.3 release manifest has macOS and Linux x64/ARM64 artifacts but only
`x86_64-pc-windows-msvc` for Windows. Native Windows ARM64 therefore has no
official Zellij binary to pin, even though Electron and node-pty publish that
architecture
([v0.44.3 release assets](https://api.github.com/repos/zellij-org/zellij/releases/tags/v0.44.3)).

Conclusion: H5 is refuted for 0.44.x. Gate any future reconsideration on fixed
releases plus the exact Windows ConPTY fixture: launch, 1 MiB multiline paste,
Ctrl/Alt/AltGr, IME, mouse, resize storms, detach/reattach, capture, terminate,
and recovery after an Electron renderer/main-process crash.

## 4. xterm.js fidelity

Pin **xterm.js 6.0.0**, released 2025-12-22. The release added OSC 52 and
synchronized-output support and included IME and alternate-buffer/resize fixes
([6.0.0 release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)).

| Requirement | Current evidence and policy |
| --- | --- |
| IME composition | Core xterm.js has a `CompositionHelper` for composition start/update/end and final-data forwarding; no addon is required. The code contains browser/IME-specific paths, and 6.0.0 fixed duplicate IME input, so Electron CJK fixtures remain mandatory ([tagged helper](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/input/CompositionHelper.ts)). |
| SGR mouse | Core supports DEC modes 9/1000/1002/1003, SGR coordinates (1006), and SGR pixels (1016). Zellij mouse handling must remain off so it does not arbitrate gestures ([VT features](https://xtermjs.org/docs/api/vtfeatures/)). |
| Bracketed paste | Core supports DEC mode 2004. Use xterm's paste path or deliberately wrap an arbiter transaction only when the child enabled the mode; do not emulate paste by appending Enter ([VT features](https://xtermjs.org/docs/api/vtfeatures/)). |
| Unicode/graphemes | Core's width provider is not enough for modern clusters. `@xterm/addon-unicode11` supplies Unicode 11 widths; `@xterm/addon-unicode-graphemes` supplies clustering but its own README calls it experimental and warns of non-standard behavior. Only one width provider should be active, so Hive must choose and test a vendor corpus ([Unicode 11 addon](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-unicode11), [grapheme addon](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-unicode-graphemes)). |
| Colors/SGR | 256-color/RGB and modern underline forms are supported, but the official table labels SGR overall partial and does not support blink SGR 5/6. A vendor depending on blink or an unlisted attribute fails fidelity ([VT features](https://xtermjs.org/docs/api/vtfeatures/)). |
| OSC 8 hyperlinks | Core supports OSC 8. `linkHandler` defaults to a confirmation flow and must strongly sanitize URIs. Implement an allowlisted Electron main-process opener; the WebLinks addon is only for detecting plaintext URLs and is not required for OSC 8 ([terminal options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)). |
| OSC 52 clipboard | In 6.0.0 this is implemented by `@xterm/addon-clipboard`. Its browser provider can read and write `navigator.clipboard`; do not expose that default to an untrusted TUI. Supply a custom provider that denies reads, caps payload size, and allows writes only under explicit product/user policy ([tagged clipboard addon](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-clipboard/src/ClipboardAddon.ts)). |
| Resize | `@xterm/addon-fit` computes rows/columns; xterm's API says resize should be debounced before informing the PTY. After layout settles, fit/resize xterm, then call `nodePty.resize(cols, rows)`, coalescing duplicate geometry ([Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/), [FitAddon](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-fit)). |

Required/conditional addons:

- **Required:** `@xterm/addon-fit`.
- **Required if vendor fixtures need modern clusters:**
  `@xterm/addon-unicode-graphemes`, accepting its experimental status; otherwise
  `addon-unicode11` with a documented grapheme limitation.
- **Conditional:** `@xterm/addon-clipboard` with a Hive provider for OSC 52.
- **Recommended with fallback:** `@xterm/addon-webgl`; handle context loss by
  disposing it and falling back to the DOM renderer
  ([WebGL addon](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-webgl)).
- **Not required:** AttachAddon for a narrow Electron IPC transport; WebLinks
  for OSC 8; SerializeAddon for live process persistence. SerializeAddon can
  checkpoint display state but cannot keep a process alive.

Sustained output also needs explicit flow control. `node-pty` offers
`pause`/`resume` and an experimental XON/XOFF handler, while xterm 6 exposes
`onWriteParsed`. The session daemon should bound its renderer queue, pause PTY
reads at a high-water mark, and resume after xterm consumption. Never allow an
unbounded Electron IPC queue
([node-pty flow control](https://github.com/microsoft/node-pty#flow-control),
[xterm 6.0.0 release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)).

## 5. node-pty inside Electron

Pin **node-pty 1.1.0**, the latest stable release, published 2025-12-22.
`1.2.0-beta.12` is a prerelease as of this check and should not silently replace
the stable pin
([releases](https://github.com/microsoft/node-pty/releases)).

### ABI and prebuilds

1.1.0 moved the native module to Node-API/N-API. Node documents Node-API as ABI
stable across Node versions and JS engines, reducing the old per-Electron-ABI
rebuild churn
([node-pty v1.1.0](https://github.com/microsoft/node-pty/releases/tag/v1.1.0),
[Node-API stability](https://nodejs.org/api/n-api.html)). This does not make one
binary universal across OS, architecture, or libc.

The published 1.1.0 package and tagged pipeline provide:

- macOS x64 and ARM64 native modules and `spawn-helper`;
- Windows x64 and ARM64 native modules plus ConPTY/OpenConsole helper binaries;
- **no Linux prebuilds**. The release pipeline explicitly excludes Linux
  prebuilds from the archive, so install falls back to `node-gyp rebuild`.

See the tagged
[`pipelines/prebuilds.yml`](https://github.com/microsoft/node-pty/blob/v1.1.0/pipelines/prebuilds.yml)
and [`scripts/prebuild.js`](https://github.com/microsoft/node-pty/blob/v1.1.0/scripts/prebuild.js).
Build Linux x64/ARM64 separately for every supported glibc/musl target in
reproducible CI. Package managers that suppress install scripts will also
suppress fallback compilation.

Electron still recommends rebuilding native modules against the selected
Electron version/architecture with `@electron/rebuild` and repeating that after
upgrades. For this N-API module, use rebuild as a verification/build fallback,
then smoke-test `require`, spawn, input, resize, and exit inside the signed
packaged application on every target
([Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)).

### Packaging traps

- Native `.node` files and spawned helpers need real filesystem paths.
  Electron's ASAR docs explain that `process.dlopen` requires extraction and
  most child-process operations cannot execute arbitrary files in an archive.
  Put node-pty natives/helpers and the Zellij binary in `app.asar.unpacked` or
  `extraResources`, preserve execute bits, and sign/notarize them
  ([ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)).
- Prune non-target prebuilds only after verifying that runtime selection cannot
  reach them. Universal macOS packaging must contain both x64 and ARM64 slices.
- Windows endpoint protection can quarantine node-pty helper files in
  `app.asar.unpacked`; VS Code documents this as a terminal-launch failure mode
  ([VS Code terminal launch troubleshooting](https://code.visualstudio.com/docs/supporting/troubleshoot-terminal-launch)).
- Keep node-pty in the main/session-daemon trust boundary. Its README notes that
  children inherit the parent's permissions and that node-pty is not thread
  safe. Expose a narrow, validated IPC API to a sandboxed/context-isolated
  renderer, not Node access
  ([node-pty security and thread safety](https://github.com/microsoft/node-pty)).

### ConPTY specifics

node-pty uses ConPTY on supported Windows. Its 1.1.0 types expose Windows-only
cursor inheritance and buffer clearing; Unix signals passed to `kill` are not
portable to Windows
([1.1.0 types](https://github.com/microsoft/node-pty/blob/v1.1.0/typings/node-pty.d.ts)).
Microsoft's pseudoconsole documentation warns hosts to service synchronous input
and output channels on separate threads to avoid deadlock
([creating a pseudoconsole session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)).

ConPTY considers itself the viewport owner and can reprint old content after a
clear/resize; VS Code documents this as a normal ConPTY quirk
([VS Code Windows/ConPTY notes](https://code.visualstudio.com/docs/terminal/advanced#windows-and-conpty)).
The resize acceptance test must therefore compare final emulator state, not
assume output is append-only.

## 6. Bundling license, provenance, and size

This is engineering inventory, not legal advice.

| Component | Direct license | Distribution action |
| --- | --- | --- |
| Zellij 0.44.3 | MIT ([license](https://github.com/zellij-org/zellij/blob/v0.44.3/LICENSE.md)) | Include the copyright and MIT text; preserve exact archive checksum and source tag. If Hive patches cache placement, publish/retain the corresponding source and build provenance as internal compliance policy even though MIT does not require source distribution. |
| xterm.js 6.0.0 and official addons | MIT ([license/repository](https://github.com/xtermjs/xterm.js/tree/6.0.0)) | Include its notices and pin every scoped addon version. |
| node-pty 1.1.0 | MIT ([license](https://github.com/microsoft/node-pty/blob/v1.1.0/LICENSE)) | Include its MIT text and all notices shipped with native/helper payloads, including the bundled winpty license where present. |
| Electron 43.1.1 | MIT ([license](https://github.com/electron/electron/blob/v43.1.1/LICENSE)) | Preserve Electron's license plus the Chromium/third-party license files distributed in the official binary. Electron embeds Chromium, Node, and many third-party components, so the top-level MIT label is not a complete notice inventory. |

There is no copyleft in these four top-level licenses. MIT requires retaining
its copyright and permission notice in copies or substantial portions. Generate
an SBOM and third-party notice bundle from the actual packaged artifacts; do not
infer transitive obligations from repository badges.

### Compressed package ballpark

As of 2026-07-15 the current Electron stable is **43.1.1** (released
2026-07-14); Electron supports the latest three stable lines
([release index](https://releases.electronjs.org/),
[support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)).
Official 43.1.1 Electron zip sizes are approximately:

| Platform/arch | Electron zip | Zellij 0.44.3 no-web archive | Base before Hive/app/node-pty |
| --- | ---: | ---: | ---: |
| macOS ARM64 | 122.1 MB | 11.6 MB | 133.7 MB |
| macOS x64 | 124.0 MB | 11.9 MB | 135.9 MB |
| Linux ARM64 | 124.5 MB | 14.2 MB | 138.6 MB |
| Linux x64 | 124.9 MB | 14.6 MB | 139.5 MB |
| Windows x64 | 144.3 MB | 12.8 MB | 157.1 MB |
| Windows ARM64 | 141.3 MB | **no official Zellij asset** | not buildable from official artifacts |

Sources are the official
[`Electron 43.1.1 asset manifest`](https://api.github.com/repos/electron/electron/releases/tags/v43.1.1)
and [`Zellij 0.44.3 asset manifest`](https://api.github.com/repos/zellij-org/zellij/releases/tags/v0.44.3).
The `@xterm/xterm` 6.0.0 package is about 5.9 MB unpacked, while the published
node-pty 1.1.0 package is about 64.4 MB unpacked because it contains multiple
platform/architecture helpers and debug artifacts
([xterm registry metadata](https://registry.npmjs.org/%40xterm%2Fxterm/6.0.0),
[node-pty registry metadata](https://registry.npmjs.org/node-pty/1.1.0)).

After target pruning, application code, addons, signing, and installer overhead,
budget roughly **145-175 MB compressed for macOS/Linux x64 or ARM64** and
**165-200 MB for Windows x64**. These are planning ranges, not release promises;
measure the signed installers and installed footprint in CI. Electron dominates
the result. The no-web Zellij build is preferable because Hive does not use its
web server.

## 7. Prior art and better architectures

### VS Code

VS Code distinguishes:

- **process reconnection**: a window reload reconnects to the existing process
  and restores content; and
- **process revive**: after a full VS Code restart, content is restored and the
  process is relaunched with its original environment.

It can detach/attach terminals between windows. It also makes terminal shortcut
arbitration explicit with `terminal.integrated.commandsToSkipShell` and an
override that sends most shortcuts to the shell
([Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced)).
Its source separates PTY hosting from the renderer and even includes developer
latency/startup-delay controls for the pty host
([terminal configuration source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts)).

Lesson: Hive should adopt the durable PTY-host boundary and reconnect/replay
protocol. Also preserve the honest distinction between a live reattachment and
a relaunched “revived” process; serialized xterm scrollback is not process
persistence.

### Warp

Warp's session restoration persists windows, tabs, panes, and the last few
blocks to SQLite; it does not claim that local child processes survive app exit
([session restoration](https://docs.warp.dev/terminal/sessions/session-restoration)).
Its July 2026 roadmap still lists local/SSH persistent sessions, pane detaching,
and tmux control mode as future work
([roadmap #9233](https://github.com/warpdotdev/warp/issues/9233)).

For agent input, Warp's Full Terminal Use places the agent on the active PTY and
provides an explicit **Take over** control that stops agent PTY writes until the
user hands control back
([Full Terminal Use](https://docs.warp.dev/agent-platform/capabilities/full-terminal-use)).

Lesson: explicit human/agent ownership is better than a timeout. Hive's required
latched draft protection is stricter and should live in the sole writer, but the
visible takeover/handoff affordance is good prior art.

### Wave Terminal

Wave's durable remote sessions install a lightweight Go job manager on the
remote host. It owns the shell independently, buffers output while detached,
and reconnects through Unix-domain sockets. The feature currently applies to
remote SSH only, not local terminals or WSL
([durable sessions](https://docs.waveterm.dev/durable-sessions),
[Wave repository](https://github.com/wavetermdev/waveterm)).

Lesson: a purpose-built headless manager can supply exactly the lifecycle and
replay protocol the UI needs without inheriting multiplexer UI/input semantics.
Hive needs the same pattern locally and can reuse it remotely.

### Tabby

Tabby is Electron-based, uses xterm.js for its frontend and node-pty for local
shells, remembers tabs/split panes, provides configurable shortcuts, and warns
on multiline paste
([repository/features](https://github.com/Eugeny/tabby),
[feature page](https://tabby.sh/about/features)). Its public feature claim is
UI/history restoration, not survival of the same local process through a full
app exit; it does not bundle a multiplexer.

Lesson: Electron + xterm.js + node-pty is established, but Tabby's model does
not close Hive's stronger process-survival requirement. Its paste warning and
shortcut configurability are still useful UI precedents.

## Recommended production architecture

1. **Introduce a persistent Hive session daemon.** It owns node-pty/ConPTY,
   output backpressure, xterm replay checkpoints, lifecycle state, and the only
   input writer. Electron is a reconnectable view/controller.
2. **Route all input through one queue.** Renderer keystrokes, paste, and
   automation share one ordered protocol. Implement latched human ownership in
   that daemon. Never combine direct attached input with plugin injection.
3. **Make Zellij optional and asymmetric initially.** On qualified Unix builds,
   the daemon may attach to one invisible, isolated Zellij session for survival
   if the daemon itself restarts. On Windows, use direct ConPTY until Zellij's
   ordered-input/lifecycle suite passes. The UI/protocol remains cross-platform
   even when the persistence backend differs.
4. **If identical backends are mandatory, patch Zellij first.** Add a cache
   override, produce Windows ARM64 artifacts, and require fixes for #5333 and
   #4998 before reconsidering H5.
5. **Treat screen capture as emulator state, not control mode.** Keep a headless
   xterm.js mirror or structured daemon replay log for automation/snapshots;
   use `dump-screen` only as a diagnostic until its resize/alternate-screen
   behavior passes fixtures.

This design is simpler on the critical input path: one daemon-owned PTY write
replaces the CLI-argv and WASM-plugin alternatives, while Zellij—where retained—
does only the job it is strongest at: keeping the vendor process and terminal
state alive when a client detaches.

## Remaining prototype gates

Do not change the production decision until all of these pass on every shipped
OS/architecture:

- zero Zellij-owned cells, overlays, OSC title changes, keybindings, mouse
  actions, and background-plugin effects from first frame through attach;
- verified private config/data/socket/temp/cache paths, including denial tests
  against a hostile user Zellij config/cache;
- a hash-checked ≥1 MiB multiline/control-character payload with no prompt
  content in argv, logs, crash reports, or session names;
- a concurrency trace proving that a latched human draft never interleaves with
  queued automation and never releases on a timer;
- vendor fixtures for alternate screen, cursor addressing, SGR mouse, bracketed
  paste, CJK IME, grapheme clusters, RGB/underline/blink policy, OSC 8, OSC 52,
  resize storms, detach/reattach, and sustained-output backpressure;
- renderer crash, Electron main-process crash, daemon restart, and full machine
  restart, with each outcome labeled reattach versus relaunch; and
- packaged/signed/notarized smoke tests for all native files, helper execution,
  antivirus behavior, and third-party notices.
