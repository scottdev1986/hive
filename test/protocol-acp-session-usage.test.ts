import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AcpProviderSession } from "../src/adapters/providers/protocol/acp-session";
import { KimiAcpAdapter } from "../src/adapters/providers/protocol/kimi-acp-adapter";
import type { NormalizedProviderEvent } from "../src/adapters/providers/protocol/types";

const SERVER = join(import.meta.dir, "protocol-kimi-fake-server.ts");

function connect(): Promise<AcpProviderSession> {
  const adapter = new KimiAcpAdapter();
  return adapter.connect({
    provider: "kimi",
    executable: process.execPath,
    argv: [SERVER],
    cwd: import.meta.dir,
    env: {},
  }) as Promise<AcpProviderSession>;
}

describe("AcpProviderSession usage decoding", () => {
  test("a prompt result's cache and reasoning fields reach the usage-updated event", async () => {
    const session = await connect();
    const created = await session.newSession({ cwd: import.meta.dir });
    const submitted = session.submit({
      session: created,
      clientInputId: "usage-full-1",
      text: "usage-full please",
    });

    let usage: (NormalizedProviderEvent & { kind: "usage-updated" }) | null =
      null;
    for await (const event of session.events) {
      if (event.kind === "usage-updated") {
        usage = event;
        break;
      }
    }
    await submitted;
    await session.close();

    if (usage === null) throw new Error("no usage-updated event observed");
    // acp-normalize.ts's decoder is the one owner of this alias table; this
    // asserts acp-session.ts now reads through it instead of re-deriving a
    // narrower one that dropped the cache and reasoning fields.
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cachedInputTokens).toBe(20);
    expect(usage.cacheCreationInputTokens).toBe(5);
    expect(usage.reasoningTokens).toBe(10);
  });
});
