/**
 * qa/hold-owner.ts — register this process as the Workspace owner of a QA
 * daemon and stay alive until killed.
 *
 * The daemon shuts itself down when no owner registers within its startup
 * deadline, and whenever a registered owner's process dies — a Hive with no
 * Workspace has nobody to serve. The rig holds ownership honestly with this
 * live process instead of disabling that policy: the daemon under QA keeps
 * production lifecycle behavior, and killing this pid is how `down` releases
 * it.
 *
 * Registration alone does not admit spawns: admission reads the visibility
 * SNAPSHOT, and an empty inventory is the truthful one before any agent
 * exists, so this also publishes `terminals: []` once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { macProcessIdentity } from "../../src/daemon/lifecycle/daemon-lifecycle";

const home = process.env.HIVE_HOME;
if (!home) throw new Error("HIVE_HOME is required");

async function readSoon(path: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text.length > 0) return text;
    } catch {
      // not there yet
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(200);
  }
}

const port = await readSoon(join(home, "daemon.port"), 10_000);
const token = await readSoon(join(home, "credentials", "user.cap"), 10_000);
const source = {
  sessionId: `qa-rig-${process.pid}`,
  process: {
    processId: process.pid,
    startToken: macProcessIdentity(process.pid).startToken,
  },
};

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${path} refused (${response.status}): ${detail}`);
  }
}

await post("/workspace-owner", source);
await post("/workspace-visibility", {
  schemaVersion: 1,
  source,
  inventoryRevision: "1",
  terminals: [],
});
console.log(`owner registered pid=${process.pid}`);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
await new Promise(() => {});
