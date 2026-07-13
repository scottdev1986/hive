import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MachineMutationCoordinator,
  type ProcessIdentityState,
} from "./mutation-lease";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-mutation-lease-"));
  roots.push(root);
  return join(root, "mutation.db");
}

function coordinator(options: {
  path: string;
  instanceId: string;
  instanceHome: string;
  pid: number;
  processes: Map<number, ProcessIdentityState>;
  instances?: Map<string, "live" | "dead" | "unknown">;
}) {
  return new MachineMutationCoordinator({
    path: options.path,
    instanceId: options.instanceId,
    instanceHome: options.instanceHome,
    processPid: options.pid,
    processIdentity: async (pid) =>
      options.processes.get(pid) ?? { state: "unknown" },
    instanceLiveness: async (_home, instanceId) =>
      options.instances?.get(instanceId) ?? "unknown",
  });
}

describe("machine mutation lease", () => {
  test("a live lease blocks spawn and landing operations across daemon instances", async () => {
    const path = databasePath();
    const processes = new Map<number, ProcessIdentityState>([
      [101, { state: "live", startedAt: "process-101" }],
      [202, { state: "live", startedAt: "process-202" }],
    ]);
    const updater = coordinator({
      path,
      instanceId: "default",
      instanceHome: "/hive/default",
      pid: 101,
      processes,
    });
    const daemon = coordinator({
      path,
      instanceId: "named",
      instanceHome: "/hive/named",
      pid: 202,
      processes,
    });
    const lease = await updater.acquireLease("update");
    try {
      await expect(daemon.beginOperation("spawn")).rejects.toThrow(
        /machine update.*pid 101/i,
      );
      await expect(daemon.beginOperation("landing")).rejects.toThrow(
        /machine update.*pid 101/i,
      );
    } finally {
      lease.release();
      updater.close();
      daemon.close();
    }
  });

  test("an in-flight landing blocks lease acquisition", async () => {
    const path = databasePath();
    const processes = new Map<number, ProcessIdentityState>([
      [101, { state: "live", startedAt: "process-101" }],
      [202, { state: "live", startedAt: "process-202" }],
    ]);
    const instances = new Map<string, "live" | "dead" | "unknown">([
      ["named", "live"],
    ]);
    const daemon = coordinator({
      path,
      instanceId: "named",
      instanceHome: "/hive/named",
      pid: 202,
      processes,
      instances,
    });
    const updater = coordinator({
      path,
      instanceId: "default",
      instanceHome: "/hive/default",
      pid: 101,
      processes,
      instances,
    });
    const landing = await daemon.beginOperation("landing");
    try {
      await expect(updater.acquireLease("rollback")).rejects.toThrow(
        /landing.*named.*in progress/i,
      );
    } finally {
      landing.release();
      daemon.close();
      updater.close();
    }
  });

  test("a dead lease holder is reclaimed instead of bricking spawn", async () => {
    const path = databasePath();
    const processes = new Map<number, ProcessIdentityState>([
      [101, { state: "live", startedAt: "process-101" }],
      [202, { state: "live", startedAt: "process-202" }],
    ]);
    const abandoned = coordinator({
      path,
      instanceId: "default",
      instanceHome: "/hive/default",
      pid: 101,
      processes,
    });
    await abandoned.acquireLease("machine-uninstall");
    abandoned.close();
    processes.set(101, { state: "dead" });

    const daemon = coordinator({
      path,
      instanceId: "named",
      instanceHome: "/hive/named",
      pid: 202,
      processes,
    });
    const spawn = await daemon.beginOperation("spawn");
    spawn.release();
    daemon.close();
  });

  test("an unobservable lease holder is preserved and blocks operations", async () => {
    const path = databasePath();
    const processes = new Map<number, ProcessIdentityState>([
      [101, { state: "live", startedAt: "process-101" }],
      [202, { state: "live", startedAt: "process-202" }],
    ]);
    const abandoned = coordinator({
      path,
      instanceId: "default",
      instanceHome: "/hive/default",
      pid: 101,
      processes,
    });
    await abandoned.acquireLease("update");
    abandoned.close();
    processes.set(101, { state: "unknown" });

    const daemon = coordinator({
      path,
      instanceId: "named",
      instanceHome: "/hive/named",
      pid: 202,
      processes,
    });
    try {
      await expect(daemon.beginOperation("spawn")).rejects.toThrow(
        /cannot verify.*refusing/i,
      );
    } finally {
      daemon.close();
    }
  });

  test("releasing an old handle never removes a successor lease", async () => {
    const path = databasePath();
    const processes = new Map<number, ProcessIdentityState>([
      [101, { state: "live", startedAt: "process-101" }],
      [202, { state: "live", startedAt: "process-202" }],
      [303, { state: "live", startedAt: "process-303" }],
    ]);
    const first = coordinator({
      path,
      instanceId: "first",
      instanceHome: "/hive/first",
      pid: 101,
      processes,
    });
    const second = coordinator({
      path,
      instanceId: "second",
      instanceHome: "/hive/second",
      pid: 202,
      processes,
    });
    const daemon = coordinator({
      path,
      instanceId: "daemon",
      instanceHome: "/hive/daemon",
      pid: 303,
      processes,
    });
    const oldLease = await first.acquireLease("update");
    oldLease.release();
    const successor = await second.acquireLease("rollback");
    try {
      oldLease.release();
      await expect(daemon.beginOperation("spawn")).rejects.toThrow(
        /machine rollback.*pid 202/i,
      );
    } finally {
      successor.release();
      first.close();
      second.close();
      daemon.close();
    }
  });

  test("an unobservable daemon operation is preserved and blocks mutation", async () => {
    const path = databasePath();
    const processes = new Map<number, ProcessIdentityState>([
      [101, { state: "live", startedAt: "process-101" }],
      [202, { state: "live", startedAt: "process-202" }],
    ]);
    const instances = new Map<string, "live" | "dead" | "unknown">([
      ["named", "live"],
    ]);
    const abandoned = coordinator({
      path,
      instanceId: "named",
      instanceHome: "/hive/named",
      pid: 202,
      processes,
      instances,
    });
    await abandoned.beginOperation("spawn");
    abandoned.close();
    processes.set(202, { state: "unknown" });

    const updater = coordinator({
      path,
      instanceId: "default",
      instanceHome: "/hive/default",
      pid: 101,
      processes,
      instances,
    });
    try {
      await expect(updater.acquireLease("machine-uninstall")).rejects.toThrow(
        /cannot verify.*spawn.*refusing/i,
      );
    } finally {
      updater.close();
    }
  });

  test("an operation from a dead prior daemon is reclaimed after instance restart", async () => {
    const path = databasePath();
    const processes = new Map<number, ProcessIdentityState>([
      [101, { state: "live", startedAt: "process-101" }],
      [202, { state: "live", startedAt: "process-202" }],
    ]);
    const instances = new Map<string, "live" | "dead" | "unknown">([
      ["named", "live"],
    ]);
    const abandoned = coordinator({
      path,
      instanceId: "named",
      instanceHome: "/hive/named",
      pid: 202,
      processes,
      instances,
    });
    await abandoned.beginOperation("landing");
    abandoned.close();
    processes.set(202, { state: "dead" });

    const updater = coordinator({
      path,
      instanceId: "default",
      instanceHome: "/hive/default",
      pid: 101,
      processes,
      instances,
    });
    const lease = await updater.acquireLease("update");
    lease.release();
    updater.close();
  });
});
