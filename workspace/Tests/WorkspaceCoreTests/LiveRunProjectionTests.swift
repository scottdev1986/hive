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

    @Test("Queen is the first attachable session from the orchestrator snapshot")
    func queenIsFirstSessionFromOrchestrator() throws {
        let line = try #require(FeedLine.parse(
            """
            {"v":1,"agents":[{"id":"id-a","name":"david","tool":"codex","status":"idle",
             "sessionLocator":{"schemaVersion":1,"instanceId":"rig",
               "subject":{"kind":"agent","agentId":"id-a"},"generation":2,
               "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000002",
               "hostKind":"sessiond","engineBuildId":"engine"}}],
             "orchestrator":{"name":"queen","status":"working","host":"sessiond","hostState":"running",
               "sessionLocator":{"schemaVersion":1,"instanceId":"rig",
                 "subject":{"kind":"root"},"generation":6,
                 "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000001",
                 "hostKind":"sessiond","engineBuildId":"engine"},
               "presentation":{"panePresence":"visible","terminalState":"live",
                 "headerDetail":"working","paneStatus":{"kind":"running"},
                 "activity":"working"}}}
            """))

        let projection = try LiveRunProjection(feedLine: line)

        #expect(projection.sessions.count == 2)
        let queen = try #require(projection.sessions.first)
        #expect(queen.isQueen)
        #expect(queen.name == "queen")
        #expect(queen.agentID == "root")
        #expect(queen.locator?.subject.kind == "root")
        #expect(queen.locator?.generation == 6)
        #expect(projection.sessions[1].name == "david")
    }

    @Test("Queen provider and model preserve orchestrator wire presence and absence")
    func queenProviderAndModelPreserveWirePresenceAndAbsence() throws {
        let absentLine = try #require(FeedLine.parse(
            #"{"v":1,"agents":[],"orchestrator":{"name":"queen","status":"working","host":"sessiond","hostState":"running","hostDiagnostic":null,"sessionLocator":null}}"#))
        let absent = try #require(
            LiveRunProjection(feedLine: absentLine).sessions.first)

        #expect(absent.provider == nil)
        #expect(absent.model == nil)
        #expect(absent.task == nil)
        #expect(absent.activity == .unknown)

        let presentLine = try #require(FeedLine.parse(
            #"{"v":1,"agents":[],"orchestrator":{"name":"wire-queen","status":"working","tool":"codex","model":"gpt-5.6-sol","host":"sessiond","hostState":"running","hostDiagnostic":null,"sessionLocator":null}}"#))
        let present = try #require(
            LiveRunProjection(feedLine: presentLine).sessions.first)

        #expect(present.name == "wire-queen")
        #expect(present.provider == ProviderID("codex"))
        #expect(present.model == "gpt-5.6-sol")
        #expect(present.task == nil)
    }

    @Test("An agent without a reported provider preserves absence")
    func agentWithoutProviderPreservesAbsence() throws {
        let line = try #require(FeedLine.parse(
            #"{"v":1,"agents":[{"id":"id-a","name":"a","status":"idle"}]}"#))
        let session = try #require(
            LiveRunProjection(feedLine: line).sessions.first)

        #expect(session.provider == nil)
    }

    @Test("Agent construction never invents a working status")
    func agentConstructionNeverInventsWorkingStatus() {
        #expect(AgentSnapshot(name: "a").status == "unknown")
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

    @Test("Decodes exact Live Run process-control facts and refuses impossible variants")
    func controlProjection() throws {
        let data = Data(#"""
        {"schemaVersion":1,"observedAt":"2026-08-15T20:00:00.000Z",
         "agentId":"id-a","agentName":"a","provider":"codex",
         "locator":{"schemaVersion":1,"instanceId":"rig",
           "subject":{"kind":"agent","agentId":"id-a"},"generation":3,
           "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000001",
           "hostKind":"sessiond","engineBuildId":"engine"},
         "providerRun":{"state":"running","runId":"018f1e90-7b5a-7cc0-8000-000000000902",
           "provider":"codex","process":{"pid":4100,"startToken":"4100:1",
           "processGroupId":4100,"observedAt":"2026-08-15T20:00:00.000Z"}},
         "shell":{"state":"retained","root":{"pid":4000,"startToken":"4000:1",
           "processGroupId":4000},"foreground":"provider"},
         "processCensus":{"state":"complete","source":"sessiond-process-tree",
           "members":[{"pid":4000,"startToken":"4000:1"},{"pid":4100,"startToken":"4100:1"}],
           "observedAt":"2026-08-15T20:00:00.000Z"},
         "termination":{"state":"not-requested"},
         "controls":{"stopProvider":{"enabled":true,"reason":null},
           "terminateTerminal":{"enabled":true,"reason":null}}}
        """#.utf8)

        let projection = try JSONDecoder().decode(
            LiveRunControlProjection.self, from: data)

        #expect(projection.locator.generation == 3)
        #expect(projection.providerRun.runID?.hasPrefix("018f1e90") == true)
        #expect(projection.providerRun.process?.pid == 4100)
        #expect(projection.shell.root?.pid == 4000)
        #expect(projection.shell.foreground == .provider)
        #expect(projection.processCensus.members.count == 2)
        #expect(projection.termination.state == .notRequested)
        #expect(projection.controls.stopProvider.enabled)
        #expect(projection.controls.terminateTerminal.enabled)

        let impossible = Data(String(decoding: data, as: UTF8.self)
            .replacingOccurrences(
                of: #"{"state":"not-requested"}"#,
                with: #"{"state":"not-requested","completedAt":"2026-08-15T20:00:00.000Z"}"#)
            .utf8)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(LiveRunControlProjection.self, from: impossible)
        }
    }
}
