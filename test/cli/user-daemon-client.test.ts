import { describe, expect, test } from "bun:test";
import {
  daemonErrorDetail,
  UserDaemonClient,
} from "../../src/cli/user-daemon-client";
import { isDaemonPort } from "../../src/shared/daemon-port";

const client = (response: Response): UserDaemonClient =>
  new UserDaemonClient({
    port: 4483,
    instanceId: "instance",
    verify: async () => {},
    fetch: async () => response,
  });

describe("user daemon client", () => {
  test("a non-JSON success decodes as null instead of leaking SyntaxError", async () => {
    await expect(
      client(new Response("not json")).json("/fixture", undefined, "throw"),
    ).resolves.toBeNull();
  });

  test("a denied response keeps the daemon reason structured", () => {
    expect(
      daemonErrorDetail(
        { error: "credential refused", reason: "credential-missing" },
        "HTTP 401",
      ),
    ).toEqual({
      message: "credential refused",
      reason: "credential-missing",
    });
  });

  test("the same client supports throwing and degrading failure policies", async () => {
    await expect(
      client(Response.json({ error: "unavailable" }, { status: 503 })).json(
        "/autonomy",
        undefined,
        "throw",
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      client(Response.json({ error: "unavailable" }, { status: 503 })).json(
        "/autonomy",
        undefined,
        "return-null",
      ),
    ).resolves.toBeNull();
  });

  test("verifies once per client lifecycle", async () => {
    let verifies = 0;
    const daemon = new UserDaemonClient({
      port: 4483,
      instanceId: "instance",
      verify: async () => {
        verifies += 1;
      },
      fetch: async () => Response.json({ ok: true }),
    });
    await daemon.request("/one");
    await daemon.request("/two");
    expect(verifies).toBe(1);
  });

  test("port zero is valid only for binding, never connecting", () => {
    expect(isDaemonPort(0)).toBe(false);
    expect(isDaemonPort(0, { allowZero: true })).toBe(true);
    expect(isDaemonPort(65_536, { allowZero: true })).toBe(false);
  });
});
