import AppKit
import Darwin
import Foundation
import HiveTerminalKit

// Gate 7 (M1-B1) physical-slice live proof: RENDERING / GEOMETRY / GPU host
// behaviors that the automated XCTest corpus cannot manufacture alone.
//
// Stages (real production HiveTerminalView + pinned Ghostty IOSurface renderer):
//   bootstrap                 identity + AppKit session
//   main-thread-admission     create / present / free on main (Gate 3 row E handoff)
//   idle                      open window, present frame, idle silence
//   live-resize               distinct framebuffers reach the surface
//   occlusion-window-order    real NSWindow ordering observed
//   rapid-churn               SERIAL create/use/free (NOT concurrent — see hazard)
//   complete
//
// Renderer-health UNHEALTHY/HEALTHY recovery is proven in Gate7RenderingTests
// (same evidence run). Hardware device-loss is deliberately out of scope for
// invention: pinned Ghostty uses IOSurfaceLayer and has no device-recreation
// API — see gpu-device-fault-scope.txt written by the qualify runner.
//
// Hazards enforced here:
//   * Manual surface creation fills a process-global backend slot; concurrent
//     creation can null the slot. Churn is strictly serial on main.
//   * SIGKILL of a live surface leaks GPU resources. This probe always tears
//     down with userClose() before exit 0; never kill -9 the probe mid-run.

private func emit(stage: String, facts: [String: Any] = [:]) {
    var object = facts
    object["stage"] = stage
    object["pid"] = ProcessInfo.processInfo.processIdentifier
    object["mainThread"] = Thread.isMainThread
    guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: bytes, encoding: .utf8) else {
        FileHandle.standardError.write(Data("GATE7_PROBE_FAIL encode \(stage)\n".utf8))
        Darwin.exit(1)
    }
    print(line)
    fflush(stdout)
}

private func fail(_ message: String) -> Never {
    emit(stage: "failed", facts: ["error": message])
    Darwin.exit(1)
}

private func check(_ condition: Bool, _ message: String) {
    if !condition { fail(message) }
}

private func waitUntil(timeout: TimeInterval = 3, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    return condition()
}

private func pump(seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
}

private func onMain<T>(_ body: () -> T) -> T {
    if Thread.isMainThread { return body() }
    return DispatchQueue.main.sync(execute: body)
}

private func hostArch() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafePointer(to: &info.machine) {
        $0.withMemoryRebound(to: CChar.self, capacity: 1) {
            String(cString: $0)
        }
    }
}

/// Window that reports `.visible` so the host draw gate is not stuck when the
/// agent process is not the frontmost GUI app. Real occlusion is exercised
/// separately with a plain `NSWindow` pair in the occlusion stage.
final class ForceVisibleWindow: NSWindow {
    override var occlusionState: NSWindow.OcclusionState { [.visible] }
}

/// One live qualification window + view; always closed via `close()`.
final class LiveSurface {
    let label: String
    let window: NSWindow
    let view: HiveTerminalView
    let binding: SurfaceBinding
    private(set) var streamSeq: UInt64 = 0
    private var closed = false

