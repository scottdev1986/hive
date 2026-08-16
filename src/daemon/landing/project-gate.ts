import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VERIFICATION_ARTICLE_ID,
  verificationCommandFromTitle,
} from "../../memory-service/harvest";
import { readMemoryFact } from "../../memory-service/memory-store";
import { promoteVerificationToStandards } from "../spawn/agent-standards";

export type ProjectGate = (repoRoot: string) => Promise<void>;

/** Default gate when the caller has only one tree: read memory there and run there. The daemon passes the primary checkout and the agent's worktree separately. */
export const runProjectGate: ProjectGate = async (worktreePath) => {
  await runLearnedProjectGate(worktreePath, worktreePath);
};

export async function runLearnedProjectGate(
  primaryRoot: string,
  worktreePath: string,
): Promise<void> {
  const fact = await readMemoryFact(
    primaryRoot,
    "repo",
    VERIFICATION_ARTICLE_ID,
  );
  const command =
    fact === null ? null : verificationCommandFromTitle(fact.title);
  if (command === null) return;
  if (!verificationCommandDeclared(primaryRoot, command)) return;

  const child = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Learned verification blocked landing (\`${command}\`):\n${stdout}${stderr}`,
    );
  }
  await promoteVerificationToStandards(primaryRoot, command);
}

export function verificationCommandDeclared(
  repoRoot: string,
  command: string,
): boolean {
  const haystacks = [
    "package.json",
    "Makefile",
    "makefile",
    "AGENTS.md",
    "AGENT_STANDARDS.md",
  ];
  for (const name of haystacks) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (text.includes(command)) return true;
  }
  const parts = command.trim().split(/\s+/);
  const tool = parts[0];
  const script = parts.at(-1);
  if (tool === undefined || script === undefined) return false;
  if (
    (tool === "npm" || tool === "bun" || tool === "pnpm" || tool === "yarn") &&
    script !== tool
  ) {
    const pkgPath = join(repoRoot, "package.json");
    if (!existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      return pkg.scripts?.[script] !== undefined;
    } catch {
      return false;
    }
  }
  if (tool === "make" && parts[1] !== undefined) {
    const makePath = ["Makefile", "makefile"]
      .map((name) => join(repoRoot, name))
      .find((path) => existsSync(path));
    if (makePath === undefined) return false;
    return new RegExp(`^${parts[1]}\\s*:`, "m").test(
      readFileSync(makePath, "utf8"),
    );
  }
  return existsSync(join(repoRoot, tool));
}
