import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  databaseIdentityPath,
  hiveInstanceSuffix,
  machineHiveHome,
  sessiondRuntimeRoot,
  sessiondStateRoot,
} from "../../src/hive-home/home";
import {
  type HiveVariant,
  parseVariant,
  resolveVariant,
} from "../../src/hive-home/variant";

const MACHINE_HOME = "/tmp/hive-variant-test-machine";

/** Homes that exercise every branch the derivation has: the user's own home, named dev and QA instances under it, and a path that only resolves to something sane. */
const HOMES = [
  MACHINE_HOME,
  `${MACHINE_HOME}/instances/dev-a27e3d322a`,
  `${MACHINE_HOME}/instances/qa-a27e3d322a`,
  "/tmp/hive-variant-test/nested/../home",
];

const TOUCHED = [
  "HIVE_HOME",
  "HIVE_DEFAULT_HOME",
  "HIVE_SESSIOND_ROOT",
  "HIVE_INSTALL_ROOT",
  "HIVE_BIN_LINK",
  "HIVE_BUILD_VARIANT",
] as const;

const PRIOR = Object.fromEntries(
  TOUCHED.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of TOUCHED) {
    const value = PRIOR[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The derivation as it was written before this module existed, restated so the assertions have something to be right against. */
function historicalSuffix(hiveHome: string): string {
  return createHash("sha256")
    .update(resolve(hiveHome))
    .digest("hex")
    .slice(0, 10);
}

function isolate(variant?: HiveVariant): void {
  process.env.HIVE_DEFAULT_HOME = MACHINE_HOME;
  delete process.env.HIVE_SESSIOND_ROOT;
  delete process.env.HIVE_INSTALL_ROOT;
  delete process.env.HIVE_BIN_LINK;
  if (variant === undefined) delete process.env.HIVE_BUILD_VARIANT;
  else process.env.HIVE_BUILD_VARIANT = variant;
}

describe("the variant record derives what its copies derived", () => {
  test("every home resolves to the pre-collapse paths", () => {
    isolate();
    for (const home of HOMES) {
      const config = resolveVariant(home);
      const suffix = historicalSuffix(home);
      expect(config.home).toBe(resolve(home));
      expect(hiveInstanceSuffix(home)).toBe(suffix);
      expect(config.socketRoot).toBe(
        join(machineHiveHome(home), "run", suffix),
      );
      expect(config.databaseIdentityPath).toBe(
        join(machineHiveHome(home), "db-identity", suffix),
      );
      expect(config.installRoot).toBe(
        join(homedir(), ".local", "share", "hive"),
      );
      expect(config.binLink).toBe(join(homedir(), ".local", "bin", "hive"));
    }
  });

  test("sessiond state lives in the home while only the socket stays short", () => {
    isolate();
    for (const home of HOMES) {
      const config = resolveVariant(home);
      // A socket is a kernel rendezvous with no durable bytes and must fit in sun_path; the files
      // sessiond has to keep are under no such limit, so they go where the uninstaller sweeps them.
      expect(config.sessiondStateRoot).toBe(
        join(resolve(home), "sessiond-state"),
      );
      expect(config.sessiondStateRoot.startsWith(`${config.home}/`)).toBe(true);
      expect(config.sessiondStateRoot.startsWith("/tmp/hvs-")).toBe(false);
      // Not under runtime/, which four unrelated callers already compose into by hand.
      expect(config.sessiondStateRoot).not.toInclude("/runtime/");
      // The home is already per-instance, so nothing under it re-derives the suffix.
      expect(config.sessiondStateRoot).not.toInclude(hiveInstanceSuffix(home));
    }
  });

  test("the named readers return the record's fields", () => {
    isolate();
    for (const home of HOMES) {
      const config = resolveVariant(home);
      expect(sessiondRuntimeRoot(home)).toBe(config.socketRoot);
      expect(sessiondStateRoot(home)).toBe(config.sessiondStateRoot);
      expect(databaseIdentityPath(home)).toBe(config.databaseIdentityPath);
    }
  });

  test("the environment still overrides the roots it always overrode", () => {
    isolate();
    process.env.HIVE_SESSIOND_ROOT = "/tmp/hive-variant-test-sd";
    process.env.HIVE_INSTALL_ROOT = "/tmp/hive-variant-test-root";
    process.env.HIVE_BIN_LINK = "/tmp/hive-variant-test-bin/hive";
    const config = resolveVariant(MACHINE_HOME);
    expect(config.socketRoot).toBe("/tmp/hive-variant-test-sd");
    expect(config.installRoot).toBe("/tmp/hive-variant-test-root");
    expect(config.binLink).toBe("/tmp/hive-variant-test-bin/hive");
  });

  test("an unset build variant is prod, so an unlabelled build lands where it always did", () => {
    isolate();
    expect(resolveVariant(MACHINE_HOME).variant).toBe("prod");
    process.env.HIVE_BUILD_VARIANT = "";
    expect(resolveVariant(MACHINE_HOME).variant).toBe("prod");
  });

  test("an unknown build variant refuses rather than falling back", () => {
    isolate();
    process.env.HIVE_BUILD_VARIANT = "staging";
    expect(() => resolveVariant(MACHINE_HOME)).toThrow(
      'Unknown Hive build variant "staging"',
    );
  });

  // The release build parses its --variant argument through this same function, so the set of legal
  // names and the meaning of an absent one cannot drift between the build and the binary.
  test("parseVariant decides the legal names once, for the build and the binary alike", () => {
    for (const variant of ["prod", "dev", "qa"] as const) {
      expect(parseVariant(variant)).toBe(variant);
    }
    expect(parseVariant(undefined)).toBe("prod");
    expect(parseVariant("")).toBe("prod");
    expect(() => parseVariant("staging")).toThrow(
      'Unknown Hive build variant "staging"',
    );
    // A mistyped --define that quietly became prod would ship a dev binary believing it is
    // production, and that belief decides whether it will load code from a local tree.
    expect(() => parseVariant("Prod")).toThrow("expected prod, dev, qa");
  });
});

describe("what each variant is", () => {
  test("the command name and its roots follow the variant", () => {
    isolate("dev");
    const dev = resolveVariant(`${MACHINE_HOME}/instances/dev-a27e3d322a`);
    expect(dev.binName).toBe("hive-dev");
    expect(dev.installRoot).toBe(
      join(homedir(), ".local", "share", "hive-dev"),
    );
    expect(dev.binLink).toBe(join(homedir(), ".local", "bin", "hive-dev"));

    isolate("qa");
    const qa = resolveVariant(`${MACHINE_HOME}/instances/qa-a27e3d322a`);
    expect(qa.binName).toBe("hive-qa");
    expect(qa.installRoot).toBe(join(homedir(), ".local", "share", "hive-qa"));
    expect(qa.binLink).toBe(join(homedir(), ".local", "bin", "hive-qa"));
  });

  test("dev retains its own state on top of the artifact store every variant keeps", () => {
    isolate("dev");
    const dev = resolveVariant(`${MACHINE_HOME}/instances/dev-a27e3d322a`);
    expect(dev.retention).toEqual([
      "hive.db",
      "hive.db-wal",
      "hive.db-shm",
      "quota.db",
      "quota.db-wal",
      "quota.db-shm",
      "config.toml",
      "quota.toml",
      "billing-*.json",
      "artifacts",
      "memory",
      "projects",
      "project-registry.json",
      "models",
    ]);
    // Provider tokens are regenerable and must not survive an uninstall.
    expect(dev.retention).not.toContain("credentials");

    for (const variant of ["prod", "qa"] as const) {
      isolate(variant);
      expect(resolveVariant(MACHINE_HOME).retention).toEqual(["artifacts"]);
    }
  });

  test("only a published prod binary refuses a local embeddings source", () => {
    // The whole truth table, because the axis this is keyed on used to be the wrong one: the gate
    // read "is this compiled" when it meant "is this production", and `make build` runs the real
    // release pipeline, so today's dev binary refuses a source it is supposed to accept.
    const cases = [
      { variant: "prod", release: true, allows: false },
      { variant: "prod", release: false, allows: true },
      { variant: "dev", release: true, allows: true },
      { variant: "dev", release: false, allows: true },
      { variant: "qa", release: true, allows: true },
      { variant: "qa", release: false, allows: true },
    ] as const;
    for (const { variant, release, allows } of cases) {
      isolate(variant);
      expect(
        resolveVariant(MACHINE_HOME, release).allowsLocalEmbeddingsSource,
      ).toBe(allows);
    }
  });
});
