import AppKit

// Entry point. The CLI launches the app with
//   --project <abs dir> --port <daemon port> --hive <abs hive binary>
// `--smoke` runs the headless end-to-end checks (offscreen windows, real
// terminals, real tmux) and exits 0/1; `--feed <binary>` overrides the feed
// subprocess for that harness.
let config = LaunchConfig.parse(Array(CommandLine.arguments.dropFirst()))

let app = NSApplication.shared
let delegate = AppDelegate(config: config)
app.delegate = delegate
app.setActivationPolicy(config.smoke ? .accessory : .regular)
app.run()
