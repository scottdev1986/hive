/** The queen's `orchestrator` permission set, defined once. The role is three facts: - She may edit `.hive/` within the repository she runs in (her own memory). - She may use the GitHub CLI (`gh`) in Bash for board management. - She never authors implementation code: implementation is always delegated to workers. No vendor's permission language can scope "docs" from "code" perfectly (claude and opencode come closest with path globs), so what the native grants below cannot express rides in cli/queen-policy.ts. Each vendor expresses this natively where the grant is written: claude in writeClaudeAgentConfig's orchestrator branch, opencode in writeOpencodeAgentConfig's orchestrator branch. Codex (sandbox flags), grok, and kimi have no path- or command-scoped grant channel, so their mapping is chosen at the launch arm in cli/orchestrator.ts. */
export const ORCHESTRATOR_WRITABLE_GLOBS = [".hive/**"] as const;

export const ORCHESTRATOR_CLAUDE_WRITE_RULES: readonly string[] =
  ORCHESTRATOR_WRITABLE_GLOBS.flatMap((glob) => [
    `Edit(${glob})`,
    `Write(${glob})`,
  ]);

/** opencode's permission objects are glob → action with last match winning, so the wildcard denial comes first and the role's paths re-allow. Bash is scoped to gh exactly as claude's `Bash(gh:*)` is; anything else asks the user, which an attended root can answer. */
export const ORCHESTRATOR_OPENCODE_PERMISSION = {
  edit: {
    "*": "deny",
    ...Object.fromEntries(
      ORCHESTRATOR_WRITABLE_GLOBS.map((glob) => [glob, "allow"]),
    ),
  },
  bash: { "*": "ask", "gh *": "allow" },
} as const;
