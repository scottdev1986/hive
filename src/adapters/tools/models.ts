import { homedir } from "node:os";
import { join } from "node:path";
import type { Route } from "../../schemas";

// The claude CLI resolves the "best" alias internally — no local config file
// records the mapping, so it cannot be read at spawn time. Verified against
// claude 2.1.206 on 2026-07-09: `claude --model best` bills usage to
// claude-fable-5. Re-verify when the CLI's top model changes.
export const CLAUDE_BEST_MODEL = "claude-fable-5";

// A directly-launchable model id, not a CLI-resolved alias — no indirection
// needed. Verified against the live Claude Platform docs and a local check
// on this machine on 2026-07-10: `claude --model claude-opus-4-8` launches
// successfully (Claude Code >= v2.1.154 required). The CLI may self-report
// this as "claude-opus-4-8[1m]" on Max/Team/Enterprise plans, where Opus is
// automatically upgraded to a 1 million token context window; "[1m]" names
// that context-window variant and is appended by the CLI itself, not a
// value Hive constructs or needs to pass on the `--model` flag.
export const CLAUDE_OPUS_MODEL = "claude-opus-4-8";

// Which vendor's CLI can actually run a user-named model. An explicit model
// launches verbatim (never substituted), so launching it on the other
// vendor's tool produces a vendor-impossible execution identity — the field
// failure was tier routing picking tool=codex while the caller pinned
// model="claude-opus-4-8", opening a Codex TUI that can never run it. Null
// means the name matches no known vendor family and cannot be validated.
export function modelVendor(model: string): "claude" | "codex" | null {
  const value = model.trim().toLowerCase();
  if (
    /^claude([-.]|$)/.test(value) ||
    ["best", "sonnet", "opus", "haiku", "fable"].includes(value)
  ) {
    return "claude";
  }
  if (/^(gpt|codex)([-.]|$)/.test(value) || /^o[0-9]/.test(value)) {
    return "codex";
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readConfiguredModel(
  path: string,
  parse: (source: string) => unknown,
): Promise<string | undefined> {
  const file = Bun.file(path);
  try {
    if (!(await file.exists())) {
      return undefined;
    }
    const parsed = parse(await file.text());
    if (isRecord(parsed) && typeof parsed.model === "string") {
      return parsed.model;
    }
  } catch {
    // Resolution is display-only; a broken tool config must not fail a spawn.
  }
  return undefined;
}

function claudeSettingsPath(): string {
  const directory = Bun.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(directory, "settings.json");
}

function codexConfigPath(): string {
  const directory = Bun.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(directory, "config.toml");
}

// The model stored on an AgentRecord (and shown in terminal titles and
// hive_status) must be the model the tool actually runs, not a routing
// alias. Routes with a concrete model pass through; "default" is resolved
// from the tool's own user config — the same file the CLI itself reads when
// hive omits the model flag. Only when that config names no model does the
// alias survive, because the CLI's built-in default is not knowable locally.
export async function resolveConcreteModel(
  tool: Route["tool"],
  route: Route,
): Promise<string> {
  const configured = route[tool].model;
  if (tool === "claude" && configured === "best") {
    return CLAUDE_BEST_MODEL;
  }
  if (configured !== "default") {
    return configured;
  }
  const resolved = tool === "claude"
    ? await readConfiguredModel(claudeSettingsPath(), JSON.parse)
    : await readConfiguredModel(codexConfigPath(), Bun.TOML.parse);
  return resolved ?? configured;
}
