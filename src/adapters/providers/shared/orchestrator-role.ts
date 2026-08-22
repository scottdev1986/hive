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
