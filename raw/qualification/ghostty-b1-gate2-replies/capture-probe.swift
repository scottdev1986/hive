import AppKit
import Darwin
import Foundation
import HiveGhosttyC

private let esc = "\u{1B}"

final class CallbackLog: @unchecked Sendable {
    private let lock = NSLock()
    private var writes: [Data] = []
    private var events: [Int] = []

    func appendWrite(_ data: Data) {
        lock.lock()
        writes.append(data)
        lock.unlock()
    }

    func appendEvent(_ type: Int) {
        lock.lock()
        events.append(type)
        lock.unlock()
    }

    func reset() {
        lock.lock()
        writes.removeAll()
        events.removeAll()
        lock.unlock()
    }

    func snapshot() -> (writes: [Data], events: [Int]) {
        lock.lock()
        defer { lock.unlock() }
        return (writes, events)
    }
}

final class HostClipboardReadProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var invocations = 0

    func record() {
        lock.lock()
        invocations += 1
        lock.unlock()
    }

    func count() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return invocations
    }
}

private let hostClipboardReadProbe = HostClipboardReadProbe()

private let writeCallback: hive_ghostty_write_fn = { context, bytes, length in
    guard let context, let bytes else { return }
    Unmanaged<CallbackLog>.fromOpaque(context).takeUnretainedValue()
        .appendWrite(Data(bytes: bytes, count: Int(length)))
}

private let eventCallback: hive_ghostty_event_fn = { context, event in
    guard let context, let event else { return }
    Unmanaged<CallbackLog>.fromOpaque(context).takeUnretainedValue()
        .appendEvent(Int(event.pointee.type.rawValue))
}

private func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

private func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else {
        fputs("could not encode JSONL record\n", stderr)
        Darwin.exit(1)
    }
    print(line)
}

private func fail(_ message: String) -> Never {
    fputs("GATE2_CAPTURE_FAIL \(message)\n", stderr)
    Darwin.exit(1)
}

final class Surface {
    let log: CallbackLog
    private let app: ghostty_app_t
    private var ownedHandle: ghostty_surface_t?
    private var sequence: UInt64 = 0

    var handle: ghostty_surface_t {
        guard let ownedHandle else { fail("use after surface free") }
        return ownedHandle
    }

    init(app: ghostty_app_t, policy: UInt32) {
        self.app = app
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
        log = CallbackLog()
        var config = ghostty_surface_config_new()
        config.platform_tag = GHOSTTY_PLATFORM_MACOS
        config.platform = ghostty_platform_u(
            macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(view).toOpaque())
        )
        config.userdata = Unmanaged.passUnretained(hostClipboardReadProbe).toOpaque()
        config.scale_factor = 2
        config.font_size = 13
        guard let created = hive_ghostty_surface_new_manual_v1(
            app,
            &config,
            policy,
            writeCallback,
            Unmanaged.passUnretained(log).toOpaque(),
            eventCallback,
            Unmanaged.passUnretained(log).toOpaque()
        ) else {
            fail("manual surface creation")
        }
        ownedHandle = created
        ghostty_surface_set_size(handle, 640, 360)
    }

    deinit {
        free()
    }

    func free() {
        guard let handle = ownedHandle else { return }
        ghostty_surface_free(handle)
        ownedHandle = nil
    }

    func process(_ data: Data) {
        let result = data.withUnsafeBytes { raw in
            hive_ghostty_surface_process_output_v1(
                handle,
                raw.bindMemory(to: UInt8.self).baseAddress,
                raw.count,
                sequence
            )
        }
        guard result == GHOSTTY_SUCCESS else { fail("process_output at sequence \(sequence)") }
        sequence += UInt64(data.count)
    }

    func observe(_ data: Data, drainSeconds: TimeInterval = 0) -> (writes: [Data], events: [Int]) {
        log.reset()
        process(data)
        if drainSeconds > 0 {
            let deadline = Date().addingTimeInterval(drainSeconds)
            while Date() < deadline {
                ghostty_app_tick(app)
                RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
            }
        }
        return log.snapshot()
    }
}

