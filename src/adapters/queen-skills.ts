/**
 * How a queen's skills reach her, which is a different question per vendor.
 *
 * An agent has a worktree, so its skills go in the worktree's native directory
 * and every vendor reads them the same way. A queen runs in the user's own
 * checkout, and Hive will not write her skills into it: that directory is read
 * by the human's own sessions, and on three of the five vendors it is read by
 * the queen whether Hive writes there or not.
 *
 * So each vendor is asked for an out-of-tree path instead, and each answers
 * differently:
 *
 * - **claude** — `--plugin-dir`. The only mechanism that survives
 *   `--setting-sources user`, which the queen's launch passes to keep the
 *   repository's own settings out of her session and which switches off project
 *   skill discovery as a side effect. Plugin skills are namespaced, so hers
 *   arrive as `hive:<skill>`.
 * - **kimi** — `--skills-dir`, which *replaces* user and project discovery
 *   rather than adding to it. That is the strongest isolation of the five: what
 *   Hive provisions is exactly what she has.
 * - **grok** — `$GROK_HOME/skills`, under the redirected queen home.
 * - **opencode** — `skills.paths` in Hive's generated configuration.
 * - **codex** — nothing. `CODEX_HOME` is the only isolated path codex offers
 *   and auth lives inside it, so redirecting it would make Hive responsible for
 *   the queen's ability to log in. The Codex queen therefore reads the
 *   checkout's native skill directory and reports degraded isolation.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unknownVendor } from "../schemas";
import { HIVE_VERSION } from "../version";
import { provisionSkillsInto, type SkillTool } from "./skills";

/**
 * Where one vendor's queen skills live and what the launch must say to make the
 * CLI read them.
 *
 * `directory` is null exactly when Hive has no isolated path for the vendor.
 * That is not an error and not an empty success — `degraded` carries what she
 * reads instead, so a caller cannot report "provisioned" without having one.
 */
export interface QueenSkillDelivery {
  directory: string | null;
  /** Extra argv for the launch. Empty when the vendor reads the directory
   * without being told — grok from its redirected home, opencode from config. */
  launchArgs: string[];
  degraded: string | null;
}

/** The plugin manifest `--plugin-dir` requires. Its `name` becomes the
 * namespace every skill in it is addressed by, so it is `hive` and stays
 * `hive`: renaming it renames every skill the queen knows. */
const CLAUDE_PLUGIN_MANIFEST = {
  name: "hive",
  description: "Skills Hive provisions for the queen",
  // The build's own version, never a literal: this repo keeps exactly one
  // source of semver; a second copy would drift.
  version: HIVE_VERSION,
};

/** The claude plugin's root — the directory `--plugin-dir` is given, one level
 * above the `skills/` it contains. */
export function claudeQueenPluginRoot(queenRoot: string): string {
  return join(queenRoot, "claude", "plugin");
}

/**
 * `GROK_HOME` for the queen's launch, and the parent of the directory grok
 * reads her skills from.
 *
 * Exported because the launch environment and the provisioning have to name the
 * same path: grok discovers `$GROK_HOME/skills` and nothing else, so two
 * independent spellings of this would provision her skills where nothing looks
 * for them, with no error anywhere.
 */
export function grokQueenHome(queenRoot: string): string {
  return join(queenRoot, ".grok");
}

/** Pure: where this vendor's queen skills go, and what the launch must carry.
 * Every vendor is answered here, so a new one is a compile error rather than a
 * queen who silently has no skills. */
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
      // Must be exactly `$GROK_HOME/skills`, and GROK_HOME is set to this same
      // path in the launch environment (cli/orchestrator.ts). The two have to
      // agree or the directory is provisioned where nothing reads it.
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

/**
 * Give the queen her skills, and report how — or why not.
 *
 * Idempotent, and run at every launch: the directory is Hive's outright, so
 * rebuilding it is how a skill the user deleted stops reaching her.
 */
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
