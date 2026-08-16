/**
 * Proves that repo uninstall removed Hive's own files without changing content
 * that was already in the repository. The comparison is deliberately
 * asymmetric: another tool may create a new non-Hive file while QA is running,
 * and its presence is not evidence that Hive wrote it. New paths in Hive's
 * exact footprint still fail as residue.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeSkillDirectory } from "../../src/adapters/skills";
import { stripHiveGitignoreEntries } from "../../src/cli/repo-gitignore";
import {
  AGENT_STANDARDS_FILE,
  scaffoldAgentStandardsMd,
} from "../../src/daemon/spawn/agent-standards";
import {
  SHIPPED_SKILLS,
  shippedSkillAddresses,
} from "../../src/skills/shipped";

type TreeEntryKind = "D" | "F" | "L" | "O";

interface TreeEntry {
  readonly kind: TreeEntryKind;
  readonly detail: string;
}

interface RepoInventory {
  readonly root: string;
  readonly branches: readonly string[];
  readonly index: readonly string[];
  readonly proofContent: ReadonlyMap<string, string>;
  readonly tree: ReadonlyMap<string, TreeEntry>;
}

interface ShippedSkillFile {
  readonly digest: string;
  readonly root: string;
}

interface ExpectedFileCleanup {
  readonly content: string | null;
  readonly description: string;
}

const WHOLE_HIVE_ROOTS = ["graphify-out", ".hive/worktrees"] as const;
const GENERATED_HIVE_FILES = [".graphifyignore"] as const;

function parseTreeEntry(line: string, source: string): [string, TreeEntry] {
  const fields = line.split("\t");
  const kind = fields[0];
  const path = fields[1];
  if (
    (kind !== "D" && kind !== "F" && kind !== "L" && kind !== "O") ||
    path === undefined
  ) {
    throw new Error(`${source}: malformed tree entry: ${line}`);
  }
  return [path, { kind, detail: fields.slice(2).join("\t") }];
}

async function readRepoInventory(path: string): Promise<RepoInventory> {
  const lines = (await readFile(path, "utf8")).split("\n");
  if (lines.shift() !== "kind\trepo") {
    throw new Error(`${path}: not a repo inventory`);
  }

  let section:
    | "header"
    | "git-status"
    | "git-index"
    | "proof-content"
    | "tree" = "header";
  let root: string | null = null;
  const branches: string[] = [];
  const index: string[] = [];
  const proofContent = new Map<string, string>();
  const tree = new Map<string, TreeEntry>();

  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith("section\t")) {
      const name = line.slice("section\t".length);
      if (
        name !== "git-status" &&
        name !== "git-index" &&
        name !== "proof-content" &&
        name !== "tree"
      ) {
        throw new Error(`${path}: unknown inventory section ${name}`);
      }
      section = name;
      continue;
    }
    if (line.startsWith("root\t")) {
      const found = line.slice("root\t".length);
      if (root !== null && root !== found) {
        throw new Error(`${path}: inventory roots disagree`);
      }
      root = found;
      continue;
    }
    if (section === "git-status") {
      if (line.startsWith("# branch.")) branches.push(line);
      continue;
    }
    if (section === "git-index") {
      index.push(line);
      continue;
    }
    if (section === "proof-content") {
      const [kind, contentPath, encoded, extra] = line.split("\t");
      if (
        kind !== "B" ||
        contentPath === undefined ||
        encoded === undefined ||
        extra !== undefined
      ) {
        throw new Error(`${path}: malformed proof content: ${line}`);
      }
      proofContent.set(
        contentPath,
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      continue;
    }
    if (section === "tree") {
      const [entryPath, entry] = parseTreeEntry(line, path);
      tree.set(entryPath, entry);
      continue;
    }
    throw new Error(`${path}: entry outside an inventory section: ${line}`);
  }

  if (root === null) throw new Error(`${path}: inventory has no root`);
  return { root, branches, index, proofContent, tree };
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function shippedSkillFiles(): ReadonlyMap<string, ShippedSkillFile> {
  const files = new Map<string, ShippedSkillFile>();
  for (const skill of SHIPPED_SKILLS) {
    const skillDigest = digest(skill.content);
    for (const address of shippedSkillAddresses(skill)) {
      const root = join(".hive", "skills", address, skill.name);
      files.set(join(root, "SKILL.md"), { digest: skillDigest, root });
    }
    for (const tool of skill.tools) {
      const root = join(nativeSkillDirectory(tool), skill.name);
      files.set(join(root, "SKILL.md"), { digest: skillDigest, root });
    }
  }
  return files;
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isDirectoryAbove(
  path: string,
  entry: TreeEntry,
  root: string,
): boolean {
  return entry.kind === "D" && root.startsWith(`${path}/`);
}

function entryEquals(left: TreeEntry, right: TreeEntry): boolean {
  return left.kind === right.kind && left.detail === right.detail;
}

function linesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

async function proveRepoUninstall(
  beforePath: string,
  afterPath: string,
): Promise<number> {
  const [before, after] = await Promise.all([
    readRepoInventory(beforePath),
    readRepoInventory(afterPath),
  ]);
  const failures: string[] = [];
  const externalAdditions: string[] = [];
  const expectedRemovals = new Set<string>();
  const expectedFileCleanups = new Map<string, ExpectedFileCleanup>();
  const allowedRemovalRoots = new Set<string>();
  const requiredAbsentRoots = new Set<string>();

  if (before.root !== after.root) {
    failures.push(
      `repository root changed from ${before.root} to ${after.root}`,
    );
  }
  if (!linesEqual(before.index, after.index)) {
    failures.push("Git index changed during repo uninstall");
  }
  if (!linesEqual(before.branches, after.branches)) {
    failures.push("checked-out branch identity changed during repo uninstall");
  }
  for (const inventory of [before, after]) {
    for (const [path, content] of inventory.proofContent) {
      const entry = inventory.tree.get(path);
      if (entry?.kind !== "F" || entry.detail !== digest(content)) {
        failures.push(`inventory content does not match tree entry ${path}`);
      }
    }
  }

  const standardsEntry = before.tree.get(AGENT_STANDARDS_FILE);
  if (
    standardsEntry?.kind === "F" &&
    standardsEntry.detail === digest(scaffoldAgentStandardsMd())
  ) {
    expectedFileCleanups.set(AGENT_STANDARDS_FILE, {
      content: null,
      description: AGENT_STANDARDS_FILE,
    });
    expectedRemovals.add(AGENT_STANDARDS_FILE);
  }

  const beforeGitignore = before.proofContent.get(".gitignore");
  if (beforeGitignore !== undefined) {
    const cleanup = stripHiveGitignoreEntries(beforeGitignore);
    if (cleanup.removedEntries.length > 0) {
      expectedFileCleanups.set(".gitignore", {
        content: cleanup.content === "" ? null : cleanup.content,
        description: "Hive's marked .gitignore entries",
      });
      expectedRemovals.add("Hive's marked .gitignore entries");
    }
  }

  for (const [path, shipped] of shippedSkillFiles()) {
    const entry = before.tree.get(path);
    if (entry?.kind !== "F" || entry.detail !== shipped.digest) continue;
    expectedRemovals.add(shipped.root);
    allowedRemovalRoots.add(shipped.root);
    requiredAbsentRoots.add(shipped.root);
  }

  for (const root of WHOLE_HIVE_ROOTS) {
    if (![...before.tree.keys()].some((path) => isAtOrBelow(path, root))) {
      continue;
    }
    allowedRemovalRoots.add(root);
    requiredAbsentRoots.add(root);
    expectedRemovals.add(root);
  }
  for (const path of GENERATED_HIVE_FILES) {
    if (before.tree.has(path) && !after.tree.has(path)) {
      allowedRemovalRoots.add(path);
      expectedRemovals.add(path);
    }
  }

  for (const root of requiredAbsentRoots) {
    if ([...after.tree.keys()].some((path) => isAtOrBelow(path, root))) {
      failures.push(`Hive-owned path remained ${root}`);
    }
  }

  for (const [path, entry] of before.tree) {
    if (path === ".") continue;
    const current = after.tree.get(path);
    const expectedCleanup = expectedFileCleanups.get(path);
    if (expectedCleanup !== undefined) {
      const matches =
        expectedCleanup.content === null
          ? current === undefined
          : current?.kind === "F" &&
            current.detail === digest(expectedCleanup.content);
      if (!matches) {
        failures.push(
          `unexpected cleanup result for ${expectedCleanup.description}`,
        );
      }
      continue;
    }
    if (current !== undefined) {
      if (!entryEquals(entry, current)) {
        failures.push(`changed non-Hive path ${path}`);
      }
      continue;
    }
    const allowed = [...allowedRemovalRoots].some(
      (root) => isAtOrBelow(path, root) || isDirectoryAbove(path, entry, root),
    );
    if (!allowed) failures.push(`removed non-Hive path ${path}`);
  }

  const allSkillRoots = new Set(
    [...shippedSkillFiles().values()].map((skill) => skill.root),
  );
  for (const [path, entry] of after.tree) {
    if (path === "." || before.tree.has(path)) continue;
    const generatedStandardsResidue =
      path === AGENT_STANDARDS_FILE &&
      entry.kind === "F" &&
      entry.detail === digest(scaffoldAgentStandardsMd());
    const gitignoreContent =
      path === ".gitignore" ? after.proofContent.get(path) : undefined;
    const generatedGitignoreResidue =
      gitignoreContent !== undefined &&
      stripHiveGitignoreEntries(gitignoreContent).removedEntries.length > 0;
    const hiveResidue =
      generatedStandardsResidue ||
      generatedGitignoreResidue ||
      [...allSkillRoots, ...WHOLE_HIVE_ROOTS, ...GENERATED_HIVE_FILES].some(
        (root) => isAtOrBelow(path, root),
      );
    if (hiveResidue) failures.push(`Hive residue ${path}`);
    else externalAdditions.push(path);
  }

  console.log("repo-proof: comparing repo state around Hive uninstall");
  console.log(`  before: ${beforePath}`);
  console.log(`  after:  ${afterPath}`);
  if (expectedRemovals.size > 0) {
    console.log(
      `repo-proof: expected Hive removals (${expectedRemovals.size})`,
    );
    for (const path of [...expectedRemovals].sort()) {
      console.log(`  removed ${path}`);
    }
  }
  if (externalAdditions.length > 0) {
    console.log(
      `repo-proof: new non-Hive paths are out of scope (${externalAdditions.length})`,
    );
    for (const path of externalAdditions.sort()) console.log(`  left ${path}`);
  }
  if (failures.length > 0) {
    console.error(`repo-proof: FAIL (${failures.length})`);
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }
  console.log("repo-proof: CLEAN — non-Hive content is unchanged");
  return 0;
}

if (import.meta.main) {
  const [beforePath, afterPath, extra] = process.argv.slice(2);
  if (
    beforePath === undefined ||
    afterPath === undefined ||
    extra !== undefined
  ) {
    console.error(
      "usage: bun run scripts/qa/repo-uninstall-proof.ts <before> <after>",
    );
    process.exit(2);
  }
  try {
    process.exitCode = await proveRepoUninstall(beforePath, afterPath);
  } catch (error) {
    console.error(
      `repo-proof: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
