import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  checksDisabled,
  isNewer,
  readUpdateCache,
  updatesDisabled,
  writeUpdateCache,
  type LatestRelease,
} from "../../src/update/check";

let home: string;
let cachePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hive-check-"));
  cachePath = join(home, "update-check.json");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = 1_700_000_000_000;
const base = {
  now: () => NOW,
  currentVersion: "0.0.4",
  isReleaseBuild: true,
  env: {} as NodeJS.ProcessEnv,
};
const latest = (version: string, securityCritical = false): (() => Promise<LatestRelease>) =>
  () => Promise.resolve({ version, securityCritical });
const offline = (): Promise<LatestRelease> =>
  Promise.reject(new Error("network unreachable"));

describe("version comparison", () => {
  test("compares patch numbers, not strings", () => {
    expect(isNewer("0.0.10", "0.0.9")).toEqual(true);
    expect(isNewer("0.0.9", "0.0.10")).toEqual(false);
    expect(isNewer("0.0.4", "0.0.4")).toEqual(false);
  });

  test("a dev version is never newer than anything", () => {
    expect(isNewer("0.0.0-dev", "0.0.1")).toEqual(false);
    expect(isNewer("0.0.1", "0.0.0-dev")).toEqual(false);
  });
});

describe("opt-outs", () => {
  test("HIVE_DISABLE_UPDATES blocks even a manual update", () => {
    expect(updatesDisabled({ HIVE_DISABLE_UPDATES: "1" })).toEqual("HIVE_DISABLE_UPDATES=1");
    expect(updatesDisabled({ HIVE_NO_UPDATE_CHECK: "1" })).toEqual(null);
  });

  test("HIVE_NO_UPDATE_CHECK stops checks but leaves manual update working", () => {
    expect(checksDisabled({ HIVE_NO_UPDATE_CHECK: "1" })).toEqual("HIVE_NO_UPDATE_CHECK=1");
    expect(updatesDisabled({ HIVE_NO_UPDATE_CHECK: "1" })).toEqual(null);
  });

  test("the ecosystem-wide NO_UPDATE_NOTIFIER is honored", () => {
    expect(checksDisabled({ NO_UPDATE_NOTIFIER: "1" })).toEqual("NO_UPDATE_NOTIFIER");
  });
});

describe("checkForUpdate", () => {
  test("a source checkout never checks and never nags", async () => {
    let called = false;
    const check = await checkForUpdate({
      ...base,
      isReleaseBuild: false,
      cachePath,
      fetchLatest: () => {
        called = true;
        return latest("0.0.9")();
      },
    });
    expect(check).toEqual({ state: "dev-build", current: "0.0.4" });
    expect(called).toEqual(false);
  });

  test("finds a newer release and caches it", async () => {
    const check = await checkForUpdate({ ...base, cachePath, fetchLatest: latest("0.0.7") });
    expect(check).toEqual({
      state: "update-available",
      current: "0.0.4",
      latest: "0.0.7",
      securityCritical: false,
      stale: false,
    });
    expect(readUpdateCache(cachePath)).toMatchObject({
      latestVersion: "0.0.7",
      checkedAt: NOW,
    });
  });

  test("says up to date when it actually reached the network", async () => {
    const check = await checkForUpdate({ ...base, cachePath, fetchLatest: latest("0.0.4") });
    expect(check).toEqual({ state: "up-to-date", current: "0.0.4", latest: "0.0.4" });
  });

  test("a fresh cache answers without touching the network", async () => {
    writeUpdateCache({
      latestVersion: "0.0.7",
      checkedAt: NOW - 1000,
      securityCritical: false,
      dismissedVersion: null,
    }, cachePath);
    let called = false;
    const check = await checkForUpdate({
      ...base,
      cachePath,
      fetchLatest: () => {
        called = true;
        return latest("0.0.9")();
      },
    });
    expect(called).toEqual(false);
    expect(check).toMatchObject({ state: "update-available", latest: "0.0.7" });
  });

  test("an expired cache goes back to the network", async () => {
    writeUpdateCache({
      latestVersion: "0.0.5",
      checkedAt: NOW - CHECK_INTERVAL_MS - 1,
      securityCritical: false,
      dismissedVersion: null,
    }, cachePath);
    const check = await checkForUpdate({ ...base, cachePath, fetchLatest: latest("0.0.9") });
    expect(check).toMatchObject({ state: "update-available", latest: "0.0.9" });
  });

  test("a failed check with nothing cached says so — it never says up to date", async () => {
    const check = await checkForUpdate({ ...base, cachePath, fetchLatest: offline });
    expect(check).toEqual({
      state: "unavailable",
      current: "0.0.4",
      reason: "network unreachable",
    });
  });

  test("a failed check never upgrades a stale 'no news' into reassurance", async () => {
    // The cache last saw 0.0.4 as latest, and we are 0.0.4. That is not evidence
    // that 0.0.4 is *still* latest, so the honest answer is "could not check".
    writeUpdateCache({
      latestVersion: "0.0.4",
      checkedAt: NOW - CHECK_INTERVAL_MS - 1,
      securityCritical: false,
      dismissedVersion: null,
    }, cachePath);
    const check = await checkForUpdate({ ...base, cachePath, fetchLatest: offline });
    expect(check.state).toEqual("unavailable");
  });

  test("a failed check still reports a newer version it already knows about", async () => {
    writeUpdateCache({
      latestVersion: "0.0.7",
      checkedAt: NOW - CHECK_INTERVAL_MS - 1,
      securityCritical: false,
      dismissedVersion: null,
    }, cachePath);
    const check = await checkForUpdate({ ...base, cachePath, fetchLatest: offline });
    expect(check).toMatchObject({
      state: "update-available",
      latest: "0.0.7",
      stale: true,
    });
  });

  test("a failed check never writes a cache entry", async () => {
    await checkForUpdate({ ...base, cachePath, fetchLatest: offline });
    expect(readUpdateCache(cachePath)).toEqual(null);
  });

  test("refreshing the cache preserves the skipped version", async () => {
    writeUpdateCache({
      latestVersion: "0.0.5",
      checkedAt: 0,
      securityCritical: false,
      dismissedVersion: "0.0.5",
    }, cachePath);
    await checkForUpdate({ ...base, cachePath, fetchLatest: latest("0.0.7") });
    expect(readUpdateCache(cachePath)?.dismissedVersion).toEqual("0.0.5");
  });

  test("disabled checks short-circuit before the network", async () => {
    let called = false;
    const check = await checkForUpdate({
      ...base,
      cachePath,
      env: { HIVE_NO_UPDATE_CHECK: "1" },
      fetchLatest: () => {
        called = true;
        return latest("0.0.9")();
      },
    });
    expect(check).toMatchObject({ state: "disabled" });
    expect(called).toEqual(false);
  });

  test("a corrupt cache file is ignored rather than fatal", async () => {
    await Bun.write(cachePath, "{ not json");
    const check = await checkForUpdate({ ...base, cachePath, fetchLatest: latest("0.0.7") });
    expect(check).toMatchObject({ state: "update-available" });
  });
});
