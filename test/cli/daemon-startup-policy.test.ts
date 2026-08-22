// The startup Model Control decision, exercised through the function runDaemon
// actually calls. A corrupt document must stop the boot rather than be seeded
// over, so this drives prepareStartupRoutingPolicy itself, not a re-derivation
// of its rules.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareStartupRoutingPolicy } from "../../src/cli/daemon";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  RoutingPolicyCorruptError,
  RoutingPolicyStore,
} from "../../src/daemon/routing-policy-store";

const CORRUPT = '{"schemaVersion":3,"revision":9,';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hive-startup-policy-"));
  const db = new HiveDatabase(join(root, "hive.db"));
  return { root, db, store: new RoutingPolicyStore(db) };
}

test("a corrupt stored policy stops the boot and is never seeded over", async () => {
  const { root, db, store } = fixture();
  db.database.run(
    `INSERT INTO routing_policy (id, revision, updatedAt, document)
     VALUES (1, 9, '2026-07-12T12:00:00.000Z', ?)`,
    [CORRUPT],
  );
  let probedVendors = false;
  try {
    await expect(
      prepareStartupRoutingPolicy(store, async () => {
        probedVendors = true;
        return { vendorDefaults: { codex: "gpt-5.6-sol" } };
      }),
    ).rejects.toThrow(RoutingPolicyCorruptError);

    // No seed was even contemplated, and the user's bytes are untouched.
    expect(probedVendors).toBeFalse();
    // SAFETY: The test owns this value and its fields.
    const stored = db.database
      .query("SELECT revision, document FROM routing_policy WHERE id = 1")
      .get() as { revision: number; document: string };
    expect(stored).toEqual({ revision: 9, document: CORRUPT });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty store is seeded from the live catalog; a readable one is left alone", async () => {
  const { root, db, store } = fixture();
  try {
    await prepareStartupRoutingPolicy(store, async () => ({
      vendorDefaults: { codex: "gpt-5.6-sol" },
    }));
    const seeded = store.read();
    expect(seeded.provisional).toBeTrue();
    expect(seeded.global?.candidates[0]?.model).toBe("gpt-5.6-sol");

    // A second boot re-reads and re-seeds nothing.
    let probedVendors = false;
    await prepareStartupRoutingPolicy(store, async () => {
      probedVendors = true;
      return { vendorDefaults: { codex: "some-other-model" } };
    });
    expect(probedVendors).toBeFalse();
    expect(store.read().revision).toBe(seeded.revision);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
