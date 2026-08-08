import { describe, expect, test } from "bun:test";
import type { NormalizedProviderEvent } from "../src/adapters/providers/protocol/types";
import { MailLeaseHeartbeat } from "../src/cli/agent-ui/mail-lease-heartbeat";

const event = (
  kind: NormalizedProviderEvent["kind"],
): NormalizedProviderEvent => ({ kind }) as NormalizedProviderEvent;

describe("mail lease heartbeat", () => {
  test("renews throughout an active turn and stops at its terminal event", async () => {
    const requests: string[] = [];
    const scheduled: Array<() => void> = [];
    const heartbeat = new MailLeaseHeartbeat({
      client: {
        request: async (path) => {
          requests.push(path);
          return new Response(null, { status: 200 });
        },
        errorDetail: async () => "refused",
      },
      onError: (error) => {
        throw error;
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
    });

    heartbeat.observe(event("turn-started"));
    await Bun.sleep(0);
    expect(requests).toEqual(["/mail/lease-heartbeat"]);
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    await Bun.sleep(0);
    expect(requests).toHaveLength(2);

    heartbeat.observe(event("turn-idle"));
    scheduled[1]?.();
    await Bun.sleep(0);
    expect(requests).toHaveLength(2);
  });

  test("reports a refused renewal and keeps the heartbeat alive", async () => {
    const errors: unknown[] = [];
    const scheduled: Array<() => void> = [];
    const heartbeat = new MailLeaseHeartbeat({
      client: {
        request: async () =>
          new Response(JSON.stringify({ error: "stale generation" }), {
            status: 409,
          }),
        errorDetail: async () => "stale generation",
      },
      onError: (error) => errors.push(error),
      schedule: (callback) => {
        scheduled.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
    });

    heartbeat.observe(event("turn-started"));
    await Bun.sleep(0);

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("stale generation");
    expect(scheduled).toHaveLength(1);
    heartbeat.stop();
  });

  test("an old in-flight renewal cannot schedule into a newer turn", async () => {
    let finishFirst: (() => void) | undefined;
    let requestCount = 0;
    const scheduled: Array<() => void> = [];
    const heartbeat = new MailLeaseHeartbeat({
      client: {
        request: async () => {
          requestCount += 1;
          if (requestCount === 1) {
            await new Promise<void>((resolve) => {
              finishFirst = resolve;
            });
          }
          return new Response(null, { status: 200 });
        },
        errorDetail: async () => "refused",
      },
      onError: (error) => {
        throw error;
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
    });

    heartbeat.observe(event("turn-started"));
    await Bun.sleep(0);
    heartbeat.observe(event("turn-idle"));
    heartbeat.observe(event("turn-started"));
    await Bun.sleep(0);
    expect(requestCount).toBe(2);
    expect(scheduled).toHaveLength(1);

    finishFirst?.();
    await Bun.sleep(0);
    expect(scheduled).toHaveLength(1);
    heartbeat.stop();
  });
});
