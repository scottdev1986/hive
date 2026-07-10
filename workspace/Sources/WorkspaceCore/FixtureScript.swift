import Foundation

/// Realistic fixture data for the transcript prototype. Every hard case the
/// blueprint's prototype hypothesis 2 names is present: streaming partial
/// messages, huge tool output, ANSI content, missing provider fields,
/// approvals, and inline diffs — across two multiplexed projects.
public enum FixtureScript {

    public static let hiveProject: ProjectID = "hive"
    public static let docsProject: ProjectID = "docs-site"

    public static func standard() -> [ScriptedEvent] {
        var events: [ScriptedEvent] = []
        let hive = hiveProject
        let docs = docsProject

        // ---- Project "hive": orchestrator arrives and streams its plan.
        events.append(ScriptedEvent(0.0, hive, "orchestrator",
            .sessionStarted(title: "orchestrator", kind: .orchestrator, model: "claude-fable-5")))
        let plan = [
            "Reading the workspace blueprint before assigning work.\n\n",
            "Plan for this session:\n",
            "1. `indexer` rebuilds the symbol index (large output expected).\n",
            "2. `styler` runs the lint/format pipeline (ANSI logs).\n",
            "3. `migrator` prepares the settings schema migration — it will need an approval before touching disk.\n",
            "4. `flaky-e2e` re-runs the failing end-to-end suite to capture the failure.\n\n",
            "Spawning workers now.",
        ]
        for (index, delta) in plan.enumerated() {
            events.append(ScriptedEvent(index == 0 ? 0.3 : 0.25, hive, "orchestrator",
                .messageDelta(messageID: "orc-plan", role: .assistant, text: delta, model: "claude-fable-5")))
        }
        events.append(ScriptedEvent(0.2, hive, "orchestrator", .messageCompleted(messageID: "orc-plan")))

        // ---- Workers appear (least-disruptive splits, no focus stealing).
        events.append(ScriptedEvent(0.4, hive, "indexer",
            .sessionStarted(title: "indexer", kind: .worker, model: "claude-sonnet-5")))
        events.append(ScriptedEvent(0.3, hive, "styler",
            .sessionStarted(title: "styler", kind: .worker, model: "claude-haiku-4-5")))
        events.append(ScriptedEvent(0.3, hive, "migrator",
            .sessionStarted(title: "migrator", kind: .worker, model: "claude-sonnet-5")))
        events.append(ScriptedEvent(0.3, hive, "flaky-e2e",
            .sessionStarted(title: "flaky-e2e", kind: .worker, model: nil))) // missing model field

        // ---- indexer: huge tool output (collapsed by default in the UI).
        events.append(ScriptedEvent(0.5, hive, "indexer",
            .messageDelta(messageID: "idx-1", role: .assistant,
                          text: "Rebuilding the symbol index across all targets.", model: nil))) // missing model
        events.append(ScriptedEvent(0.1, hive, "indexer", .messageCompleted(messageID: "idx-1")))
        events.append(ScriptedEvent(0.2, hive, "indexer",
            .toolCallStarted(callID: "idx-scan", name: "Bash", input: "rg --files | xargs ctags --output-format=json")))
        for chunk in 0..<5 {
            let lines = (0..<1_000).map { line in
                let n = chunk * 1_000 + line
                return "{\"symbol\":\"sym_\(n)\",\"path\":\"Sources/Module\(n % 37)/File\(n % 211).swift\",\"line\":\(n % 4000 + 1),\"kind\":\"\(n % 3 == 0 ? "func" : "type")\"}"
            }.joined(separator: "\n")
            events.append(ScriptedEvent(0.15, hive, "indexer",
                .toolOutput(callID: "idx-scan", chunk: lines + "\n", isANSI: false)))
        }
        events.append(ScriptedEvent(0.2, hive, "indexer", .toolCallCompleted(callID: "idx-scan", exitCode: 0)))

        // ---- styler: ANSI-heavy build/lint log.
        events.append(ScriptedEvent(0.2, hive, "styler",
            .toolCallStarted(callID: "sty-lint", name: "Bash", input: "swiftlint --strict && swift-format lint -r Sources")))
        let ansiLog = [
            "\u{1B}[1m\u{1B}[34m==>\u{1B}[0m Linting 214 files\n",
            "\u{1B}[32m✓\u{1B}[0m Sources/WorkspaceCore/LayoutTree.swift\n",
            "\u{1B}[32m✓\u{1B}[0m Sources/WorkspaceCore/Attention.swift\n",
            "\u{1B}[33mwarning:\u{1B}[0m Sources/HiveWorkspace/PaneView.swift:88 \u{1B}[4mline_length\u{1B}[0m line is 134 characters\n",
            "\u{1B}[31merror:\u{1B}[0m Sources/HiveWorkspace/Old.swift:12 \u{1B}[1mforce_unwrap\u{1B}[0m — \u{1B}[38;5;208mforce unwraps are banned\u{1B}[0m\n",
            "\u{1B}[38;2;120;200;90mCustom truecolor status: pipeline healthy\u{1B}[0m\n",
            "\u{1B}[1mDone.\u{1B}[0m 1 error, 1 warning\n",
        ]
        for (index, chunk) in ansiLog.enumerated() {
            events.append(ScriptedEvent(index == 0 ? 0.3 : 0.12, hive, "styler",
                .toolOutput(callID: "sty-lint", chunk: chunk, isANSI: true)))
        }
        events.append(ScriptedEvent(0.2, hive, "styler", .toolCallCompleted(callID: "sty-lint", exitCode: 1)))
        events.append(ScriptedEvent(0.3, hive, "styler",
            .messageDelta(messageID: "sty-2", role: .assistant,
                          text: "Fixed the force unwrap and re-ran clean. Formatting is consistent.",
                          model: "claude-haiku-4-5")))
        events.append(ScriptedEvent(0.1, hive, "styler", .messageCompleted(messageID: "sty-2")))
        events.append(ScriptedEvent(0.2, hive, "styler", .agentCompleted(summary: "lint + format clean")))

        // ---- migrator: inline diff + approval request (amber waiting).
        let migrationDiff = DiffPayload(filePath: "src/settings/schema.ts", hunks: [
            DiffHunk(header: "@@ -12,7 +12,9 @@ export const settingsSchema = {", lines: [
                .init(kind: .context, text: "  landingBranch: z.string().default(\"main\"),"),
                .init(kind: .deletion, text: "  terminalApp: z.enum([\"Terminal\", \"iTerm2\"]),"),
                .init(kind: .addition, text: "  workspaceUI: z.enum([\"native\", \"legacy\"]).default(\"native\"),"),
                .init(kind: .addition, text: "  reduceMotion: z.boolean().optional(),"),
                .init(kind: .addition, text: "  masterRatio: z.number().min(0.55).max(0.6).default(0.58),"),
                .init(kind: .context, text: "  quotaPool: z.string().optional(),"),
            ]),
        ])
        events.append(ScriptedEvent(0.4, hive, "migrator",
            .messageDelta(messageID: "mig-1", role: .assistant,
                          text: "Schema migration drafted. This rewrites settings on disk, so I'm requesting approval before applying.",
                          model: "claude-sonnet-5")))
        events.append(ScriptedEvent(0.1, hive, "migrator", .messageCompleted(messageID: "mig-1")))
        events.append(ScriptedEvent(0.2, hive, "migrator", .diffProduced(migrationDiff)))
        events.append(ScriptedEvent(0.3, hive, "migrator",
            .approvalRequested(approvalID: "appr-schema-migration",
                               title: "Apply settings schema migration",
                               detail: "Rewrites ~/.hive/config.toml to schema v3. Backup is taken first.",
                               diff: migrationDiff)))

        // ---- flaky-e2e: failure (red badge), then a disconnect elsewhere.
        events.append(ScriptedEvent(0.5, hive, "flaky-e2e",
            .toolCallStarted(callID: "e2e-run", name: "Bash", input: "bun test e2e/spawn-terminal.test.ts")))
        events.append(ScriptedEvent(0.4, hive, "flaky-e2e",
            .toolOutput(callID: "e2e-run",
                        chunk: "\u{1B}[31m✗ spawn places window on second display (timed out after 30000ms)\u{1B}[0m\nExpected pane frame {x:1512...} but window never appeared.\n",
                        isANSI: true)))
        events.append(ScriptedEvent(0.2, hive, "flaky-e2e", .toolCallCompleted(callID: "e2e-run", exitCode: 1)))
        events.append(ScriptedEvent(0.2, hive, "flaky-e2e",
            .agentFailed(error: "e2e: spawn-terminal timed out — Terminal PID lookup failed (see SPEC.md defect)")))

        // indexer wraps up (green until acknowledged)...
        events.append(ScriptedEvent(0.3, hive, "indexer",
            .messageDelta(messageID: "idx-2", role: .assistant,
                          text: "Index rebuilt: 5,000 symbols across 211 files.", model: "claude-sonnet-5")))
        events.append(ScriptedEvent(0.1, hive, "indexer", .messageCompleted(messageID: "idx-2")))
        events.append(ScriptedEvent(0.2, hive, "indexer", .agentCompleted(summary: "symbol index rebuilt")))
        // ...then its host drops (gray dashed).
        events.append(ScriptedEvent(0.8, hive, "indexer", .disconnected(reason: "AgentHost connection lost (mock)")))

        // ---- Project "docs-site": second multiplexed window, small team.
        events.append(ScriptedEvent(0.3, docs, "orchestrator",
            .sessionStarted(title: "orchestrator", kind: .orchestrator, model: "claude-fable-5")))
        events.append(ScriptedEvent(0.2, docs, "orchestrator",
            .messageDelta(messageID: "doc-orc-1", role: .assistant,
                          text: "One task queued: refresh the API reference. Spawning `api-docs`.", model: "claude-fable-5")))
        events.append(ScriptedEvent(0.1, docs, "orchestrator", .messageCompleted(messageID: "doc-orc-1")))
        events.append(ScriptedEvent(0.3, docs, "api-docs",
            .sessionStarted(title: "api-docs", kind: .worker, model: "claude-haiku-4-5")))
        events.append(ScriptedEvent(0.3, docs, "api-docs",
            .toolCallStarted(callID: "docgen", name: "Bash", input: "bun run docs:generate")))
        events.append(ScriptedEvent(0.3, docs, "api-docs",
            .toolOutput(callID: "docgen", chunk: "Generated 48 pages in 3.2s\n", isANSI: false)))
        events.append(ScriptedEvent(0.1, docs, "api-docs", .toolCallCompleted(callID: "docgen", exitCode: 0)))
        events.append(ScriptedEvent(0.2, docs, "api-docs", .agentCompleted(summary: "API reference refreshed")))

        // ---- Orchestrator follow-up referencing the waiting approval, with a link.
        events.append(ScriptedEvent(0.4, hive, "orchestrator",
            .messageDelta(messageID: "orc-2", role: .assistant,
                          text: "`migrator` is blocked on your approval. Diff rationale: https://example.com/hive/schema-v3. `flaky-e2e` reproduced the Terminal PID defect — details in its pane.",
                          model: nil))) // missing model field on a later turn
        events.append(ScriptedEvent(0.1, hive, "orchestrator", .messageCompleted(messageID: "orc-2")))

        return events
    }
}