struct Query {
    let name: String
    let input: Data
    let expected: (Surface) -> Data

    init(_ name: String, _ input: String, _ expected: String) {
        self.name = name
        self.input = Data(input.utf8)
        self.expected = { _ in Data(expected.utf8) }
    }

    init(_ name: String, _ input: String, expected: @escaping (Surface) -> Data) {
        self.name = name
        self.input = Data(input.utf8)
        self.expected = expected
    }
}

setbuf(stdout, nil)
_ = ghostty_init(0, nil)
guard let config = ghostty_config_new() else { fail("ghostty_config_new") }
let configPolicyURL = FileManager.default.temporaryDirectory
    .appendingPathComponent("hive-gate2-clipboard-policy-\(ProcessInfo.processInfo.processIdentifier).conf")
do {
    try Data("clipboard-read = deny\n".utf8).write(to: configPolicyURL, options: .atomic)
} catch {
    fail("write clipboard-read policy: \(error)")
}
let loadedConfigPolicy = configPolicyURL.withUnsafeFileSystemRepresentation { path in
    guard let path else { return false }
    ghostty_config_load_file(config, path)
    return true
}
try? FileManager.default.removeItem(at: configPolicyURL)
guard loadedConfigPolicy else { fail("load clipboard-read policy") }
ghostty_config_finalize(config)
let configDiagnostics = ghostty_config_diagnostics_count(config)
guard configDiagnostics == 0 else { fail("clipboard-read policy diagnostics: \(configDiagnostics)") }
var runtime = ghostty_runtime_config_s(
    userdata: nil,
    supports_selection_clipboard: false,
    wakeup_cb: { _ in },
    action_cb: { _, _, _ in false },
    read_clipboard_cb: { context, _, _ in
        guard let context else { return false }
        Unmanaged<HostClipboardReadProbe>.fromOpaque(context).takeUnretainedValue().record()
        return false
    },
    confirm_read_clipboard_cb: { _, _, _, _ in },
    write_clipboard_cb: { _, _, _, _, _ in },
    close_surface_cb: { _, _ in }
)
guard let app = ghostty_app_new(&runtime, config) else { fail("ghostty_app_new") }

let surface = Surface(app: app, policy: UInt32(HIVE_GHOSTTY_TERMINAL_REPLIES_ENABLED))
let hostReadPositiveAction = "paste_from_clipboard"
let hostReadPositiveBefore = hostClipboardReadProbe.count()
let hostReadPositiveActionResult = hostReadPositiveAction.withCString { action in
    ghostty_surface_binding_action(surface.handle, action, UInt(hostReadPositiveAction.utf8.count))
}
let hostReadPositiveDeadline = Date().addingTimeInterval(0.1)
while Date() < hostReadPositiveDeadline {
    ghostty_app_tick(app)
    RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
}
let hostReadPositiveDelta = hostClipboardReadProbe.count() - hostReadPositiveBefore
guard hostReadPositiveDelta == 1 else {
    fail("host clipboard read callback engine-path positive control action_result=\(hostReadPositiveActionResult) delta=\(hostReadPositiveDelta)")
}
let size = ghostty_surface_size(surface.handle)
let rows = Int(size.rows)
let columns = Int(size.columns)
let width = Int(size.width_px)
let height = Int(size.height_px)
let cellWidth = Int(size.cell_width_px)
let cellHeight = Int(size.cell_height_px)
let engineBuildID = String(cString: hive_ghostty_engine_build_id_v1())
let engineVersion = "ghostty 1.3.2-hive-florence-category-complex-coding-m1-b1-+a07b570d"

emit([
    "kind": "metadata",
    "engine_build_id": engineBuildID,
    "clipboard_read_config_policy": "deny",
    "config_diagnostics_count": configDiagnostics,
    "ghostty_commit": "73534c4680a809398b396c94ac7f12fcccb7963d",
    "ghostty_version": engineVersion,
    "host_read_callback_positive_control": hostReadPositiveAction,
    "host_read_callback_positive_control_action_result": hostReadPositiveActionResult,
    "host_read_callback_positive_control_delta": hostReadPositiveDelta,
    "surface": [
        "columns": columns,
        "rows": rows,
        "width_px": width,
        "height_px": height,
        "cell_width_px": cellWidth,
        "cell_height_px": cellHeight,
        "scale_factor": 2,
        "font_size": 13,
    ],
])

