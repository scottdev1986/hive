import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SECRET_CANARY,
  disposeFixtures,
  driftProject,
  emptyProject,
  monorepoProject,
  polyglotProject,
} from "../adapters/project-fixtures.test-support";
import { computeProfileInventory } from "./project-profile";

afterAll(disposeFixtures);

function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function gitOutput(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

async function write(
  root: string,
  relativePath: string,
  body: string | Uint8Array,
): Promise<void> {
  const full = join(root, relativePath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body);
}

async function addIndexOnlyFiles(root: string, count: number): Promise<void> {
  await write(root, "seed", "x");
  const hashed = Bun.spawnSync(["git", "-C", root, "hash-object", "-w", "seed"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (hashed.exitCode !== 0) throw new Error(hashed.stderr.toString());
  const object = hashed.stdout.toString().trim();
  const records = Array.from(
    { length: count },
    (_, index) => `100644 ${object}\tbulk/${index.toString().padStart(6, "0")}\0`,
  ).join("");
  const indexed = Bun.spawnSync(
    ["git", "-C", root, "update-index", "-z", "--index-info"],
    { stdin: new Blob([records]), stdout: "ignore", stderr: "pipe" },
  );
  if (indexed.exitCode !== 0) throw new Error(indexed.stderr.toString());
}

describe("bounded profile inventory policy", () => {
  test("covers a polyglot project without reading its planted hazards", async () => {
    const { root, outsideRoot } = await polyglotProject();
    git(root, ["add", "-f", ".env"]); // prove the policy, not .gitignore, excludes it

    const inventory = await computeProfileInventory(root);
    const paths = inventory.entries.map((entry) => entry.path);

    expect(paths).toEqual(expect.arrayContaining([
      "Cargo.toml",
      "package.json",
      "pyproject.toml",
      "Makefile",
    ]));
    expect(paths).not.toContain(".env");
    expect(paths.some((path) => /^(node_modules|vendor|target|dist)\//.test(path))).toBeFalse();
    expect(JSON.stringify(inventory)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(inventory)).not.toContain(outsideRoot);
    expect(inventory.entries.find((entry) => entry.path === "external")).toMatchObject({
      type: "symlink",
      size: 0,
      contentOmissionReason: "outside-project",
    });

    const digest = inventory.digest;
    await write(root, ".env", `AWS_SECRET_ACCESS_KEY=${"x".repeat(SECRET_CANARY.length)}\n`);
    await write(outsideRoot, "secrets.txt", `${"x".repeat(SECRET_CANARY.length)}\n`);
    expect((await computeProfileInventory(root)).digest).toBe(digest);
  });

  test("rejects an innocuous indexed child beneath a symlinked parent", async () => {
    const { root, outsideRoot } = await polyglotProject();
    await write(outsideRoot, "innocent.txt", "outside one\n");
    // A stale index can still name a child after its parent became a symlink.
    // The inventory must reject that intermediate link before lstat/open can
    // resolve the child outside the project.
    const object = gitOutput(root, ["rev-parse", "HEAD:README.md"]);
    git(root, ["update-index", "--force-remove", "external"]);
    git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      "100644",
      object,
      "external/innocent.txt",
    ]);
    expect(gitOutput(root, ["ls-files", "external/innocent.txt"])).toBe(
      "external/innocent.txt",
    );
    const guarded = await computeProfileInventory(root);
    expect(guarded.entries.map((entry) => entry.path)).not.toContain(
      "external/innocent.txt",
    );
    await write(outsideRoot, "innocent.txt", "outside two\n");
    expect((await computeProfileInventory(root)).digest).toBe(guarded.digest);
  });

  test("covers every workspace in a hazardous monorepo", async () => {
    const { root } = await monorepoProject();
    const paths = (await computeProfileInventory(root)).entries.map((entry) => entry.path);

    expect(paths).toEqual(expect.arrayContaining([
      "backend/Cargo.toml",
      "backend/crates/api/Cargo.toml",
      "backend/crates/store/Cargo.toml",
      "frontend/package.json",
      "Makefile",
    ]));
    expect(paths.some((path) => /^(node_modules|vendor|target|dist)\//.test(path))).toBeFalse();
  });

  test("skips every dependency, build, and credential-store directory segment", async () => {
    const root = await emptyProject();
    const skipped = [
      ".hive",
      "node_modules",
      "bower_components",
      ".pnpm-store",
      ".yarn",
      "vendor",
      "vendors",
      "dist",
      "build",
      "out",
      "target",
      "coverage",
      ".next",
      ".nuxt",
      ".cache",
      ".parcel-cache",
      ".turbo",
      ".venv",
      "venv",
      "__pycache__",
      ".tox",
      ".mypy_cache",
      ".pytest_cache",
      ".gradle",
      ".ssh",
      ".aws",
      ".azure",
      ".kube",
      ".gnupg",
      ".docker",
    ];
    const planted = skipped.map((segment) => `fixtures/${segment}/marker.txt`);
    planted.push("fixtures/.config/gcloud/marker.txt");
    await Promise.all(planted.map((path) => write(root, path, SECRET_CANARY)));
    git(root, ["add", "-f", "--", ...planted]);

    const paths = (await computeProfileInventory(root)).entries.map((entry) => entry.path);
    for (const path of planted) expect(paths).not.toContain(path);
    expect(paths.some((path) => path.includes("/.git/"))).toBeFalse();
  });

  test("skips known secret names while retaining safe env examples", async () => {
    const root = await emptyProject();
    const secrets = [
      ".env",
      ".env.production",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "id_rsa",
      "id_ed25519",
      "credentials.json",
      "credentials-backup",
      "secrets.yaml",
      "secrets-local",
      "prod-private-key.json",
      "ci-service-account.json",
      "certificate.pem",
      "certificate.key",
      "certificate.p12",
      "certificate.pfx",
    ];
    const allowed = [".env.example", ".env.sample"];
    await Promise.all([...secrets, ...allowed].map((path) => write(root, path, SECRET_CANARY)));
    git(root, ["add", "-f", "--", ...secrets, ...allowed]);

    const inventory = await computeProfileInventory(root);
    const paths = inventory.entries.map((entry) => entry.path);
    for (const path of secrets) expect(paths).not.toContain(path);
    expect(paths).toEqual(expect.arrayContaining(allowed));
  });

  test("catalogs internal links safely and marks binary contents as omitted", async () => {
    const root = await emptyProject();
    await write(root, "README.md", "# safe\n");
    await symlink("README.md", join(root, "readme-link"));
    await write(root, "assets/blob.bin", new Uint8Array([0, 255, 1, 2]));

    const inventory = await computeProfileInventory(root);
    expect(inventory.entries.find((entry) => entry.path === "readme-link")).toMatchObject({
      type: "symlink",
      linkTarget: "README.md",
    });
    expect(inventory.entries.find((entry) => entry.path === "assets/blob.bin")).toMatchObject({
      type: "file",
      contentOmissionReason: "binary",
    });
    const canonical = inventory.entries
      .map((entry) => `${entry.type}\0${entry.path}\0${entry.contentDigest}`)
      .join("\0");
    expect(inventory.digest).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  test("a same-size command edit changes the content-based digest", async () => {
    const drift = await driftProject();
    const beforeSize = (await stat(drift.manifestPath)).size;
    const before = await computeProfileInventory(drift.root);

    await drift.applyDrift();
    const after = await computeProfileInventory(drift.root);

    expect((await stat(drift.manifestPath)).size).toBe(beforeSize);
    expect(after.entries.find((entry) => entry.path === "Makefile")?.size).toBe(
      before.entries.find((entry) => entry.path === "Makefile")?.size,
    );
    expect(after.digest).not.toBe(before.digest);
  });
});

describe("profile inventory hard limits", () => {
  test("fails rather than returning a partial catalog after 100,000 files", async () => {
    const root = await emptyProject();
    await addIndexOnlyFiles(root, 100_001);

    await expect(computeProfileInventory(root)).rejects.toMatchObject({
      code: "inventory-limit",
      limit: "files",
    });
  }, 30_000);

  test("fails before hashing more than 2 GiB", async () => {
    const root = await emptyProject();
    const path = join(root, "sparse.bin");
    await writeFile(path, "");
    await truncate(path, 2 * 1024 * 1024 * 1024 + 1);

    await expect(computeProfileInventory(root)).rejects.toMatchObject({
      code: "inventory-limit",
      limit: "bytes",
    });
  });

  test("fails on a path deeper than 64 segments", async () => {
    const root = await emptyProject();
    const path = `${Array.from({ length: 64 }, (_, index) => `d${index}`).join("/")}/file`;
    await write(root, path, "too deep\n");

    await expect(computeProfileInventory(root)).rejects.toMatchObject({
      code: "inventory-limit",
      limit: "path-segments",
    });
  });

  test("fails when inventory work exceeds 60 seconds", async () => {
    const root = await emptyProject();
    await write(root, "README.md", "# deadline\n");
    const startedAt = performance.now();
    let reads = 0;
    const clock = spyOn(performance, "now").mockImplementation(() =>
      reads++ === 0 ? startedAt : startedAt + 60_001,
    );
    try {
      await expect(computeProfileInventory(root)).rejects.toMatchObject({
        code: "inventory-limit",
        limit: "time",
      });
    } finally {
      clock.mockRestore();
    }
  });
});
