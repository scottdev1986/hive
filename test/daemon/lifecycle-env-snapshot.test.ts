// Bun runs every test file in one process, so `process.env` is shared mutable
// state: another test file can point HIVE_HOME somewhere else while this one is
// suspended at an await. `ensureStarted` must therefore act on the home it was
// called with from its first statement to its last, rather than asking
// `process.env` again after every await. The test below is the positive control
// for that: it redirects HIVE_HOME while `ensureStarted` is suspended, and
// fails if any later step follows the redirect.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonSpawnArgv,
  ensureStarted,
  expectedDaemonHandshake,
  writeLifecycleFiles,
} from "../../src/daemon/lifecycle/daemon-lifecycle";
import { unsafeCast } from "../../src/shared/unsafe-cast";
import { IS_RELEASE_BUILD } from "../../src/shared/version";

const PORT = 4319;

describe("ensureStarted under a concurrent HIVE_HOME mutation", () => {
  test("keeps serving the home it was called with", async () => {
    const previousHome = process.env.HIVE_HOME;
    const startedHome = mkdtempSync(join(tmpdir(), "hive-lifecycle-snap-a-"));
    const redirectHome = mkdtempSync(join(tmpdir(), "hive-lifecycle-snap-b-"));
    process.env.HIVE_HOME = startedHome;
    const expected = await expectedDaemonHandshake(process.cwd());

    // Stand a daemon up in the started home only. The redirect home is empty,
    // so a step that follows the redirect sees no daemon and tries to spawn one.
    const realFetch = globalThis.fetch;
    // SAFETY: The test owns this value and its fields.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (!url.startsWith(`http://127.0.0.1:${PORT}/`))
        return realFetch(input, init);
      return Promise.resolve(
        Response.json(url.endsWith("/health") ? { ok: true } : expected),
      );
    }) as typeof fetch);

    // The per-call runner records and refuses every spawn, so no real daemon
    // can start and the captured options name the home it would have used.
    const daemonArgv = daemonSpawnArgv(IS_RELEASE_BUILD, process.execPath);
    const spawnedHomes: (string | undefined)[] = [];
    const spawn = unsafeCast<typeof Bun.spawn>(
      (
        _argv: string[],
        options?: { env?: Record<string, string | undefined> },
      ) => {
        spawnedHomes.push(options?.env?.HIVE_HOME);
        throw new Error(
          `must not spawn a daemon for ${options?.env?.HIVE_HOME}`,
        );
      },
    );

    try {
      writeLifecycleFiles(PORT);
      // `ensureStarted` runs synchronously up to its first await, so mutating
      // here lands while it is suspended — exactly where a concurrent test file
      // would land, and deterministically rather than by racing it.
      const pending = ensureStarted(spawn);
      process.env.HIVE_HOME = redirectHome;
      expect(await pending).toBe(PORT);
      expect(spawnedHomes).toEqual([]);
      expect(() =>
        spawn(daemonArgv, { env: { HIVE_HOME: redirectHome } }),
      ).toThrow(`must not spawn a daemon for ${redirectHome}`);
      expect(spawnedHomes).toEqual([redirectHome]);
    } finally {
      fetchSpy.mockRestore();
      rmSync(startedHome, { recursive: true, force: true });
      rmSync(redirectHome, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });
});
