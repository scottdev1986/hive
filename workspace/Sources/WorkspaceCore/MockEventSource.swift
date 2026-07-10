import Foundation

/// A scripted structured event stream: the stand-in for the future
/// Broker→UI snapshot/event feed. Deterministic content; timing is either
/// scheduled (app) or fast-forwarded (tests, smoke runs).
public struct ScriptedEvent {
    public let delay: TimeInterval // seconds after the previous event
    public let projectID: ProjectID
    public let paneID: PaneID
    public let payload: AgentEvent

    public init(_ delay: TimeInterval, _ projectID: ProjectID, _ paneID: PaneID, _ payload: AgentEvent) {
        self.delay = delay
        self.projectID = projectID
        self.paneID = paneID
        self.payload = payload
    }
}

public final class MockEventSource {
    public let script: [ScriptedEvent]
    private var sequenceByPane: [PaneID: Int] = [:]
    private var cursor = 0
    private var virtualClock: TimeInterval = 0

    public init(script: [ScriptedEvent]) {
        self.script = script
    }

    public var isFinished: Bool { cursor >= script.count }

    /// Delay before the next event, nil when the script is done.
    public var nextDelay: TimeInterval? {
        isFinished ? nil : script[cursor].delay
    }

    /// Consumes the next scripted event, stamping envelope sequence + a
    /// virtual timestamp. Roughly one in six events omits its timestamp to
    /// exercise the missing-provider-fields path.
    public func next() -> AgentEventEnvelope? {
        guard cursor < script.count else { return nil }
        let scripted = script[cursor]
        cursor += 1
        virtualClock += scripted.delay
        let sequence = (sequenceByPane[scripted.paneID] ?? 0) + 1
        sequenceByPane[scripted.paneID] = sequence
        let omitTimestamp = cursor % 6 == 0
        return AgentEventEnvelope(
            projectID: scripted.projectID,
            paneID: scripted.paneID,
            sequence: sequence,
            timestamp: omitTimestamp ? nil : virtualClock,
            payload: scripted.payload)
    }

    /// Drains every remaining event immediately (tests and smoke mode).
    public func fastForward(_ handle: (AgentEventEnvelope) -> Void) {
        while let envelope = next() {
            handle(envelope)
        }
    }
}
