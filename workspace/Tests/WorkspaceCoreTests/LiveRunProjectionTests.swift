import Foundation
import Testing
@testable import WorkspaceCore

@Suite("Live Run projection")
struct LiveRunProjectionTests {
    @Test("Strictly refuses an unknown workspace-feed schema version")
    func strictVersion() throws {
        let line = try #require(FeedLine.parse(#"{"v":2,"agents":[]}"#))

        #expect(throws: LiveRunFeedError.unsupportedSchemaVersion(2)) {
            try LiveRunProjection(feedLine: line)
        }
    }

    @Test("Maps all five providers without creating terminal facts for absent contracts")
    func fiveProvidersAndAbsentContracts() throws {
        let providers = ["claude", "codex", "grok", "kimi", "opencode"]
        let agents = providers.enumerated().map { index, provider in
            """
            {"id":"id-\(index)","name":"agent-\(index)","tool":"\(provider)",
             "model":"model-\(index)","status":"idle","sessionLocator":{
               "schemaVersion":1,"instanceId":"rig","subject":{"kind":"agent","agentId":"id-\(index)"},
               "generation":\(index + 1),"sessionId":"ses_018f1e90-7b5a-7cc0-8000-00000000000\(index)","hostKind":"sessiond",
               "engineBuildId":"engine"}}
            """
        }.joined(separator: ",")
        let line = try #require(FeedLine.parse("{\"v\":1,\"agents\":[\(agents)]}"))

        let projection = try LiveRunProjection(feedLine: line)

        #expect(projection.schemaVersion == 1)
        #expect(projection.sessions.map(\.provider) == providers.map { ProviderID($0) })
        #expect(projection.sessions.allSatisfy { $0.locator != nil })
        #expect(projection.sessions.allSatisfy { $0.providerRun.label == "absent" })
        #expect(projection.sessions.allSatisfy { $0.termination.label == "unknown" })
        #expect(projection.sessions.allSatisfy {
            $0.termination.reason.contains("process-tree-escapees-unaccounted")
        })
    }

    @Test("An incomplete locator stays visible as unknown and never attachable")
    func incompleteLocator() throws {
        let line = try #require(FeedLine.parse(
            #"{"v":1,"agents":[{"id":"id-1","name":"a","tool":"new-vendor","status":"new-state","sessionLocator":{"schemaVersion":1,"instanceId":"rig","subject":{"kind":"agent","agentId":"id-1"},"generation":1,"sessionId":"ses","hostKind":"sessiond","engineBuildId":null}}]}"#))

        let projection = try LiveRunProjection(feedLine: line)
        let session = try #require(projection.sessions.first)

        #expect(session.activity == .unknown)
        #expect(session.provider == ProviderID("new-vendor"))
        #expect(session.locator == nil)
        #expect(session.locatorFact?.label == "unknown")
    }

    @Test("A terminal locator must be bound to the exact nonempty agent and instance")
    func locatorIdentityBinding() {
        let cases = [
            ("id-1", "rig", AgentSessionSubject(kind: "agent", agentId: "other")),
            ("id-1", "rig", AgentSessionSubject(kind: "root")),
            ("", "rig", AgentSessionSubject(kind: "agent", agentId: "")),
            ("id-1", "", AgentSessionSubject(kind: "agent", agentId: "id-1")),
        ]

        for (id, instanceID, subject) in cases {
            let session = LiveRunSessionSummary(agent: AgentSnapshot(
                id: id,
                name: "worker",
                status: "idle",
                sessionLocator: AgentSessionLocator(
                    instanceId: instanceID,
                    subject: subject,
                    generation: 1,
                    sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000001",
                    hostKind: "sessiond",
                    engineBuildId: "engine")))
            #expect(session.locator == nil)
            #expect(session.locatorFact?.label == "unknown")
        }
    }
}
