import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineMutationCoordinator } from "../../src/daemon/mutation-lease";
import { activateStagedUpdate, rollbackWhenIdle } from "../../src/cli/update";

const blocker = {
  instance: {
    name: "review",
    home: "/tmp/hive/review",
    instanceId: "instance-review",
    port: 4318,
    pid: 1234,
    running: true,
  },
  liveAgents: ["new-agent"],
};

describe("machine mutation leases in update commands", () => {
  test("update holds its lease from the final checks through activation", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    let held = false;

    await activateStagedUpdate("0.0.8", {
      acquireLease: async (purpose) => {
        order.push(`acquire:${purpose}`);
        held = true;
        return {
          release: () => {
            held = false;
            order.push("release");
          },
        };
      },
      blockers: async () => {
        expect(held).toBe(true);
        order.push("teams");
        return [];
      },
      inspectDaemon: async () => {
        expect(held).toBe(true);
        order.push("daemon");
        return { state: "absent" };
      },
      activate: async () => {
        expect(held).toBe(true);
        order.push("activate");
        return { activated: true, version: "0.0.8", previous: "0.0.7" };
      },
      ensureBinLink: async () => {
        expect(held).toBe(true);
        order.push("bin-link");
      },
      stopStaleDaemon: async () => {
        expect(held).toBe(true);
        order.push("stop-daemon");
      },
      provisionEmbeddings: async (version) => {
        expect(held).toBe(true);
        order.push("embeddings");
        expect(version).toBe("0.0.8");
        return { ok: true, detail: "embedding runtime from hive 0.0.8 installed" };
      },
      log: (line) => lines.push(line),
    });

    expect(order).toEqual([
      "acquire:update",
      "teams",
      "daemon",
      "activate",
      "bin-link",
      "stop-daemon",
      "embeddings",
      "release",
    ]);
    expect(lines.join("\n")).toContain("hive 0.0.8 active");
    expect(lines.join("\n")).toContain(
      "Embeddings: embedding runtime from hive 0.0.8 installed.",
    );
  });

  test("a real landing operation that wins the race prevents every update mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-update-landing-race-"));
    const mutationPath = join(root, "mutation.db");
    const landingCoordinator = new MachineMutationCoordinator({
      path: mutationPath,
      instanceId: "review",
      instanceHome: root,
    });
    const updateCoordinator = new MachineMutationCoordinator({
      path: mutationPath,
      instanceId: "default",
      instanceHome: root,
      instanceLiveness: async () => "live",
    });
    const landing = await landingCoordinator.beginOperation("landing");
    let mutated = false;
    try {
      await expect(activateStagedUpdate("0.0.8", {
        acquireLease: (purpose) => updateCoordinator.acquireLease(purpose),
        blockers: async () => [],
        inspectDaemon: async () => ({ state: "absent" }),
        activate: async () => {
          mutated = true;
          return { activated: true, version: "0.0.8", previous: "0.0.7" };
        },
        ensureBinLink: async () => {
          mutated = true;
        },
        stopStaleDaemon: async () => {},
        provisionEmbeddings: async () => {
          throw new Error("embeddings must not run");
        },
        log: () => {},
      })).rejects.toThrow(/landing .* in progress/);
      expect(mutated).toBe(false);
    } finally {
      landing.release();
      updateCoordinator.close();
      landingCoordinator.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a team appearing after staging blocks activation and releases the lease", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    await activateStagedUpdate("0.0.8", {
      acquireLease: async () => {
        order.push("acquire");
        return { release: () => order.push("release") };
      },
      blockers: async () => [blocker],
      inspectDaemon: async () => {
        throw new Error("daemon inspection must not run");
      },
      activate: async () => {
        throw new Error("activation must not run");
      },
      ensureBinLink: async () => {
        throw new Error("bin link must not change");
      },
      stopStaleDaemon: async () => {},
      provisionEmbeddings: async () => {
        throw new Error("embeddings must not run");
      },
      log: (line) => lines.push(line),
    });

    expect(order).toEqual(["acquire", "release"]);
    expect(lines.join("\n")).toContain("review: new-agent");
    expect(lines.join("\n")).toContain("Fix:");
    expect(lines.join("\n")).not.toContain("activates when");
  });

  test("an activation error still releases the update lease", async () => {
    const order: string[] = [];
    await expect(activateStagedUpdate("0.0.8", {
      acquireLease: async () => ({ release: () => order.push("release") }),
      blockers: async () => [],
      inspectDaemon: async () => ({ state: "absent" }),
      activate: async () => {
        throw new Error("rename failed");
      },
      ensureBinLink: async () => {},
      stopStaleDaemon: async () => {},
      provisionEmbeddings: async () => {
        throw new Error("embeddings must not run");
      },
      log: () => {},
    })).rejects.toThrow("rename failed");
    expect(order).toEqual(["release"]);
  });

  test("a failed embeddings install is a loud warning; the update still stands", async () => {
    const lines: string[] = [];
    await activateStagedUpdate("0.0.8", {
      acquireLease: async () => ({ release: () => {} }),
      blockers: async () => [],
      inspectDaemon: async () => ({ state: "absent" }),
      activate: async () => ({ activated: true, version: "0.0.8", previous: "0.0.7" }),
      ensureBinLink: async () => {},
      stopStaleDaemon: async () => {},
      provisionEmbeddings: async () => ({
        ok: false,
        reason: "could not read the hive 0.0.8 release: network unreachable",
      }),
      log: (line) => lines.push(line),
    });

    const report = lines.join("\n");
    expect(report).toContain("hive 0.0.8 active");
    expect(report).toContain("EMBEDDINGS NOT INSTALLED");
    expect(report).toContain("DEGRADED");
    expect(report).toContain("FTS-only");
    expect(report).toContain("network unreachable");
    expect(report).toContain("hive embeddings install");
  });

  test("a throwing embeddings install is the same loud warning, never a failed update", async () => {
    const lines: string[] = [];
    await activateStagedUpdate("0.0.8", {
      acquireLease: async () => ({ release: () => {} }),
      blockers: async () => [],
      inspectDaemon: async () => ({ state: "absent" }),
      activate: async () => ({ activated: true, version: "0.0.8", previous: "0.0.7" }),
      ensureBinLink: async () => {},
      stopStaleDaemon: async () => {},
      provisionEmbeddings: async () => {
        throw new Error("disk full");
      },
      log: (line) => lines.push(line),
    });

    const report = lines.join("\n");
    expect(report).toContain("EMBEDDINGS NOT INSTALLED");
    expect(report).toContain("disk full");
    expect(report).toContain("hive embeddings install");
  });

  test("rollback performs its final team check and activation under the lease", async () => {
    const order: string[] = [];
    let held = false;
    await rollbackWhenIdle({
      acquireLease: async (purpose) => {
        order.push(`acquire:${purpose}`);
        held = true;
        return {
          release: () => {
            held = false;
            order.push("release");
          },
        };
      },
      blockers: async () => {
        expect(held).toBe(true);
        order.push("teams");
        return [];
      },
      rollback: async () => {
        expect(held).toBe(true);
        order.push("rollback");
        return { activated: true, version: "0.0.7", previous: "0.0.8" };
      },
      stopStaleDaemon: async () => {
        expect(held).toBe(true);
        order.push("stop-daemon");
      },
      log: () => {},
    });

    expect(order).toEqual([
      "acquire:rollback",
      "teams",
      "rollback",
      "stop-daemon",
      "release",
    ]);
  });

  test("a team appearing before rollback activation refuses and releases", async () => {
    const order: string[] = [];
    let rolledBack = false;

    await expect(rollbackWhenIdle({
      acquireLease: async () => {
        order.push("acquire");
        return { release: () => order.push("release") };
      },
      blockers: async () => [blocker],
      rollback: async () => {
        rolledBack = true;
        return { activated: true, version: "0.0.7", previous: "0.0.8" };
      },
      stopStaleDaemon: async () => {},
      log: () => {},
    })).rejects.toThrow(/review: new-agent[\s\S]*Fix:/);

    expect(rolledBack).toBe(false);
    expect(order).toEqual(["acquire", "release"]);
  });
});
