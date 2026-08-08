import { describe, expect, test } from "bun:test";
import { PaneDaemonClient } from "../src/cli/agent-ui/pane-daemon-client";

describe("pane daemon client", () => {
  test("renders a JSON daemon error as prose", async () => {
    const client = new PaneDaemonClient({
      port: 4483,
      subject: "alice",
      fetch: async () =>
        Response.json({ error: "agent refused" }, { status: 409 }),
    });
    const response = await client.request("/fixture");
    await expect(client.errorDetail(response)).resolves.toBe("agent refused");
  });

  test("retries transport failures", async () => {
    let calls = 0;
    const client = new PaneDaemonClient({
      port: 4483,
      subject: "alice",
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket closed");
        return new Response(null, { status: 204 });
      },
    });
    await client.request("/fixture");
    expect(calls).toBe(2);
  });

  test("does not retry deterministic 4xx refusals", async () => {
    let calls = 0;
    const client = new PaneDaemonClient({
      port: 4483,
      subject: "alice",
      fetch: async () => {
        calls += 1;
        return Response.json({ error: "forbidden" }, { status: 403 });
      },
    });
    expect((await client.request("/fixture")).status).toBe(403);
    expect(calls).toBe(1);
  });
});
