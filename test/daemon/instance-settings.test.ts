import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HiveDatabase } from "../../src/daemon/db";
import { inheritDefaultModelControlSettings } from "../../src/daemon/instance-settings";
import { RoutingPolicyStore } from "../../src/daemon/routing-policy-store";

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
      {
        op: "set-provider",
        expectedRevision: 0,
        provider: "codex",
        state: "enabled",
      },
      "human",
    );
    source.apply(
      {
        op: "set-route",
        expectedRevision: 1,
        scope: "simple_coding",
        route: {
          mode: "user-weighted",
          candidates: [
            {
              provider: "codex",
              model: "gpt-5.6-sol",
              effort: { mode: "exact", value: "high" },
              weight: 2,
            },
          ],
        },
      },
      "human",
    );

    const target = new RoutingPolicyStore(namedDb);
    target.seedProvisionalBaseline({
      vendorDefaults: { codex: "old-suggestion" },
    });
    // Inheriting from the instance's own home is a no-op, never a self-copy.
    expect(
      inheritDefaultModelControlSettings(target, {
        currentHome: namedHome,
        sourceHome: namedHome,
      }),
    ).toBeFalse();
    expect(
      inheritDefaultModelControlSettings(target, {
        currentHome: namedHome,
        sourceHome: defaultHome,
      }),
    ).toBeTrue();
    expect(target.read().providers.codex).toBe("enabled");
    expect(target.read().categories.simple_coding?.candidates[0]).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "high" },
      weight: 2,
    });

    // A later local edit is ownership: inheritance is one-time, not sync.
    const revision = target.read().revision;
    target.apply(
      {
        op: "set-provider",
        expectedRevision: revision,
        provider: "codex",
        state: "disabled",
      },
      "named-instance-user",
    );
    expect(
      inheritDefaultModelControlSettings(target, {
        currentHome: namedHome,
        sourceHome: defaultHome,
      }),
    ).toBeFalse();
    expect(target.read().providers.codex).toBe("disabled");
  } finally {
    namedDb.close();
    defaultDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});