let queries: [Query] = [
    Query("DSR operating status", "\(esc)[5n", "\(esc)[0n"),
    Query("DSR cursor position", "\(esc)[3;7H\(esc)[6n", "\(esc)[3;7R"),
    Query("DA1 primary device attributes", "\(esc)[c", "\(esc)[?62;22c"),
    Query("DA2 secondary device attributes", "\(esc)[>c", "\(esc)[>1;10;0c"),
    Query("DA3 tertiary device attributes", "\(esc)[=c", "\(esc)P!|00000000\(esc)\\"),
    Query("XTVERSION", "\(esc)[>q", "\(esc)P>|\(engineVersion)\(esc)\\"),
    Query("DECRQM wraparound", "\(esc)[?7$p", "\(esc)[?7;1$y"),
    Query("DECRQM unknown private mode", "\(esc)[?9999$p", "\(esc)[?9999;0$y"),
    Query("kitty keyboard flags", "\(esc)[?u", "\(esc)[?0u"),
    Query("XTWINOPS window pixels", "\(esc)[14t", expected: { _ in
        Data("\(esc)[4;\(rows * cellHeight);\(columns * cellWidth)t".utf8)
    }),
    Query("XTWINOPS cell pixels", "\(esc)[16t", expected: { _ in
        Data("\(esc)[6;\(cellHeight);\(cellWidth)t".utf8)
    }),
    Query("XTWINOPS text area characters", "\(esc)[18t", expected: { _ in
        Data("\(esc)[8;\(rows);\(columns)t".utf8)
    }),
    Query("XTWINOPS window title", "\(esc)]2;Gate 2\(esc)\\\(esc)[21t", "\(esc)]lGate 2\(esc)\\"),
    Query("OSC 4 palette color", "\(esc)]4;2;rgb:12/34/56\(esc)\\\(esc)]4;2;?\(esc)\\", "\(esc)]4;2;rgb:1212/3434/5656\(esc)\\"),
    Query("OSC 10 dynamic foreground", "\(esc)]10;rgb:01/02/03\(esc)\\\(esc)]10;?\(esc)\\", "\(esc)]10;rgb:0101/0202/0303\(esc)\\"),
    Query("OSC 21 kitty foreground", "\(esc)]21;foreground=rgb:12/34/56\(esc)\\\(esc)]21;foreground=?\(esc)\\", "\(esc)]21;foreground=rgb:12/34/56\(esc)\\"),
    Query("DECRQSS SGR", "\(esc)P$qm\(esc)\\", "\(esc)P1$r0m\(esc)\\"),
    Query("XTGETTCAP TN", "\(esc)P+q544E\(esc)\\", "\(esc)P1+r544E=787465726D2D67686F73747479\(esc)\\"),
    Query("glyph protocol capabilities", "\(esc)_25a1;s\(esc)\\", "\(esc)_25a1;s;fmt=glyf\(esc)\\"),
    Query("kitty graphics acknowledgement", "\(esc)_Ga=t,t=d,f=24,i=1,s=1,v=2,c=10,r=1;////////\(esc)\\", "\(esc)_Gi=1;OK\(esc)\\"),
    Query("DSR cursor position at vttest coordinate", "\(esc)[5;1H\(esc)[6n", "\(esc)[5;1R"),
]

var passedQueries = 0
for (ordinal, query) in queries.enumerated() {
    let expected = query.expected(surface)
    let observed = surface.observe(query.input)
    let pass = !expected.isEmpty && observed.writes == [expected]
    if pass { passedQueries += 1 }
    emit([
        "kind": "query",
        "ordinal": ordinal + 1,
        "name": query.name,
        "input_hex": hex(query.input),
        "expected_hex": hex(expected),
        "expected_nonempty": !expected.isEmpty,
        "callback_count": observed.writes.count,
        "callback_hex": observed.writes.map(hex),
        "exact_once": pass,
    ])
}

