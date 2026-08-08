export type ProjectGate = (repoRoot: string) => Promise<void>;

const checks = ["format:check", "typecheck"] as const;

export const runProjectGate: ProjectGate = async (repoRoot) => {
  for (const check of checks) {
    const child = Bun.spawn(["bun", "run", check], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Project ${check} blocked landing:\n${stdout}${stderr}`);
    }
  }
};
