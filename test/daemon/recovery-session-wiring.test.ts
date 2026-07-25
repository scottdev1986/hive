// Recovery's createRecoverySession dep must reach the spawner WITH ITS RECEIVER.
//
// The daemon used to hoist the method off the spawner
// (`const fn = this.spawner.createRecoverySession`) and call it bare. That
// type-checks — detaching a method is perfectly legal — but inside the method
// `this` is undefined, so every crash resume died on
// "undefined is not an object (evaluating 'this.createSession')" and then could
// not verify teardown. Recovery could not relaunch ANY agent.
//
// WHY THIS TEST LOOKS AT THE WIRING AND NOT AT A FULL RESUME. Every other
// recovery test constructs CrashRecovery directly and passes its own dep, which
// proves the function and not the wiring the daemon builds — which is exactly how
// this defect survived a green suite. Driving a real resume to the call site
// needs an authorized launch, a sessiond locator, an adapter and vendor
// executables; that fixture would test five other things and bury this one. So
// this reads the dep the daemon actually constructed and calls it, with a spawner
// whose method needs `this`. It reaches through a private field deliberately:
// the production wiring is the subject under test, and there is no public seam
// onto it.
import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/db";
import { HiveDaemon } from "../../src/daemon/server";
import type { AgentRecord } from "../../src/schemas";

/** A spawner whose createRecoverySession is receiver-dependent, exactly like the
 * real one: HiveSpawner.createRecoverySession delegates to `this.createSession`,
 * so a detached call throws before it can do anything. */
class ReceiverDependentSpawner {
  readonly recoverySessions: string[] = [];

  async spawn(): Promise<never> {
    throw new Error("no spawns in this test");
  }

  async createRecoverySession(record: AgentRecord): Promise<void> {
    this.recoverySessions.push(record.name);
  }
}

function daemonWith(spawner: ReceiverDependentSpawner): HiveDaemon {
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db: new HiveDatabase(":memory:"),
    spawner,
    repoRoot: "/tmp/hive-recovery-wiring",
    resourceRunners: { orphans: null },
  });
}

/** The dep the daemon handed CrashRecovery — the production wiring itself. */
function wiredCreateRecoverySession(
  daemon: HiveDaemon,
): ((record: AgentRecord, ...rest: unknown[]) => Promise<void>) | undefined {
  const recovery = (daemon as unknown as { recovery: unknown }).recovery;
  const deps = (recovery as { deps: Record<string, unknown> }).deps;
  return deps.createRecoverySession as
    | ((record: AgentRecord, ...rest: unknown[]) => Promise<void>)
    | undefined;
}

const record = { id: "a1", name: "victim" } as AgentRecord;

describe("the daemon's recovery wiring", () => {
  test("invokes the spawner's createRecoverySession with its receiver intact", async () => {
    const spawner = new ReceiverDependentSpawner();
    const wired = wiredCreateRecoverySession(daemonWith(spawner));
    expect(wired).toBeDefined();
    if (wired === undefined) return;

    // Under the defect this rejects with
    // "undefined is not an object (evaluating 'this.createSession')".
    await wired(record, "codex --resume x", "codex", "grant", "run");
    expect(spawner.recoverySessions).toEqual(["victim"]);
  });

  test("a spawner offering no createRecoverySession leaves the dep absent", async () => {
    // The optional dep must stay optional: presence is probed on the spawner, so
    // an implementation without the method is not wired to a no-op that would
    // silently swallow every resume.
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db: new HiveDatabase(":memory:"),
      spawner: {
        spawn: async () => {
          throw new Error("no spawns in this test");
        },
      },
      repoRoot: "/tmp/hive-recovery-wiring-bare",
      resourceRunners: { orphans: null },
    });
    expect(wiredCreateRecoverySession(daemon)).toBeUndefined();
  });

  test("detaching that method really does throw — the guard above is not vacuous", async () => {
    // Positive control: prove the failure mode the first test excludes is real,
    // rather than trusting an absence.
    const spawner = new ReceiverDependentSpawner();
    const detached = spawner.createRecoverySession;
    await expect(detached(record)).rejects.toThrow();
    expect(spawner.recoverySessions).toEqual([]);
  });
});