let burstQueries = [queries[0], queries[2], queries[5], queries[16], queries[17], queries[8]]
let burstInput = burstQueries.reduce(into: Data()) { $0.append($1.input) }
let burstExpected = burstQueries.map { $0.expected(surface) }
let burstObserved = surface.observe(burstInput).writes
let burstPass = burstObserved == burstExpected && burstExpected.allSatisfy { !$0.isEmpty }
emit([
    "kind": "ordered_burst",
    "names": burstQueries.map(\.name),
    "input_hex": hex(burstInput),
    "expected_callback_hex": burstExpected.map(hex),
    "callback_hex": burstObserved.map(hex),
    "callback_count": burstObserved.count,
    "in_order_exact_once": burstPass,
])

func emitSilencePolicy(
    name: String,
    input: Data,
    requiredEvent: Int? = nil,
    hostReadCallbackMustStayFlat: Bool = false
) -> Bool {
    let hostReadBefore = hostClipboardReadProbe.count()
    let silent = surface.observe(input, drainSeconds: 0.1)
    let hostReadCallbackCount = hostClipboardReadProbe.count() - hostReadBefore
    let positive = surface.observe(Data("\(esc)[c".utf8))
    let eventPass = requiredEvent.map { silent.events.contains($0) } ?? true
    let pass = silent.writes.isEmpty
        && eventPass
        && (!hostReadCallbackMustStayFlat || hostReadCallbackCount == 0)
        && positive.writes == [Data("\(esc)[?62;22c".utf8)]
    emit([
        "kind": "silence_policy",
        "name": name,
        "input_hex": hex(input),
        "callback_count": silent.writes.count,
        "callback_hex": silent.writes.map(hex),
        "event_types": silent.events,
        "required_event": requiredEvent as Any,
        "host_read_callback_count": hostReadCallbackCount,
        "host_read_callback_must_stay_flat": hostReadCallbackMustStayFlat,
        "positive_control_input_hex": hex(Data("\(esc)[c".utf8)),
        "positive_control_callback_hex": positive.writes.map(hex),
        "positive_control_exact_once": positive.writes == [Data("\(esc)[?62;22c".utf8)],
        "pass": pass,
    ])
    return pass
}

let silencePasses = [
    emitSilencePolicy(name: "ENQ pinned empty enquiry response", input: Data([0x05])),
    emitSilencePolicy(name: "DSR color scheme unavailable", input: Data("\(esc)[?996n".utf8)),
    emitSilencePolicy(
        name: "OSC 52 clipboard read BEL",
        input: Data("\(esc)]52;c;?\u{07}".utf8),
        hostReadCallbackMustStayFlat: true
    ),
    emitSilencePolicy(
        name: "OSC 52 clipboard read ST",
        input: Data("\(esc)]52;c;?\(esc)\\".utf8),
        hostReadCallbackMustStayFlat: true
    ),
    emitSilencePolicy(
        name: "OSC 52 clipboard write denied",
        input: Data("\(esc)]52;c;SGVsbG8=\(esc)\\".utf8),
        requiredEvent: Int(HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED.rawValue)
    ),
    emitSilencePolicy(
        name: "OSC 52 clipboard clear denied",
        input: Data("\(esc)]52;c;\(esc)\\".utf8),
        requiredEvent: Int(HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED.rawValue)
    ),
]

let disabledSurface = Surface(app: app, policy: UInt32(HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED))
let disabled = disabledSurface.observe(Data("\(esc)[5n\(esc)[c\(esc)[>q".utf8))
let enabledPositiveSurface = Surface(app: app, policy: UInt32(HIVE_GHOSTTY_TERMINAL_REPLIES_ENABLED))
let enabledPositive = enabledPositiveSurface.observe(Data("\(esc)[c".utf8))
let disabledPass = disabled.writes.isEmpty
    && enabledPositive.writes == [Data("\(esc)[?62;22c".utf8)]
