import { describe, expect, test } from "bun:test";
import { MailReadyClient } from "../src/cli/agent-ui/mail-ready-client";
import {
  deriveWakeId,
  type MailReadyEvent,
  MailReadyResponseSchema,
} from "../src/schemas/mail-wake";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function harness(responses: readonly { events: unknown[] }[]) {
  const calls: Call[] = [];
  let index = 0;
  const client = new MailReadyClient({
    port: 4242,
    recipient: "maya",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      const payload = MailReadyResponseSchema.parse({
        recipient: "maya",
        ...(responses[index] ?? { events: [] }),
      });
      index += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  return { client, calls };
}

function event(overrides: Partial<MailReadyEvent> = {}): MailReadyEvent {
  return {
    kind: "mail-ready",
    schemaVersion: 1,
    recipient: "maya",
    lane: "control",
    oldestItemId: "m1",
    backlogCount: 1,
    brokerSeq: 900,
    cursor: 40,
    at: "1970-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("the mail-ready client", () => {
  test("retries a transport failure before polling mail", async () => {
    let calls = 0;
    const client = new MailReadyClient({
      port: 4483,
      recipient: "maya",
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket closed");
        return Response.json(
          MailReadyResponseSchema.parse({ recipient: "maya", events: [] }),
        );
      },
    });
    await client.poll();
    expect(calls).toBe(2);
  });
  test("the first poll names a resume point, because 'from now' replays nothing", async () => {
    // A poll is a request, not a held-open stream: asking for everything after
    // "now" is answered with an empty list every time, and an agent whose
    // frontend never names a cursor never hears about its mail at all.
    const { client, calls } = harness([{ events: [] }]);

    await client.poll();

    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4242/mail-ready?sinceCursor=0",
    );
  });

  test("catching up wakes for the newest notice per lane, not the whole history", async () => {
    const { client, calls } = harness([
      {
        events: [
          event({ oldestItemId: "old", cursor: 1, brokerSeq: 1 }),
          event({ oldestItemId: "current", cursor: 2, brokerSeq: 2 }),
          event({
            lane: "work",
            oldestItemId: "work-current",
            cursor: 3,
            brokerSeq: 3,
          }),
        ],
      },
      { events: [] },
    ]);

    const notices = await client.poll();
    await client.poll();

    expect(notices.map((notice) => notice.oldestItemId)).toEqual([
      "current",
      "work-current",
    ]);
    // History is consumed once: the next poll resumes past all of it.
    expect(calls[1]?.url).toContain("sinceCursor=3");
  });

  test("once caught up, every announcement is handed over", async () => {
    const { client } = harness([
      { events: [event({ oldestItemId: "first", cursor: 1 })] },
      {
        events: [
          event({ oldestItemId: "second", cursor: 2 }),
          event({ oldestItemId: "third", cursor: 3 }),
        ],
      },
    ]);

    await client.poll();
    const later = await client.poll();

    expect(later.map((notice) => notice.oldestItemId)).toEqual([
      "second",
      "third",
    ]);
  });

  test("later polls resume from the cursor, never the broker sequence", async () => {
    const { client, calls } = harness([
      { events: [event({ cursor: 40, brokerSeq: 900 })] },
      { events: [] },
    ]);

    await client.poll();
    await client.poll();

    expect(calls[1]?.url).toBe(
      "http://127.0.0.1:4242/mail-ready?sinceCursor=40",
    );
    expect(calls[1]?.url).not.toContain("900");
    expect(calls[1]?.url).not.toContain("sinceBrokerSeq");
  });

  test("a re-announcement with an older broker sequence still advances the cursor", async () => {
    // The lane withheld this item while an earlier one was leased. Its mailbox
    // sequence predates what has been acknowledged; only the cursor moves on.
    const { client, calls } = harness([
      { events: [event({ cursor: 40, brokerSeq: 900 })] },
      { events: [event({ oldestItemId: "m2", cursor: 41, brokerSeq: 200 })] },
      { events: [] },
    ]);

    await client.poll();
    const second = await client.poll();
    await client.poll();

    expect(second).toHaveLength(1);
    expect(second[0]?.oldestItemId).toBe("m2");
    expect(calls[2]?.url).toContain("sinceCursor=41");
  });

  test("wake ids come from the shared derivation, not a local copy", async () => {
    const { client } = harness([{ events: [event()] }]);

    const notices = await client.poll();

    expect(notices[0]?.wakeId).toBe(deriveWakeId("maya", "control", "m1"));
  });

  test("the same item announced twice derives the same wake id", async () => {
    const { client } = harness([
      { events: [event({ cursor: 40 })] },
      { events: [event({ cursor: 41 })] },
    ]);

    const first = await client.poll();
    const second = await client.poll();

    expect(second[0]?.wakeId).toBe(first[0]?.wakeId);
  });

  test("a refused poll raises rather than reporting an empty world", async () => {
    const client = new MailReadyClient({
      port: 4242,
      recipient: "maya",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: "sinceBrokerSeq is not a resume point",
          }),
          { status: 400 },
        ),
    });

    expect(client.poll()).rejects.toThrow("mail-ready poll failed: 400");
  });

  test("a malformed successful response is rejected at the daemon boundary", async () => {
    const client = new MailReadyClient({
      port: 4242,
      recipient: "maya",
      fetch: async () => Response.json({ events: [{ lane: "control" }] }),
    });

    expect(client.poll()).rejects.toThrow();
  });

  test("every presented notice is acknowledged even when its mailbox sequence is older", async () => {
    const { client, calls } = harness([{ events: [] }, { events: [] }]);

    await client.acknowledge({
      ...event({ cursor: 40, brokerSeq: 900 }),
      wakeId: "wake-40",
    });
    await client.acknowledge({
      ...event({ cursor: 41, brokerSeq: 400 }),
      wakeId: "wake-41",
    });
    await client.acknowledge({
      ...event({ cursor: 42, brokerSeq: 901 }),
      wakeId: "wake-42",
    });

    const acks = calls.filter((call) => call.method === "POST");
    expect(acks).toHaveLength(3);
    expect(acks[0]?.body).toEqual({
      kind: "mail-ready-ack",
      schemaVersion: 1,
      recipient: "maya",
      cursor: 40,
      brokerSeq: 900,
    });
    expect(acks[1]?.body).toMatchObject({ cursor: 41, brokerSeq: 400 });
    expect(acks[2]?.body).toMatchObject({ cursor: 42, brokerSeq: 901 });
  });

  test("a refused ack raises rather than being assumed delivered", async () => {
    const client = new MailReadyClient({
      port: 4242,
      recipient: "maya",
      fetch: async () => new Response("nope", { status: 403 }),
    });

    expect(
      client.acknowledge({
        ...event(),
        wakeId: "wake-40",
      }),
    ).rejects.toThrow("mail-ready ack failed: 403");
  });
});