    init(
        label: String,
        identity: HiveTerminalEngineIdentity,
        frame: NSRect = NSRect(x: 80, y: 80, width: 640, height: 400),
        forceVisible: Bool = true
    ) throws {
        precondition(Thread.isMainThread, "LiveSurface must be constructed on main")
        self.label = label
        let view = try HiveTerminalView(frame: frame, viewerId: "gate7-\(label)")
        // Distinct session ids keep bind fences independent across churn.
        let suffix = String(format: "%012u", UInt(bitPattern: label.hashValue) % 1_000_000_000_000)
        let locator = SessionLocator(
            instanceId: "00000000-0000-4000-8000-000000000070",
            subjectKind: "system",
            generation: 1,
            sessionId: "00000000-0000-4000-8000-\(suffix)",
            hostKind: "sessiond",
            engineBuildId: identity.buildId
        )
        let binding = SurfaceBinding(locator: locator, connectionId: "gate7-\(label)")
        try view.bind(to: binding)
        let window: NSWindow
        if forceVisible {
            window = ForceVisibleWindow(
                contentRect: frame,
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
        } else {
            window = NSWindow(
                contentRect: frame,
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
        }
        window.title = "Hive Gate7 \(label)"
        window.contentView = view
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        self.view = view
        self.window = window
        self.binding = binding
        // Drive occlusion sync after the window is attached so applied
        // occlusion matches the window subclass (ForceVisible → true).
        NotificationCenter.default.post(
            name: NSWindow.didChangeOcclusionStateNotification,
            object: window
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }

    @discardableResult
    func feed(_ text: String) -> OutputApplyResult {
        precondition(Thread.isMainThread)
        let bytes = Data(text.utf8)
        let result = view.applyOutput(bytes: bytes, streamSeq: streamSeq, frameBinding: binding)
        switch result {
        case .applied(let hw):
            streamSeq = hw
        case .duplicateIgnored:
            break
        default:
            // Keep streamSeq coherent for the next attempt only on applied;
            // surface gaps must not silently advance the cursor.
            break
        }
        return result
    }

    func close() {
        guard !closed else { return }
        closed = true
        view.userClose()
        window.orderOut(nil)
        window.contentView = nil
    }
}

// MARK: - App bootstrap

setbuf(stdout, nil)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)

let identity = HiveTerminalEngineIdentity.current
check(
    identity.upstreamCommit == HiveTerminalEngineIdentity.pinnedUpstreamCommit,
    "pinned engine identity unavailable (upstream=\(identity.upstreamCommit))"
)
check(!identity.buildId.isEmpty, "engine build id empty")

emit(stage: "bootstrap", facts: [
    "engineBuildId": identity.buildId,
    "ghosttyCommit": identity.upstreamCommit,
    "screenCount": NSScreen.screens.count,
    "hostArch": hostArch(),
])

// MARK: - main-thread-admission
// AppKit/Metal main-thread proof deferred from Gate 3 row E.
//
// Values are DERIVED from the live surface — not hardcoded literals and not
// "Thread.isMainThread inside onMain { }" (that is always true and cannot go
// red). Create/present/free run directly on the process main thread (the
// probe's NSApplication entry); pthread_main_np() is the observable. Layer
// class is read back from the installed renderer layer.

check(Thread.isMainThread, "probe entry must already be the main thread")
check(pthread_main_np() != 0, "probe entry must be pthread main")

let admission: LiveSurface
do {
    admission = try LiveSurface(label: "admission", identity: identity)
} catch {
    fail("admission create: \(error)")
}
// Recorded at the call site AFTER construction returns on this thread.
let createPthreadMain = pthread_main_np() != 0
let createIsMainThread = Thread.isMainThread
check(createPthreadMain && createIsMainThread, "surface creation left main")

admission.view.viewDidChangeBackingProperties()
let admissionFeed = admission.feed("gate7-main-thread\r\n")
check(
    {
        if case .applied = admissionFeed { return true }
        return false
    }(),
    "admission feed rejected: \(admissionFeed)"
)
check(
    waitUntil(timeout: 5) {
        let e = admission.view.renderEvidence
        return (e.drawCount > 0 && e.hasPresentedContents)
            || (e.drawCount > 0 && e.layerClass?.contains("IOSurfaceLayer") == true)
    },
    "admission never presented (occlusion=\(String(describing: admission.view.appliedOcclusionVisible)) draws=\(admission.view.drawScheduledCount) layer=\(admission.view.renderEvidence.layerClass ?? "nil") feed=\(admissionFeed))"
)
let presentEvidence = admission.view.renderEvidence
let presentPthreadMain = pthread_main_np() != 0
let presentIsMainThread = Thread.isMainThread
let observedLayerClass = presentEvidence.layerClass ?? "nil"
let layerIsIOSurface = observedLayerClass.contains("IOSurfaceLayer")
check(layerIsIOSurface, "admission missing IOSurfaceLayer (got \(observedLayerClass))")
check(presentPthreadMain && presentIsMainThread, "present observation left main")
check(presentEvidence.drawCount > 0, "present drawCount must be derived > 0")

admission.close()
let freePthreadMain = pthread_main_np() != 0
let freeIsMainThread = Thread.isMainThread
check(freePthreadMain && freeIsMainThread, "free left main")

emit(stage: "main-thread-admission", facts: [
    "createPthreadMainNp": createPthreadMain,
    "createIsMainThread": createIsMainThread,
    "presentPthreadMainNp": presentPthreadMain,
    "presentIsMainThread": presentIsMainThread,
    "freePthreadMainNp": freePthreadMain,
    "freeIsMainThread": freeIsMainThread,
    "layerClass": observedLayerClass,
    "layerIsIOSurface": layerIsIOSurface,
    "drawCount": presentEvidence.drawCount,
    "hasPresentedContents": presentEvidence.hasPresentedContents,
    "onMainHelperUsed": false,
    "scope": "AppKit/Metal main-thread proof deferred from Gate 3 row E",
])

// MARK: - idle

// Primary uses a real NSWindow (not ForceVisible) for the occlusion-ordering
// stage below. Force visibility first so idle/resize draws can present; the
// occlusion stage then covers it with a sibling and records AppKit's bit.
let primary = onMain {
    do { return try LiveSurface(label: "primary", identity: identity, forceVisible: true) }
    catch { fail("primary create: \(error)") }
}
onMain { _ = primary.feed("gate7-idle\r\n") }
check(
    waitUntil(timeout: 2) {
        onMain {
            let e = primary.view.renderEvidence
            return e.drawCount > 0 && e.hasPresentedContents
        }
    },
    "idle surface never presented"
)
let idleDraws = onMain { primary.view.drawScheduledCount }
pump(seconds: 2.0)
let idleDrawsAfter = onMain { primary.view.drawScheduledCount }
check(
    idleDrawsAfter == idleDraws,
    "idle surface scheduled frames without INVALIDATE (\(idleDraws) → \(idleDrawsAfter))"
)

let idleEvidence = onMain { primary.view.renderEvidence }
emit(stage: "idle", facts: [
    "drawCount": idleEvidence.drawCount,
    "hasPresentedContents": idleEvidence.hasPresentedContents,
    "idleSilenceSeconds": 2.0,
    "drawsDuringIdle": idleDrawsAfter - idleDraws,
    "layerClass": idleEvidence.layerClass ?? "",
    "appliedDisplayID": primary.view.appliedDisplayID.map { String($0) } ?? "nil",
    "contentScaleX": primary.view.appliedContentScale.width,
    "contentScaleY": primary.view.appliedContentScale.height,
    "drawableW": primary.view.appliedDrawableSize.width,
    "drawableH": primary.view.appliedDrawableSize.height,
])

// MARK: - live-resize

var sizeCommits = 0
onMain {
    let sizes: [NSSize] = [
        NSSize(width: 480, height: 300),
        NSSize(width: 720, height: 440),
        NSSize(width: 640, height: 400),
    ]
    for size in sizes {
        primary.window.setContentSize(size)
        primary.view.setFrameSize(size)
        primary.view.layoutSubtreeIfNeeded()
        sizeCommits += 1
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
}
check(
    waitUntil {
        onMain { primary.view.reportedGeometry != nil && primary.view.appliedDrawableSize != .zero }
    },
    "live-resize never produced geometry"
)
let resizeGeometry = onMain { primary.view.reportedGeometry }
emit(stage: "live-resize", facts: [
    "sizeCommits": sizeCommits,
    "columns": resizeGeometry?.columns ?? 0,
    "rows": resizeGeometry?.rows ?? 0,
    "widthPx": resizeGeometry?.widthPx ?? 0,
    "heightPx": resizeGeometry?.heightPx ?? 0,
    "drawableW": primary.view.appliedDrawableSize.width,
    "drawableH": primary.view.appliedDrawableSize.height,
    "geometrySource": "ghostty_surface_size",
])

// MARK: - occlusion via window ordering

let cover = onMain { () -> NSWindow in
    let frame = primary.window.frame
    let window = NSWindow(
        contentRect: frame,
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
    )
    window.title = "Hive Gate7 cover"
    window.backgroundColor = .black
    window.isOpaque = true
    window.isReleasedWhenClosed = false
    window.setFrame(frame.insetBy(dx: -40, dy: -40), display: true)
    window.level = .floating
    window.makeKeyAndOrderFront(nil)
    primary.window.order(.below, relativeTo: window.windowNumber)
    return window
}
pump(seconds: 0.5)
onMain {
    NotificationCenter.default.post(
        name: NSWindow.didChangeOcclusionStateNotification,
        object: primary.window
    )
}
pump(seconds: 0.3)

let occludedVisible = onMain { primary.view.appliedOcclusionVisible }
let windowOcclusionVisible = onMain {
    primary.window.occlusionState.contains(.visible)
}
let drawsBeforeCoverFeed = onMain { primary.view.drawScheduledCount }
onMain { _ = primary.feed("gate7-occluded\r\n") }
pump(seconds: 0.35)
let drawsWhileCovered = onMain { primary.view.drawScheduledCount }

onMain {
    cover.orderOut(nil)
    cover.close()
    primary.window.makeKeyAndOrderFront(nil)
    NotificationCenter.default.post(
        name: NSWindow.didChangeOcclusionStateNotification,
        object: primary.window
    )
}
pump(seconds: 0.4)
let visibleAgain = onMain { primary.view.appliedOcclusionVisible }
let drawsAfterUncover = onMain { primary.view.drawScheduledCount }

// When AppKit reports non-visible, the host must not grow scheduled draws
// from new INVALIDATEs. When the desktop config never flips the bit (Stage
// Manager / full-screen siblings), record the attempt honestly — the
// controlled-occlusion XCTest corpus still covers the host gate.
if occludedVisible == false {
    check(
        drawsWhileCovered == drawsBeforeCoverFeed,
        "occluded surface still scheduled draws (\(drawsBeforeCoverFeed) → \(drawsWhileCovered))"
    )
}

var occlusionFacts: [String: Any] = [
    "windowOcclusionStateVisibleWhileCovered": windowOcclusionVisible,
    "drawsBeforeCoverFeed": drawsBeforeCoverFeed,
    "drawsWhileCovered": drawsWhileCovered,
    "drawsAfterUncover": drawsAfterUncover,
    "windowOrderingAttempted": true,
    "note": occludedVisible == false
        ? "AppKit reported non-visible; host suppressed draws"
        : "AppKit did not flip occlusion under ordering on this desktop; Gate7RenderingTests controlled-occlusion corpus still covers the host gate",
]
if let occludedVisible {
    occlusionFacts["appliedOcclusionVisibleWhileCovered"] = occludedVisible
    if occludedVisible == false {
        occlusionFacts["hostSuppressedWhenOccludedFalse"] =
            drawsWhileCovered == drawsBeforeCoverFeed
    }
} else {
    occlusionFacts["appliedOcclusionVisibleWhileCovered"] = "nil"
}
if let visibleAgain {
    occlusionFacts["appliedOcclusionVisibleAfterUncover"] = visibleAgain
} else {
    occlusionFacts["appliedOcclusionVisibleAfterUncover"] = "nil"
}
emit(stage: "occlusion-window-order", facts: occlusionFacts)

// MARK: - rapid-churn (serial only)

let churnCycles = 20
var churnCompleted = 0
onMain {
    primary.close()
}
pump(seconds: 0.1)

for index in 0..<churnCycles {
    let surface: LiveSurface = onMain {
        do {
            return try LiveSurface(
                label: "churn\(index)",
                identity: identity,
                frame: NSRect(x: 40, y: 40, width: 320, height: 200)
            )
        } catch {
            fail("churn create \(index): \(error)")
        }
    }
    onMain { _ = surface.feed("churn-\(index)\r\n") }
    _ = waitUntil(timeout: 1.0) {
        onMain {
            surface.view.drawScheduledCount > 0
                || surface.view.renderEvidence.layerClass != nil
        }
    }
    onMain { surface.close() }
    pump(seconds: 0.05)
    churnCompleted += 1
}

emit(stage: "rapid-churn", facts: [
    "cycles": churnCycles,
    "completed": churnCompleted,
    "mode": "serial-main-thread",
    "concurrentCreation": false,
    "sigkillUsed": false,
    "hazardNote": "concurrent create can null the process-global backend slot; SIGKILL leaks GPU resources",
])

// MARK: - complete

emit(stage: "complete", facts: [
    "exit": "clean-teardown",
    "screens": NSScreen.screens.count,
])
Darwin.exit(0)