emit([
    "kind": "disabled_policy",
    "input_hex": hex(Data("\(esc)[5n\(esc)[c\(esc)[>q".utf8)),
    "callback_count": disabled.writes.count,
    "callback_hex": disabled.writes.map(hex),
    "enabled_positive_control_callback_hex": enabledPositive.writes.map(hex),
    "enabled_positive_control_exact_once": enabledPositive.writes == [Data("\(esc)[?62;22c".utf8)],
    "pass": disabledPass,
])

let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 3 else {
    fail("usage: capture-probe CLAUDE_RAW CODEX_RAW GROK_RAW")
}

let vendorExpectations: [(name: String, path: String, queryNames: [String], expected: [Data])] = [
    (
        "claude-code",
        String(arguments[arguments.startIndex]),
        ["XTVERSION", "DA1"],
        [
            Data("\(esc)P>|\(engineVersion)\(esc)\\".utf8),
            Data("\(esc)[?62;22c".utf8),
        ]
    ),
    (
        "codex-cli",
        String(arguments[arguments.index(arguments.startIndex, offsetBy: 1)]),
        ["DSR cursor position", "OSC 10 foreground", "OSC 11 background", "kitty keyboard flags", "DA1"],
        [
            Data("\(esc)[1;1R".utf8),
            Data("\(esc)]10;rgb:ffff/ffff/ffff\(esc)\\".utf8),
            Data("\(esc)]11;rgb:2828/2c2c/3434\(esc)\\".utf8),
            Data("\(esc)[?7u".utf8),
            Data("\(esc)[?62;22c".utf8),
        ]
    ),
    (
        "grok-cli",
        String(arguments[arguments.index(arguments.startIndex, offsetBy: 2)]),
        [],
        []
    ),
]

var vendorPasses = 0
for vendor in vendorExpectations {
    guard let input = FileManager.default.contents(atPath: vendor.path) else {
        fail("read vendor corpus \(vendor.path)")
    }
    let vendorSurface = Surface(app: app, policy: UInt32(HIVE_GHOSTTY_TERMINAL_REPLIES_ENABLED))
    let observed = vendorSurface.observe(input)
    let positive = vendorSurface.observe(Data("\(esc)[c".utf8))
    let exact = observed.writes == vendor.expected
    let positivePass = positive.writes == [Data("\(esc)[?62;22c".utf8)]
    if exact && positivePass { vendorPasses += 1 }
    emit([
        "kind": "vendor_corpus",
        "vendor": vendor.name,
        "input_path": vendor.path,
        "input_bytes": input.count,
        "input_hex": hex(input),
        "query_names": vendor.queryNames,
        "query_count": vendor.queryNames.count,
        "expected_callback_hex": vendor.expected.map(hex),
        "callback_count": observed.writes.count,
        "callback_hex": observed.writes.map(hex),
        "exact_once_in_order": exact,
        "positive_control_callback_hex": positive.writes.map(hex),
        "positive_control_exact_once": positivePass,
    ])
    vendorSurface.free()
}

let allPass = passedQueries == queries.count
    && burstPass
    && silencePasses.allSatisfy { $0 }
    && disabledPass
    && vendorPasses == vendorExpectations.count
emit([
    "kind": "summary",
    "query_count": queries.count,
    "exact_once_query_count": passedQueries,
    "vacuous_query_count": queries.filter { $0.expected(surface).isEmpty }.count,
    "ordered_burst_pass": burstPass,
    "silence_policy_count": silencePasses.count,
    "silence_policy_pass_count": silencePasses.filter { $0 }.count,
    "vendor_corpus_count": vendorExpectations.count,
    "vendor_corpus_pass_count": vendorPasses,
    "all_pass": allPass,
])

surface.free()
disabledSurface.free()
enabledPositiveSurface.free()
ghostty_app_free(app)
ghostty_config_free(config)
Darwin.exit(allPass ? 0 : 1)
