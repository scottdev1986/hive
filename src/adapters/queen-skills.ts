import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unknownVendor } from "../schemas/capability";
import { HIVE_VERSION } from "../shared/version";
import { provisionSkillsInto, type SkillTool } from "./skills";

/** Where one vendor's queen skills live and what the launch must say to make the CLI read them. `directory` is null exactly when Hive has no isolated path for the vendor. That is not an error and not an empty success — `degraded` carries what she reads instead, so a caller cannot report "provisioned" without having one. */
export interface QueenSkillDelivery {
  directory: string | null;
  launchArgs: string[];
  degraded: string | null;
}

const CLAUDE_PLUGIN_MANIFEST = {
  name: "hive",
  description: "Skills Hive provisions for the queen",
  // The build's own version, never a literal: this repo keeps exactly one source of semver; a second copy would drift.
  version: HIVE_VERSION,
};

export function claudeQueenPluginRoot(queenRoot: string): string {
  return join(queenRoot, "claude", "plugin");
}

export function grokQueenHome(queenRoot: string): string {
  return join(queenRoot, ".grok");
}

/** Pure: where this vendor's queen skills go, and what the launch must carry. Every vendor is answered here, so a new one is a compile error rather than a queen who silently has no skills. */
export function queenSkillDelivery(
  tool: SkillTool,
  queenRoot: string,
): QueenSkillDelivery {
  switch (tool) {
    case "claude": {
      const root = claudeQueenPluginRoot(queenRoot);
      return {
        directory: join(root, "skills"),
        launchArgs: ["--plugin-dir", root],
        degraded: null,
      };
    }
    case "codex":
      return {
        directory: null,
        launchArgs: [],
        degraded:
          "codex reads the checkout's own .agents/skills; Hive does not redirect CODEX_HOME because the queen's credentials live there",
      };
    case "grok":
      return {
        directory: join(grokQueenHome(queenRoot), "skills"),
        launchArgs: [],
        degraded: null,
      };
    case "kimi":
      return {
        directory: join(queenRoot, "kimi", "skills"),
        launchArgs: ["--skills-dir", join(queenRoot, "kimi", "skills")],
        degraded: null,
      };
    case "opencode":
      return {
        directory: join(queenRoot, "opencode", "skills"),
        launchArgs: [],
        degraded: null,
      };
    default:
      return unknownVendor(tool, "queen skill delivery");
  }
}

/** Give the queen her skills, and report how — or why not. Idempotent, and run at every launch: the directory is Hive's outright, so rebuilding it is how a skill the user deleted stops reaching her. */
export async function provisionQueenSkills(
  repoRoot: string,
  tool: SkillTool,
  queenRoot: string,
  globalSkillsPath?: string,
): Promise<QueenSkillDelivery> {
  const delivery = queenSkillDelivery(tool, queenRoot);
  if (delivery.directory === null) return delivery;

  if (tool === "claude") {
    const manifest = join(
      claudeQueenPluginRoot(queenRoot),
      ".claude-plugin",
      "plugin.json",
    );
    await mkdir(dirname(manifest), { recursive: true });
    await writeFile(
      manifest,
      `${JSON.stringify(CLAUDE_PLUGIN_MANIFEST, null, 2)}\n`,
    );
  }

  await provisionSkillsInto(
    repoRoot,
    delivery.directory,
    { role: "queen", tool },
    globalSkillsPath,
  );
  return delivery;
}
