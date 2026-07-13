import AppKit

// Entry point. The CLI launches the app with
//   --project <abs dir> --port <daemon port> --hive <abs hive binary>
//   --orchestrator-session <tmux session> [--orchestrator claude|codex|grok]
// `--smoke` runs the headless end-to-end checks (offscreen windows, real
// terminals, real tmux) and exits 0/1; `--feed <binary>` overrides the feed
// subprocess for that harness.
let config = LaunchConfig.parse(Array(CommandLine.arguments.dropFirst()))

let app = NSApplication.shared
if let appearance = config.appearance {
    // Screenshot/verification affordance: force this app's appearance
    // without touching the system setting.
    app.appearance = NSAppearance(
        named: appearance == "light" ? .aqua : .darkAqua)
}
let delegate = AppDelegate(config: config)
app.delegate = delegate
// Smoke stays a background process (offscreen windows, no Dock icon) — except
// under HIVE_SMOKE_VISIBLE, where the checks that need a KEY window (a click
// only moves focus in one) require a regular, activatable app. The policy has
// to be right at launch: flipping it later does not win key status.
let smokeVisible = ProcessInfo.processInfo.environment["HIVE_SMOKE_VISIBLE"] == "1"
app.setActivationPolicy(config.smoke && !smokeVisible ? .accessory : .regular)
app.run()
