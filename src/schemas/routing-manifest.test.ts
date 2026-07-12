import { describe, expect, test } from "bun:test";
import {
  CapabilityRecordSchema,
  known,
  unknown,
  type CapabilityRecord,
} from "./capability";
import {
  defaultTaskKind,
  FIRST_ROUTING_MANIFEST,
  manifestAlias,
  manifestCandidates,
  RoutingManifestSchema,
  type TaskKind,
} from "./routing-manifest";
import type { RoutingTier } from "./routing";

const observedAt = "2026-07-11T12:00:00Z";

function record(
  provider: CapabilityRecord["provider"],
  canonicalId: string,
  options: { entitledUnknown?: boolean; hidden?: boolean } = {},
): CapabilityRecord {
  const surface = provider === "claude"
    ? "claude.initialize" as const
    : "codex.model/list" as const;
  return CapabilityRecordSchema.parse({
    provider,
    accountFingerprint: "a".repeat(64),
    cliVersion: "test",
    canonicalId,
    variant: null,
    launchToken: canonicalId,
    displayName: null,
    aliases: [],
    entitled: options.entitledUnknown
      ? unknown("field-absent", surface, observedAt)
      : known(true, surface, observedAt),
    hidden: provider === "codex"
      ? known(options.hidden ?? false, surface, observedAt)
      : unknown("surface-silent", surface, observedAt),
    supportsEffort: provider === "claude"
      ? known(true, surface, observedAt)
      : unknown("surface-silent", surface, observedAt),
    supportedEffortLevels: known(["medium"], surface, observedAt),
    defaultEffort: provider === "codex"
      ? known("medium", surface, observedAt)
      : unknown("surface-silent", surface, observedAt),
    observedAt,
  });
}

const records = [
  record("claude", "claude-fable-5"),
  record("claude", "claude-opus-4-8"),
  record("claude", "claude-sonnet-5"),
  record("claude", "claude-haiku-4-5-20251001"),
  record("codex", "gpt-5.6-sol"),
];

describe("RoutingManifestSchema", () => {
  test("accepts the first manifest and preserves unknown fields", () => {
    const parsed = RoutingManifestSchema.parse({
      ...FIRST_ROUTING_MANIFEST,
      futureTopLevel: { kept: true },
      schema: {
        ...FIRST_ROUTING_MANIFEST.schema,
        futureSchemaField: "kept",
      },
    });

    expect(parsed.futureTopLevel).toEqual({ kept: true });
    expect(parsed.schema.futureSchemaField).toBe("kept");
    expect(parsed.models["gpt-5.6-sol"]?.codingCapable).toEqual({
      value: true,
      provenance: {
        source: "docs/research/model-routing-and-token-efficiency.md",
        declaredAt: "2026-07-11T00:00:00Z",
      },
    });
  });

  test("rejects an unknown major schema version", () => {
    expect(() =>
      RoutingManifestSchema.parse({
        ...FIRST_ROUTING_MANIFEST,
        schema: { major: 2, minor: 0 },
      })
    ).toThrow();
  });

  test("rejects reversed candidate windows", () => {
    const candidate = FIRST_ROUTING_MANIFEST.tiers.deep.claude[0]!;
    expect(() =>
      RoutingManifestSchema.parse({
        ...FIRST_ROUTING_MANIFEST,
        tiers: {
          ...FIRST_ROUTING_MANIFEST.tiers,
          deep: {
            ...FIRST_ROUTING_MANIFEST.tiers.deep,
            claude: [{
              ...candidate,
              validFrom: "2026-07-13T00:00:00Z",
              validUntil: "2026-07-12T00:00:00Z",
            }],
          },
        },
      })
    ).toThrow("validFrom must precede validUntil");
  });
});

