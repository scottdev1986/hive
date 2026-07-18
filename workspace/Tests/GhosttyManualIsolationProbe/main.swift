import AppKit
import Darwin
import Foundation
import HiveGhosttyC
import HiveTerminalKit

final class CallbackLog: @unchecked Sendable {
    private let lock = NSLock()
    private var writes: [Data] = []

    func append(_ bytes: Data) {
        lock.lock()
        writes.append(bytes)
        lock.unlock()
    }

    func snapshot() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return writes
    }
}

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("MANUAL_ISOLATION_FAIL \(message)\n".utf8))
    Darwin.exit(1)
}

private func emit(stage: String, facts: [String: Any] = [:]) {
    var object = facts
    object["stage"] = stage
    object["pid"] = ProcessInfo.processInfo.processIdentifier
    guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: bytes, encoding: .utf8) else {
        fail("could not encode stage \(stage)")
    }
    print(line)
    fflush(stdout)
}

private func awaitNext() {
    guard readLine() == "next" else { fail("qualification controller disconnected") }
}

private func readScreen(_ surface: ghostty_surface_t) -> String {
    var text = ghostty_text_s()
    let selection = ghostty_selection_s(
        top_left: ghostty_point_s(
            tag: GHOSTTY_POINT_SCREEN,
            coord: GHOSTTY_POINT_COORD_TOP_LEFT,
            x: 0,
            y: 0
        ),
        bottom_right: ghostty_point_s(
            tag: GHOSTTY_POINT_SCREEN,
            coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
            x: 0,
            y: 0
        ),
        rectangle: false
    )
    guard ghostty_surface_read_text(surface, selection, &text) else { return "" }
    defer { ghostty_surface_free_text(surface, &text) }
    guard let pointer = text.text else { return "" }
    return String(data: Data(bytes: pointer, count: Int(text.text_len)), encoding: .utf8) ?? ""
}

private func process(_ surface: ghostty_surface_t, _ data: Data, at sequence: UInt64) -> ghostty_result_e {
    data.withUnsafeBytes { raw in
        hive_ghostty_surface_process_output_v1(
            surface,
            raw.bindMemory(to: UInt8.self).baseAddress,
            raw.count,
            sequence
        )
    }
}

setbuf(stdout, nil)
emit(stage: "before")
awaitNext()

_ = ghostty_init(0, nil)
guard let config = ghostty_config_new() else { fail("ghostty_config_new") }
ghostty_config_finalize(config)

var runtime = ghostty_runtime_config_s(
    userdata: nil,
    supports_selection_clipboard: false,
    wakeup_cb: { _ in },
    action_cb: { _, _, _ in false },
    read_clipboard_cb: { _, _, _ in false },
    confirm_read_clipboard_cb: { _, _, _, _ in },
    write_clipboard_cb: { _, _, _, _, _ in },
    close_surface_cb: { _, _ in }
)
guard let app = ghostty_app_new(&runtime, config) else { fail("ghostty_app_new") }

let hostView = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
let callbackContext = BridgeCallbackContext()
let callbackLog = CallbackLog()
callbackContext.onWrite = { callbackLog.append($0) }

let workingDirectory = strdup("/hive-manual-cwd-must-be-inert-and-missing")!
let command = strdup("/bin/sleep 600")!
let initialInput = strdup("INITIAL_INPUT_MUST_BE_INERT")!
let environmentKey = strdup("HIVE_MANUAL_ENV_MUST_BE_INERT")!
let environmentValue = strdup("sentinel")!
defer {
    free(workingDirectory)
    free(command)
    free(initialInput)
    free(environmentKey)
    free(environmentValue)
}
var environment = ghostty_env_var_s(key: environmentKey, value: environmentValue)
var surfaceConfig = ghostty_surface_config_new()
surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
surfaceConfig.platform = ghostty_platform_u(
    macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(hostView).toOpaque())
)
surfaceConfig.scale_factor = 2
surfaceConfig.font_size = 13
surfaceConfig.working_directory = UnsafePointer(workingDirectory)
surfaceConfig.command = UnsafePointer(command)
surfaceConfig.initial_input = UnsafePointer(initialInput)
surfaceConfig.wait_after_command = true

let surface: ghostty_surface_t? = withUnsafeMutablePointer(to: &environment) { environmentPointer in
    surfaceConfig.env_vars = environmentPointer
    surfaceConfig.env_var_count = 1
    return hive_ghostty_surface_new_manual_v1(
        app,
        &surfaceConfig,
        hiveBridgeWriteTrampoline,
        callbackContext.unownedContextPointer,
        hiveBridgeEventTrampoline,
        callbackContext.unownedContextPointer
    )
}
guard let surface else { fail("manual surface creation rejected inert process fields") }
ghostty_surface_set_size(surface, 640, 360)

let createScreen = readScreen(surface)
if createScreen.contains("INITIAL_INPUT_MUST_BE_INERT") { fail("initial_input mutated terminal state") }
if !callbackLog.snapshot().isEmpty { fail("creation emitted host bytes") }
let processExited = ghostty_surface_process_exited(surface)
let foregroundPID = ghostty_surface_foreground_pid(surface)
var tty = ghostty_surface_tty_name(surface)
let ttyLength = Int(tty.len)
ghostty_string_free(tty)
if processExited || foregroundPID != 0 || ttyLength != 0 {
    fail("manual stock query sentinels drifted")
}
emit(stage: "create", facts: [
    "engineBuildId": String(cString: hive_ghostty_engine_build_id_v1()),
    "processExited": processExited,
    "foregroundPid": String(foregroundPID),
    "ttyLength": ttyLength,
    "writeCallbacks": callbackLog.snapshot().count,
    "initialInputVisible": false,
])
awaitNext()

let remote = Data("REMOTE_OUTPUT_ONLY".utf8)
guard process(surface, remote, at: 0) == GHOSTTY_SUCCESS else { fail("ordered process_output rejected") }
let screenAfterOutput = readScreen(surface)
if !screenAfterOutput.contains("REMOTE_OUTPUT_ONLY") { fail("process_output did not mutate remote state") }
if screenAfterOutput.contains("INITIAL_INPUT_MUST_BE_INERT") { fail("initial_input became visible during use") }
if !callbackLog.snapshot().isEmpty { fail("ordinary remote output emitted host bytes") }

"HOST_INPUT_CALLBACK".withCString { pointer in
    ghostty_surface_text(surface, pointer, UInt("HOST_INPUT_CALLBACK".utf8.count))
}
let deadline = Date().addingTimeInterval(3)
while callbackLog.snapshot().isEmpty && Date() < deadline {
    Thread.sleep(forTimeInterval: 0.01)
}
let writes = callbackLog.snapshot()
if writes != [Data("HOST_INPUT_CALLBACK".utf8)] { fail("terminal-generated bytes bypassed or duplicated write callback") }
if readScreen(surface).contains("HOST_INPUT_CALLBACK") { fail("host input mutated remote output state") }
emit(stage: "use", facts: [
    "remoteOutputVisible": true,
    "hostInputVisible": false,
    "writeCallbacks": writes.count,
    "writeHex": writes.map { $0.map { String(format: "%02x", $0) }.joined() },
])
awaitNext()

ghostty_surface_free(surface)
ghostty_app_free(app)
ghostty_config_free(config)
emit(stage: "free", facts: ["writeCallbacks": callbackLog.snapshot().count])
awaitNext()
emit(stage: "done")
