// `hive uninstall --purge` is the same uninstaller with its variant retention overridden to
// nothing — dev's destroy-everything command, reached as `make clean-all`. These tests run it
// against scratch installs and read every path it must take from the variant record, because the
// record is the one place the home, the socket root and the identity marker are named without
// being rebuilt from string parts. The properties under test: the retained set dies with
// everything else, the identity marker dies too even though it lives outside the home precisely
// to survive the home's deletion, the shared memory symlinks are unlinked and never followed, and
// the machine-wide artifact store one level up is not this instance's to take.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand } from "../../src/adapters/graphify";
import {
  runUninstallMachine,
  type UninstallDeps,
} from "../../src/cli/uninstall";
import { type HiveVariant, resolveVariant } from "../../src/hive-home/variant";
import { tempRootAsync } from "../temp-root";

const VARIANT_ENV = [
  "HIVE_HOME",
  "HIVE_DEFAULT_HOME",
  "HIVE_SESSIOND_ROOT",
  "HIVE_BUILD_VARIANT",
] as const;

/** Point the variant record at a scratch install. The socket root is redirected too: it resolves under the machine home by default, which is fine here, but an explicit root keeps the fixture readable. */
function scratchInstall(
  root: string,
  home: string,
  variant: HiveVariant | undefined,
): () => void {
  const saved = VARIANT_ENV.map((name) => [name, process.env[name]] as const);
  process.env.HIVE_HOME = home;
  process.env.HIVE_DEFAULT_HOME = join(root, "machine");
  process.env.HIVE_SESSIOND_ROOT = join(root, "sock");
  if (variant === undefined) delete process.env.HIVE_BUILD_VARIANT;
  else process.env.HIVE_BUILD_VARIANT = variant;
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** An uninstall with every side effect outside the filesystem stubbed: no teams, no daemons, a lease that opens and closes. */
function silentDeps(lines: string[]): UninstallDeps {
  return {
    run: runCommand,
    confirm: async () => null,
    log: (line) => lines.push(line),
    stopCurrentInstance: async () => {},
    currentInstanceOwnsProject: async () => false,
    settleCurrentProject: async () => ({}),
    liveTeams: async () => [],
    stopInstances: async () => {},
    acquireLease: async () => ({ release: () => {} }),
  };
}

/** What a dev home retains on an ordinary uninstall, spelled concretely so the purge can be caught deleting exactly the set the record keeps. */
const SEEDED_RETAINED = [
  "hive.db",
  "hive.db-wal",
  "hive.db-shm",
  "quota.db",
  "quota.db-wal",
  "quota.db-shm",
  "config.toml",
  "quota.toml",
  "billing-2026-08.json",
];

describe("hive uninstall --purge", () => {
  test("a dev purge destroys the retained set, the identity marker and the socket root, unlinks the shared memory links, and leaves the machine artifact store alone", async () => {
    const root = await tempRootAsync("hive-purge-dev-");
    const machineHome = join(root, "machine");
    const home = join(machineHome, "instances", "dev-fixture");
    const restore = scratchInstall(root, home, "dev");
    try {
      const config = resolveVariant();
      // Positive controls: this variant retains a non-empty set, every seeded name is really in
      // it, and the marker really does live outside the home — otherwise the "is gone" assertions
      // below would be proving a fixture, not the purge.
      expect(config.retention.length).toBeGreaterThan(0);
      for (const name of SEEDED_RETAINED) {
        expect(
          config.retention.some((pattern) => new Bun.Glob(pattern).match(name)),
        ).toBe(true);
      }
      expect(config.databaseIdentityPath.startsWith(`${home}/`)).toBe(false);

      for (const name of SEEDED_RETAINED) {
        await mkdir(home, { recursive: true });
        await writeFile(join(home, name), name);
      }
      await writeFile(join(home, "daemon.pid"), "1");

      // The shared names are links into the user's real home. Each target holds a file that a
      // traversal would destroy, so "the target is intact" is a measurement, not a hope.
      const shared: Record<string, string> = {};
      for (const name of config.sharedWithDefaultHome) {
        const target = join(root, `shared-${name}`);
        if (name.endsWith(".json")) {
          await writeFile(target, `{"shared":"${name}"}\n`);
        } else {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "keep.md"), `shared ${name}`);
        }
        shared[name] = target;
        await symlink(target, join(home, name));
      }

      await mkdir(dirname(config.databaseIdentityPath), { recursive: true });
      await writeFile(config.databaseIdentityPath, "identity\n");
      await mkdir(config.socketRoot, { recursive: true });
      await writeFile(join(config.socketRoot, "0123abcd.s"), "");
      await mkdir(config.sessiondStateRoot, { recursive: true });
      await writeFile(join(config.sessiondStateRoot, "record.json"), "{}");
      // Artifacts are machine-wide state, not instance state: they sit beside the instance home,
      // not inside it, and a purge of one instance has no business there.
      await mkdir(join(machineHome, "artifacts", "proof"), { recursive: true });
      await writeFile(
        join(machineHome, "artifacts", "proof", "evidence.md"),
        "machine artifact\n",
      );

      const lines: string[] = [];
      expect(
        await runUninstallMachine(
          { yes: true, purge: true },
          silentDeps(lines),
        ),
      ).toBe(0);

      // Everything the record names is gone: the whole home (retained set included), the marker
      // outside it, and the two sessiond roots.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(config.databaseIdentityPath)).toBe(false);
      expect(existsSync(config.socketRoot)).toBe(false);
      expect(existsSync(config.sessiondStateRoot)).toBe(false);

      // The links went with the home; what they pointed at did not.
      for (const name of config.sharedWithDefaultHome) {
        const target = shared[name] as string;
        if (name.endsWith(".json")) {
          expect(await readFile(target, "utf8")).toBe(`{"shared":"${name}"}\n`);
        } else {
          expect(await readFile(join(target, "keep.md"), "utf8")).toBe(
            `shared ${name}`,
          );
        }
      }
      expect(
        await readFile(
          join(machineHome, "artifacts", "proof", "evidence.md"),
          "utf8",
        ),
      ).toBe("machine artifact\n");
    } finally {
      restore();
    }
  });

  test("a prod purge overrides the artifact retention like any other: a purge keeps nothing", async () => {
    const root = await tempRootAsync("hive-purge-prod-");
    const home = join(root, "machine");
    const restore = scratchInstall(root, home, undefined);
    try {
      const config = resolveVariant();
      expect(config.variant).toBe("prod");
      // An ordinary prod uninstall retains the artifact store; the purge's whole point is that
      // it overrides that retention, with the override named in the plan before consent.
      expect(config.retention).toEqual(["artifacts"]);

      await mkdir(home, { recursive: true });
      await writeFile(join(home, "hive.db"), "");
      await mkdir(join(home, "artifacts", "proof"), { recursive: true });
      await writeFile(
        join(home, "artifacts", "proof", "evidence.md"),
        "artifact the purge takes\n",
      );
      await mkdir(dirname(config.databaseIdentityPath), { recursive: true });
      await writeFile(config.databaseIdentityPath, "identity\n");
      await mkdir(config.socketRoot, { recursive: true });
      await writeFile(join(config.socketRoot, "0123abcd.s"), "");

      const lines: string[] = [];
      expect(
        await runUninstallMachine(
          { yes: true, purge: true },
          silentDeps(lines),
        ),
      ).toBe(0);

      // The artifact store went with everything else, which is what the override consented to.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(config.databaseIdentityPath)).toBe(false);
      expect(existsSync(config.socketRoot)).toBe(false);
      expect(lines.join("\n")).toContain("a purge keeps nothing");
    } finally {
      restore();
    }
  });

  test("a purge refuses rather than report success while the identity marker survives", async () => {
    const root = await tempRootAsync("hive-purge-marker-");
    const machineHome = join(root, "machine");
    const home = join(machineHome, "instances", "dev-fixture");
    const restore = scratchInstall(root, home, "dev");
    try {
      const config = resolveVariant();
      await mkdir(home, { recursive: true });
      await mkdir(dirname(config.databaseIdentityPath), { recursive: true });
      await writeFile(config.databaseIdentityPath, "identity\n");
      await mkdir(config.socketRoot, { recursive: true });
      await writeFile(join(config.socketRoot, "0123abcd.s"), "");
      await mkdir(config.sessiondStateRoot, { recursive: true });
      await writeFile(join(config.sessiondStateRoot, "record.json"), "{}");
      // A marker that cannot be removed: its directory denies the unlink. Left behind, it re-arms
      // the identity guard against the home the purge just emptied, and the next run refuses to
      // start — so the purge must say so instead of exiting 0.
      await chmod(dirname(config.databaseIdentityPath), 0o500);

      const lines: string[] = [];
      let code: number;
      try {
        code = await runUninstallMachine(
          { yes: true, purge: true },
          silentDeps(lines),
        );
      } finally {
        await chmod(dirname(config.databaseIdentityPath), 0o700);
      }

      expect(code).toBe(1);
      expect(existsSync(config.databaseIdentityPath)).toBe(true);
      // A surviving marker must not stop the rest of the uninstall: the operator asked for
      // everything gone, and a refusal that leaves the socket and state roots in place while
      // naming one file does not say what actually happened.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(config.socketRoot)).toBe(false);
      expect(existsSync(config.sessiondStateRoot)).toBe(false);
      // The account names both halves — what could not be removed and what was. The plan printed
      // before confirmation already contains the socket root, so the assertion is on the refusal
      // line itself, not on the whole transcript.
      const account = lines.find((line) => line.startsWith("Purge incomplete"));
      expect(account).toBeDefined();
      expect(account).toContain(config.databaseIdentityPath);
      expect(account).toContain(config.socketRoot);
      expect(account).toContain(config.sessiondStateRoot);
    } finally {
      restore();
    }
  });

  test("without --purge the same dev home keeps exactly what the record retains", async () => {
    const root = await tempRootAsync("hive-keep-dev-");
    const machineHome = join(root, "machine");
    const home = join(machineHome, "instances", "dev-fixture");
    const restore = scratchInstall(root, home, "dev");
    try {
      const config = resolveVariant();
      expect(config.retention.length).toBeGreaterThan(0);
      await mkdir(home, { recursive: true });
      for (const name of SEEDED_RETAINED) {
        await writeFile(join(home, name), name);
      }
      await mkdir(dirname(config.databaseIdentityPath), { recursive: true });
      await writeFile(config.databaseIdentityPath, "identity\n");

      expect(await runUninstallMachine({ yes: true }, silentDeps([]))).toBe(0);

      // The control that makes the purge tests mean something: the same code, flag absent, keeps
      // the atom whole — database, sidecars, selections, and the marker outside the home.
      expect(existsSync(home)).toBe(true);
      for (const name of SEEDED_RETAINED) {
        expect(existsSync(join(home, name))).toBe(true);
      }
      expect(existsSync(config.databaseIdentityPath)).toBe(true);
      expect(lstatSync(join(home, "hive.db")).isFile()).toBe(true);
    } finally {
      restore();
    }
  });
});