describe("manifestCandidates", () => {
  const now = new Date("2026-07-11T12:30:00Z");

  test("reproduces today's effective top candidate for every tier and tool", () => {
    const actual = Object.fromEntries(
      (["deep", "standard", "cheap", "review"] as RoutingTier[]).map(
        (tier) => {
          const route = FIRST_ROUTING_MANIFEST.tiers[tier];
          return [tier, {
            tool: route.preferredProvider,
            claude: manifestCandidates(
              FIRST_ROUTING_MANIFEST,
              tier,
              "claude",
              "coding",
              records,
              now,
              60,
            )[0]?.record.canonicalId,
            codex: manifestCandidates(
              FIRST_ROUTING_MANIFEST,
              tier,
              "codex",
              "coding",
              records,
              now,
              60,
            )[0]?.record.canonicalId,
          }];
        },
      ),
    );

    const expected = {
      deep: {
        tool: "claude",
        claude: "claude-fable-5",
        codex: "gpt-5.6-sol",
      },
      standard: {
        tool: "codex",
        claude: "claude-sonnet-5",
        codex: "gpt-5.6-sol",
      },
      cheap: {
        tool: "codex",
        claude: "claude-haiku-4-5-20251001",
        codex: "gpt-5.6-sol",
      },
      review: {
        tool: "claude",
        claude: "claude-sonnet-5",
        codex: "gpt-5.6-sol",
      },
    };

    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  test("preserves the current Fable to Opus ordered downshift list", () => {
    expect(manifestCandidates(
      FIRST_ROUTING_MANIFEST,
      "deep",
      "claude",
      "coding",
      records,
      now,
      24 * 60,
    ).map(({ record }) => record.canonicalId)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
    ]);
  });

  test("keeps alias resolution explicit and provenance-bearing", () => {
    expect(manifestAlias(FIRST_ROUTING_MANIFEST, "claude", "best")).toEqual({
      provider: "claude",
      alias: "best",
      canonicalId: "claude-fable-5",
      provenance: {
        source: "live-cli-billing-probe",
        observedAt: "2026-07-09T00:00:00Z",
      },
    });
    expect(manifestAlias(
      FIRST_ROUTING_MANIFEST,
      "claude",
      "unknown-alias",
    )).toBeUndefined();
  });

  test("requires coding capability for coding and review only", () => {
    expect(defaultTaskKind("review")).toBe("review");
    expect(defaultTaskKind("cheap")).toBe("coding");

    const mechanicalOnly = RoutingManifestSchema.parse({
      ...FIRST_ROUTING_MANIFEST,
      models: {
        ...FIRST_ROUTING_MANIFEST.models,
        "gpt-5.6-sol": {
          codingCapable: {
            value: false,
            provenance: {
              source: "test-review",
              declaredAt: "2026-07-11T00:00:00Z",
            },
          },
        },
      },
    });

    for (const kind of ["coding", "review"] satisfies TaskKind[]) {
      expect(manifestCandidates(
        mechanicalOnly,
        "cheap",
        "codex",
        kind,
        records,
        now,
        60,
      )).toEqual([]);
    }
    for (const kind of ["mechanical", "research"] satisfies TaskKind[]) {
      expect(manifestCandidates(
        mechanicalOnly,
        "cheap",
        "codex",
        kind,
        records,
        now,
        60,
      )).toHaveLength(1);
    }
  });

  test("treats an undeclared coding capability as unknown, not false", () => {
    const { ["gpt-5.6-sol"]: _undeclared, ...models } =
      FIRST_ROUTING_MANIFEST.models;
    const manifest = RoutingManifestSchema.parse({
      ...FIRST_ROUTING_MANIFEST,
      models,
    });

    expect(manifestCandidates(
      manifest,
      "cheap",
      "codex",
      "coding",
      records,
      now,
      60,
    )).toEqual([]);
    expect(manifestCandidates(
      manifest,
      "cheap",
      "codex",
      "mechanical",
      records,
      now,
      60,
    )).toHaveLength(1);
  });

  test("keeps non-primary entries in the chain but never promotes them", () => {
    const manifest = RoutingManifestSchema.parse({
      ...FIRST_ROUTING_MANIFEST,
      tiers: {
        ...FIRST_ROUTING_MANIFEST.tiers,
        deep: {
          ...FIRST_ROUTING_MANIFEST.tiers.deep,
          claude: [
            {
              canonicalId: "claude-fable-5",
            },
            {
              canonicalId: "claude-opus-4-8",
              autoRoute: false,
            },
          ],
        },
      },
    });

    expect(manifestCandidates(
      manifest,
      "deep",
      "claude",
      "coding",
      records,
      now,
      60,
    ).map(({ record }) => record.canonicalId)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
    ]);

    expect(manifestCandidates(
      manifest,
      "deep",
      "claude",
      "coding",
      records.filter(({ canonicalId }) => canonicalId !== "claude-fable-5"),
      now,
      60,
    )).toEqual([]);
  });

  test("excludes hidden, unentitled, stale, and expired inputs", () => {
    const stale = record("codex", "gpt-5.6-sol");
    stale.observedAt = "2026-07-10T00:00:00Z";
    for (const inputs of [
      [record("codex", "gpt-5.6-sol", { hidden: true })],
      [record("codex", "gpt-5.6-sol", { entitledUnknown: true })],
      [stale],
    ]) {
      expect(manifestCandidates(
        FIRST_ROUTING_MANIFEST,
        "standard",
        "codex",
        "coding",
        inputs,
        now,
        60,
      )).toEqual([]);
    }

    expect(manifestCandidates(
      FIRST_ROUTING_MANIFEST,
      "standard",
      "codex",
      "coding",
      records,
      new Date(FIRST_ROUTING_MANIFEST.validUntil),
      60 * 24 * 365,
    )).toEqual([]);
  });
});
