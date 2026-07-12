// The `/autonomy` dial: readable by the surfaces that display it, writable by
// the operator alone. The adversarial cases matter most — an agent that can
// raise its own autonomy has escaped its sandbox through the control plane.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Autonomy, AutonomyControl } from "../config/autonomy";
import { HiveDatabase } from "./db";
import { HiveDaemon } from "./server";

const home = mkdtempSync(join(tmpdir(), "hive-autonomy-endpoint-"));
process.env.HIVE_HOME = home;

class FakeControl implements AutonomyControl {
  value: Autonomy = "sandboxed";
  sets: Autonomy[] = [];
  failNextSet = false;
  get(): Autonomy {
    return this.value;
  }
  async set(value: Autonomy): Promise<void> {
    if (this.failNextSet) {
      throw new Error("disk full");
    }
    this.sets.push(value);
    this.value = value;
  }
}

function harness(options: { withControl?: boolean } = {}): {
  daemon: HiveDaemon;
  control: FakeControl;
} {
  const control = new FakeControl();
  const daemon = new HiveDaemon({
    db: new HiveDatabase(":memory:"),
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-autonomy-noop",
    tmux: {
      hasSession: async () => false,
      killSession: async () => {},
      capturePane: async () => "",
      newSession: async () => {},
    },
    ...(options.withControl === false ? {} : { autonomy: control }),
    resourceRunners: { orphans: null },
  });
  return { daemon, control };
}

const request = (
  daemon: HiveDaemon,
  token: string | null,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return daemon.fetch(
    new Request("http://hive/autonomy", {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
};

describe("GET /autonomy", () => {
  test("the operator reads the live value", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("operator", "operator");
    const response = await request(daemon, token, "GET");
    expect(response.status).toEqual(200);
    expect(await response.json()).toEqual({ autonomy: "sandboxed" });
    await daemon.stop();
  });

  test("the orchestrator may read (it briefs agents on the posture)", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("orchestrator", "orchestrator");
    expect((await request(daemon, token, "GET")).status).toEqual(200);
    await daemon.stop();
  });

  test("no credential, no answer", async () => {
    const { daemon } = harness();
    expect((await request(daemon, null, "GET")).status).toEqual(401);
    await daemon.stop();
  });

  test("a daemon without a control reports null, not a guess", async () => {
    const { daemon } = harness({ withControl: false });
    const { token } = daemon.capabilities.mint("operator", "operator");
    expect(await (await request(daemon, token, "GET")).json())
      .toEqual({ autonomy: null });
    await daemon.stop();
  });
});

describe("POST /autonomy", () => {
  test("the operator flips the dial and gets the confirmed value back", async () => {
    const { daemon, control } = harness();
    const { token } = daemon.capabilities.mint("operator", "operator");
    const response = await request(daemon, token, "POST", { autonomy: "dangerous" });
    expect(response.status).toEqual(200);
    expect(await response.json()).toEqual({ autonomy: "dangerous" });
    expect(control.sets).toEqual(["dangerous"]);
    await daemon.stop();
  });

  test("no agent role may write: a writer raising its own autonomy is a sandbox escape", async () => {
    const { daemon, control } = harness();
    for (const [subject, role] of [
      ["maya", "writer"],
      ["viewer", "reader"],
      ["orchestrator", "orchestrator"],
    ] as const) {
      const { token } = daemon.capabilities.mint(subject, role);
      const response = await request(daemon, token, "POST", { autonomy: "dangerous" });
      expect([role, response.status]).toEqual([role, 403]);
    }
    expect(control.sets).toEqual([]);
    expect(control.value).toEqual("sandboxed");
    await daemon.stop();
  });

  test("an unknown value is refused before it reaches the control", async () => {
    const { daemon, control } = harness();
    const { token } = daemon.capabilities.mint("operator", "operator");
    for (const body of [{ autonomy: "yolo" }, { autonomy: 1 }, {}, null]) {
      expect((await request(daemon, token, "POST", body)).status).toEqual(400);
    }
    expect(control.sets).toEqual([]);
    await daemon.stop();
  });

  test("a set that cannot persist is a 500 and the live value stands", async () => {
    const { daemon, control } = harness();
    control.failNextSet = true;
    const { token } = daemon.capabilities.mint("operator", "operator");
    const response = await request(daemon, token, "POST", { autonomy: "dangerous" });
    expect(response.status).toEqual(500);
    expect(((await response.json()) as { error: string }).error)
      .toContain("disk full");
    expect(control.value).toEqual("sandboxed");
    await daemon.stop();
  });

  test("a daemon without a control refuses to pretend it can set one", async () => {
    const { daemon } = harness({ withControl: false });
    const { token } = daemon.capabilities.mint("operator", "operator");
    expect((await request(daemon, token, "POST", { autonomy: "dangerous" })).status)
      .toEqual(503);
    await daemon.stop();
  });
});
