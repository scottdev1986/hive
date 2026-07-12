import { homedir } from "node:os";
import { join } from "node:path";
import type { Route } from "../../schemas";

// CLAUDE_BEST_MODEL and CLAUDE_OPUS_MODEL used to live here: compiled-in
// model ids, i.e. predetermined model knowledge, removed as route sources by
// the user's directive (2026-07-12). The binary names no model; what a CLI's
// alias resolves to is the vendor's fact, read live via capability discovery
// (`claude`'s initialize menu maps its own aliases) — never a constant that
// silently goes stale when the vendor's top model changes.

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
// (`best` used to resolve here through a compiled constant; that mapping is
// the vendor's fact, not Hive's to hardcode, so the alias now passes through
// verbatim — pin concrete IDs, as the docs have always said.)
export async function resolveConcreteModel(
  tool: Route["tool"],
  route: Route,
): Promise<string> {
  const configured = route[tool].model;
  if (configured !== "default") {
    return configured;
  }
  const resolved = tool === "claude"
    ? await readConfiguredModel(claudeSettingsPath(), JSON.parse)
    : await readConfiguredModel(codexConfigPath(), Bun.TOML.parse);
  return resolved ?? configured;
}
