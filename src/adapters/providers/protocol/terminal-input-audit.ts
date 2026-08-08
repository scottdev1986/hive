import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One way automation can reach a terminal. The pattern names the construct, not a phrase in a comment, so a probe fires on the code that would do the thing rather than on prose describing it. */
export interface InputProbe {
  readonly id: string;
  readonly pattern: RegExp;
  readonly rejects: string;
  /** Files where this construct is still allowed to appear, each because the cutover deletes it. An entry that stops matching is a finished deletion and must be removed from this list; an entry that never matched means the pattern is wrong. */
  readonly deletionTargets: readonly string[];
}

export const INPUT_PROBES: readonly InputProbe[] = [
  {
    id: "agent-turn-input",
    pattern: /\bAgentTurnInput\b/,
    rejects: "hands an adapter a writer aimed at the agent's own terminal",
    deletionTargets: [],
  },
  {
    id: "start-initial-turn",
    pattern: /\bstartInitialTurn\b/,
    rejects: "types a first prompt into a vendor TUI instead of submitting it",
    deletionTargets: [],
  },
  {
    id: "automated-terminal-write",
    pattern: /\bwriteAutomated\b/,
    rejects: "writes bytes to a live agent terminal from a non-user source",
    deletionTargets: [],
  },
  {
    id: "inject-keys",
    pattern: /\binjectKeys\b/,
    rejects: "synthesizes keystrokes at a vendor prompt",
    deletionTargets: [],
  },
  {
    id: "bracketed-paste-automation",
    pattern: /\[200~|\bghostty_paste_encode\b/,
    rejects: "frames automated text as a paste so a TUI accepts it as input",
    deletionTargets: [],
  },
  {
    id: "terminal-input-injection",
    pattern: /\bTIOCSTI\b|\bsend-keys\b|\bsendKeys\b/,
    rejects: "pushes bytes into another process's terminal input queue",
    deletionTargets: [],
  },
  {
    id: "pty-kickoff",
    pattern: /\bqueueInitialInput\b/,
    rejects: "queues a first prompt onto the PTY at session boot",
    deletionTargets: [],
  },
  {
    id: "native-tui-spawn",
    pattern: /\bprepareSpawn\b/,
    rejects: "launches a vendor's own full-screen TUI as the agent surface",
    deletionTargets: [],
  },
];

export interface AuditFinding {
  readonly probeId: string;
  readonly file: string;
  readonly line: number;
}

export function probesMatching(text: string): readonly string[] {
  return INPUT_PROBES.filter((probe) => probe.pattern.test(text)).map(
    (probe) => probe.id,
  );
}

function scanText(file: string, text: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const lines = text.split("\n");
  for (const probe of INPUT_PROBES) {
    for (const [index, line] of lines.entries()) {
      if (probe.pattern.test(line)) {
        findings.push({ probeId: probe.id, file, line: index + 1 });
      }
    }
  }
  return findings;
}

const AUDIT_MODULE = join(
  "src",
  "adapters",
  "providers",
  "protocol",
  "terminal-input-audit.ts",
);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hive",
  "zig-out",
  "zig-cache",
  ".zig-cache",
]);

async function collectSources(
  root: string,
  directory: string,
): Promise<string[]> {
  const entries = await readdir(join(root, directory), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectSources(root, path)));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".zig")) {
      files.push(path);
    }
  }
  return files;
}

export async function auditTerminalInput(
  repositoryRoot: string,
): Promise<readonly AuditFinding[]> {
  const roots = ["src", join("native", "sessiond", "src")];
  const findings: AuditFinding[] = [];
  for (const root of roots) {
    for (const file of await collectSources(repositoryRoot, root)) {
      if (file.endsWith(".test.ts") || file === AUDIT_MODULE) continue;
      const text = await readFile(join(repositoryRoot, file), "utf8");
      findings.push(...scanText(file, text));
    }
  }
  return findings;
}

export function unexpectedFindings(
  findings: readonly AuditFinding[],
): readonly AuditFinding[] {
  return findings.filter((finding) => {
    const probe = INPUT_PROBES.find((each) => each.id === finding.probeId);
    if (probe === undefined) return true;
    return !probe.deletionTargets.includes(finding.file);
  });
}

/** Deletion targets no finding reached. Either the cutover removed one and this list is stale, or the probe never matched anything and the audit has been reporting a clean repository it cannot actually see. */
export function unreachedDeletionTargets(
  findings: readonly AuditFinding[],
): readonly string[] {
  const reached = new Set(
    findings.map((finding) => `${finding.probeId} ${finding.file}`),
  );
  return INPUT_PROBES.flatMap((probe) =>
    probe.deletionTargets
      .filter((file) => !reached.has(`${probe.id} ${file}`))
      .map((file) => `${probe.id} ${file}`),
  );
}

/** Derived from this module's own location, not the caller's. A worktree runs its tests from a checkout nested inside the primary one, so a root computed from anywhere else can silently audit a different tree than the one under test and pass on code it never read. */
export const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);

export interface AuditEvidence {
  readonly schemaVersion: 1;
  /** Every construct still awaiting deletion, as probe id and file. The cutover is finished exactly when this is empty, which is why the release matrix reads its length rather than a summary sentence. */
  readonly deletionTargets: readonly {
    readonly probeId: string;
    readonly file: string;
    readonly rejects: string;
  }[];
  readonly reviewedExceptions: readonly {
    readonly probeId: string;
    readonly file: string;
    readonly why: string;
  }[];
}

/** The audit's findings in the shape release acceptance reads. Built from the probes rather than hand-written, so it cannot claim a deletion that has not happened or omit one that has. */
export function auditEvidence(): AuditEvidence {
  return {
    schemaVersion: 1,
    deletionTargets: INPUT_PROBES.flatMap((probe) =>
      probe.deletionTargets.map((file) => ({
        probeId: probe.id,
        file,
        rejects: probe.rejects,
      })),
    ),
    reviewedExceptions: [],
  };
}
