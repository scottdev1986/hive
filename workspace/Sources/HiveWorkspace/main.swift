import AppKit
import WorkspaceCore

// Entry point. `--smoke` drives the full fixture script through real windows
// offscreen and exits, so CI can exercise the AppKit layer headlessly.
let smokeMode = CommandLine.arguments.contains("--smoke")

let app = NSApplication.shared
let delegate = AppDelegate(smokeMode: smokeMode)
app.delegate = delegate
app.setActivationPolicy(smokeMode ? .accessory : .regular)
app.run()
