import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  publishOrchestratorSessionId,
  readLiveOrchestratorRuntime,
  withOrchestratorRuntime,
} from "./orchestrator-runtime";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("orchestrator runtime marker", () => {
  test("publishes the selected tool only for the action lifetime", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-root-runtime-"));
    roots.push(root);
    const path = join(root, "runtime", "orchestrator.json");

    await withOrchestratorRuntime("grok", async () => {
      const runtime = await readLiveOrchestratorRuntime(path, () => true);
      expect(runtime?.tool).toEqual("grok");
      expect(runtime?.pid).toEqual(1234);
      expect((await readFile(path, "utf8")).endsWith("\n")).toEqual(true);
    }, { path, pid: 1234 });

    expect(await readLiveOrchestratorRuntime(path, () => true)).toEqual(null);
  });

  test("rejects a well-formed marker whose owner process is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-root-runtime-stale-"));
    roots.push(root);
    const path = join(root, "runtime", "orchestrator.json");

    await withOrchestratorRuntime("codex", async () => {
      expect(await readLiveOrchestratorRuntime(path, () => false)).toEqual(null);
    }, { path, pid: 4321 });
  });

  test("publishes and clears the native root session without replacing ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-root-runtime-session-"));
    roots.push(root);
    const path = join(root, "runtime", "orchestrator.json");

    await withOrchestratorRuntime("codex", async () => {
      expect(await publishOrchestratorSessionId("thread-root", path, 2468))
        .toEqual(true);
      expect((await readLiveOrchestratorRuntime(path, () => true))?.sessionId)
        .toEqual("thread-root");
      expect(await publishOrchestratorSessionId(null, path, 2468)).toEqual(true);
      expect((await readLiveOrchestratorRuntime(path, () => true))?.sessionId)
        .toBeUndefined();
      expect(await publishOrchestratorSessionId("wrong", path, 9999))
        .toEqual(false);
    }, { path, pid: 2468 });
  });
});
