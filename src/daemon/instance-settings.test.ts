import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HiveDatabase } from "./db";
import { inheritDefaultModelControlSettings } from "./instance-settings";
import { RoutingPolicyStore } from "./routing-policy-store";

test("a named instance reads the live default database and imports Model Control once", () => {
  const root = mkdtempSync(join(tmpdir(), "hive-instance-settings-"));
  const defaultHome = join(root, "default");
  const namedHome = join(root, "named");
  mkdirSync(defaultHome, { recursive: true });
  mkdirSync(namedHome, { recursive: true });
  const defaultDb = new HiveDatabase(join(defaultHome, "hive.db"));
  const namedDb = new HiveDatabase(join(namedHome, "hive.db"));
  try {
    const source = new RoutingPolicyStore(defaultDb);
    source.apply(
      { op: "set-provider", expectedRevision: 0, provider: "codex", state: "enabled" },
      "human",
    );
    source.apply({
      op: "set-chain",
      expectedRevision: 1,
      category: "simple_coding",
      entries: [{
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: { mode: "exact", value: "high" },
      }],
    }, "human");

    const target = new RoutingPolicyStore(namedDb);
    target.seedProvisionalBaseline(
      { vendorDefaults: { codex: "old-suggestion" } },
    );
    expect(inheritDefaultModelControlSettings(target, {
      currentHome: namedHome,
      sourceHome: defaultHome,
    })).toBeTrue();
    expect(target.read().providers.codex).toBe("enabled");
    expect(target.read().chains.simple_coding?.[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "high" },
    });

    // A later local edit is ownership: inheritance is one-time, not sync.
    const revision = target.read().revision;
    target.apply(
      { op: "set-provider", expectedRevision: revision, provider: "codex", state: "disabled" },
      "named-instance-user",
    );
    expect(inheritDefaultModelControlSettings(target, {
      currentHome: namedHome,
      sourceHome: defaultHome,
    })).toBeFalse();
    expect(target.read().providers.codex).toBe("disabled");
  } finally {
    namedDb.close();
    defaultDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});
