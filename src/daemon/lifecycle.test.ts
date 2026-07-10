import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPidFilePath,
  isRunning,
  probeDaemonReuse,
  writeLifecycleFiles,
} from "./lifecycle";
import type { DaemonHandshake } from "./handshake";
import { handshakeMismatch } from "./handshake";

const handshake: DaemonHandshake = {
  productVersion: "0.1.0",
  buildHash: "current-build",
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  capabilities: ["daemon-handshake-v1"],
  hiveUuid: "hive-project-a",
  identityKey: "project-a",
  repoFamilyKey: null,
  generation: 1,
};

describe("daemon lifecycle", () => {
  test("a confirmed move retains its opaque handshake identity", () => {
    const moved = { ...handshake, identityKey: "project-b" };
    expect(handshakeMismatch(handshake, moved)).toEqual("project identity key");
    expect(handshakeMismatch({ ...handshake, identityKey: "project-b" }, moved)).toBeNull();
  });

  test("a recreated path cannot inherit the prior HiveUUID", () => {
    const recreated = { ...handshake, hiveUuid: "hive-new", identityKey: "project-a" };
    expect(handshakeMismatch(handshake, recreated)).toEqual("project identity (HiveUUID)");
  });
  test("accepts a healthy daemon even when its pidfile is missing", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-health-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true }),
    );
    try {
      writeLifecycleFiles(4317);
      rmSync(getPidFilePath());
      expect(await isRunning()).toEqual(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
    }
  });

  test("rejects a live pid when the recorded health endpoint is absent", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-stale-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection refused"),
    );
    try {
      writeLifecycleFiles(4317, process.pid);
      expect(await isRunning()).toEqual(false);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
    }
  });

  test("rejects cross-project adoption even when health is live", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-project-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input) => {
      const url = String(input);
      return Promise.resolve(Response.json(url.endsWith("/health")
        ? { ok: true }
        : { ...handshake, hiveUuid: "hive-project-b" }));
    }) as typeof fetch);
    try {
      writeLifecycleFiles(4317);
      expect(await probeDaemonReuse(handshake)).toEqual({
        state: "rejected",
        port: 4317,
        reason: "project identity (HiveUUID)",
      });
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("rejects a stale build with the same marketing version", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-build-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input) =>
      Promise.resolve(Response.json(String(input).endsWith("/health")
        ? { ok: true }
        : { ...handshake, buildHash: "stale-build" }))
    ) as typeof fetch);
    try {
      writeLifecycleFiles(4317);
      expect(await probeDaemonReuse(handshake)).toEqual({
        state: "rejected",
        port: 4317,
        reason: "content-addressed build hash",
      });
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("authorizes legitimate same-project reuse only after handshake", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-reuse-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input) =>
      Promise.resolve(Response.json(String(input).endsWith("/health")
        ? { ok: true }
        : handshake))
    ) as typeof fetch);
    try {
      writeLifecycleFiles(4317);
      expect(await probeDaemonReuse(handshake)).toEqual({
        state: "authorized",
        port: 4317,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });
});
