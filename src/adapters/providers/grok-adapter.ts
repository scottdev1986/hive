import {
  grokUntrustedWorktreeRefusal,
  inspectGrokProjectTrust,
  repositoryRootForWorktree,
  seedGrokRepositoryTrust,
  writeGrokAgentConfig,
} from "./grok-cli";
import { definedFields } from "../../shared/defined-fields";
import type { AgentAdapter } from "./provider-adapter";

export const grokAgentAdapter: AgentAdapter = {
  id: "grok",
  // Project hooks cover session, turn, tool, failure, and compaction events, but only fire once the user trusts the worktree — that is Grok's own behaviour, not a gate Hive applies. Hive writes the config unconditionally and only REPORTS what trust it observed; it never writes grok's trust store, which is the user's. Trust does NOT only cost evidence, though, and treating it as if it did is what made every grok spawn into an untrusted repository die 30 seconds in. The same decision governs repo-local MCP servers, and Hive's own MCP server is one — so an untrusted worktree cannot reach the daemon at all, and the spawn is refused (see prepareRuntime). Degrading is only available where there is something left to run on; here there is not. updates.jsonl remains the only structured interrupted source, and approval-waiting remains terminal-only.
  communication: {
    provider: "grok",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: true,
    turnBoundaryEvents: true,
    transcriptReader: true,
    nativeCancel: false,
    conversationResume: true,
  },
  /** Opening Hive on a repository IS the trust decision, so record it in grok's own store before the config write that would otherwise make the worktree untrusted. Grok ignores an entry keyed to a nested git root, so the grant has to name the repository — see `seedGrokRepositoryTrust`, which spells out what that widens. Best-effort by construction: a store Hive cannot write leaves the spawn to the trust check in `prepareRuntime`, which refuses with the manual remedy rather than launching an agent that cannot report. */
  async prepareWorktree(worktreePath) {
    const repositoryRoot = repositoryRootForWorktree(worktreePath);
    if (repositoryRoot === null) return;
    const outcome = await seedGrokRepositoryTrust(repositoryRoot);
    if (outcome === "seeded") {
      console.warn(
        `Hive recorded ${repositoryRoot} as trusted for Grok, because you ` +
          "opened Hive on it. Grok will not start Hive's MCP server in an " +
          "untrusted folder, and this also trusts that repository for your own " +
          "`grok` runs there. Remove the entry from " +
          "~/.grok/trusted_folders.toml to undo it.",
      );
    } else if (outcome === "unwritable") {
      // Say so. A silent failure here surfaces later as a refusal naming a repository Hive believes it just trusted, which reads as a bug in the refusal rather than in the write that never happened.
      console.warn(
        `Hive could not record ${repositoryRoot} in Grok's trust store; the ` +
          "spawn will refuse with the manual remedy if Grok still reports the " +
          "worktree untrusted.",
      );
    }
  },
  async prepareRuntime(context) {
    if (context.providerRunId === undefined) {
      throw new Error("Grok launch requires a provider run id");
    }
    await writeGrokAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      providerRunId: context.providerRunId,
      ...definedFields({
        hiveCommand: context.hiveCommand,
        graphifyUrl: context.graphifyUrl,
      }),
    });
    if (context.executable !== undefined) {
      // AFTER the config write, deliberately. The write is what puts a repo-local MCP table in the folder, and that is the capability grok's trust decision governs: a fresh worktree reads `trusted` before it and `untrusted` after, unless an ancestor already carries a decision. Inspecting first would always answer `trusted` and prove nothing.
      const trust = inspectGrokProjectTrust(
        context.worktreePath,
        context.executable,
      );
      if (trust === "untrusted") {
        // Not a warning. Trust withholds the MCP server, not just the hooks — and an agent that cannot reach Hive's MCP surface is refused anyway after a launch that already looked alive. Refusing here costs a spawn that was never going to work and reports the gate instead of the symptom.
        throw new Error(
          grokUntrustedWorktreeRefusal(
            context.name,
            context.worktreePath,
            repositoryRootForWorktree(context.worktreePath),
          ),
        );
      }
      if (trust === "trusted") {
        console.warn(
          // Name settings.local.json first: it is the file that actually exists in a Hive worktree (see the worktree wiring list), so warning only about settings.json named the file least likely to fire.
          `Grok reads project .claude/settings.local.json and .claude/settings.json ` +
            `hooks in trusted worktrees; any such hooks in ${context.worktreePath} ` +
            "are user-owned and may also fire.",
        );
      } else {
        console.warn(
          `Hive could not verify Grok hook trust for ${context.worktreePath}; ` +
            "the agent will run normally using updates.jsonl, terminal, and process evidence.",
        );
      }
    }
    return { argv: [] };
  },
};
