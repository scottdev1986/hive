import AppKit
import Darwin
import Foundation
import HiveTerminalKit

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("B20_PROBE_FAIL \(message)\n".utf8))
    Darwin.exit(1)
}

private func emit(stage: String, facts: [String: Any] = [:]) {
    var object = facts
    object["stage"] = stage
    object["pid"] = ProcessInfo.processInfo.processIdentifier
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else {
        fail("could not encode \(stage)")
    }
    print(line)
    fflush(stdout)
}

private func awaitNext() {
    guard readLine() == "next" else { fail("qualification controller disconnected") }
}

private func waitUntil(timeout: TimeInterval = 3, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    return condition()
}

setbuf(stdout, nil)
emit(stage: "before")
awaitNext()

let identity = HiveTerminalEngineIdentity.current
guard identity.upstreamCommit == HiveTerminalEngineIdentity.pinnedUpstreamCommit,
      !identity.buildId.isEmpty else {
    fail("pinned engine identity unavailable")
}

let view: HiveTerminalView
do {
    view = try HiveTerminalView(
        frame: NSRect(x: 0, y: 0, width: 640, height: 360),
        viewerId: "b2-live-proof"
    )
} catch {
    fail("production view creation: \(error)")
}
let locator = SessionLocator(
    instanceId: "00000000-0000-4000-8000-000000000020",
    subjectKind: "system",
    generation: 1,
    sessionId: "00000000-0000-4000-8000-000000000021",
    hostKind: "sessiond",
    engineBuildId: identity.buildId
)
let binding = SurfaceBinding(locator: locator, connectionId: "b2-manual-replay")
do {
    try view.bind(to: binding)
} catch {
    fail("exact binding: \(error)")
}
let created = view.renderEvidence
guard created.layerClass?.contains("IOSurfaceLayer") == true else {
    fail("pinned renderer did not install IOSurfaceLayer")
}
emit(stage: "create", facts: [
    "engineBuildId": identity.buildId,
    "ghosttyCommit": identity.upstreamCommit,
    "layerClass": created.layerClass ?? "",
    "locatorGeneration": locator.generation,
    "locatorSessionId": locator.sessionId,
])
awaitNext()

let chunks = [
    Data("\u{1B}[2J\u{1B}[HHive B2 neutral replay\r\n".utf8),
    Data("\u{1B}[38;5;39mmanual-I/O display copy\u{1B}[0m\r\n".utf8),
    Data("\u{1B}[5n\u{1B}[c\u{1B}[>c\u{1B}[=c\u{1B}[>q\u{1B}P$qm\u{1B}\\\u{1B}P+q544E\u{1B}\\".utf8),
]
var sequence: UInt64 = 0
for chunk in chunks {
    let result = view.applyOutput(bytes: chunk, streamSeq: sequence, frameBinding: binding)
    guard result == .applied(newHighWater: sequence + UInt64(chunk.count)) else {
        fail("ordered output at \(sequence): \(result)")
    }
    sequence += UInt64(chunk.count)
}
guard waitUntil({
    let evidence = view.renderEvidence
    return evidence.drawCount > 0 && evidence.hasPresentedContents
}) else {
    fail("neutral replay never presented")
}
let rendered = view.renderEvidence
guard rendered.highWater == sequence, rendered.locator == locator else {
    fail("render evidence lost exact locator/high-water")
}
emit(stage: "use", facts: [
    "drawCount": rendered.drawCount,
    "hasPresentedContents": rendered.hasPresentedContents,
    "highWater": String(rendered.highWater),
    "layerClass": rendered.layerClass ?? "",
    "orderedChunkCount": chunks.count,
])
awaitNext()

view.userClose()
emit(stage: "free", facts: [
    "surfaceState": String(describing: view.surfaceState),
    "hasPresentedContents": view.renderEvidence.hasPresentedContents,
])
awaitNext()
emit(stage: "done")
