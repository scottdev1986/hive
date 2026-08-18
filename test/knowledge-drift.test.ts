import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { QUEEN_POLICY } from "../src/cli/queen-policy";
import {
  ROLE_GRANTS,
  type Role,
} from "../src/daemon/authorization/authorization-service";
import {
  HIVE_TOOL_POLICIES,
  type HiveToolName,
} from "../src/daemon/authorization/mcp-tool-policy";
import {
  QUEEN_KNOWLEDGE,
  QUEEN_KNOWLEDGE_INDEX,
  queenKnowledgeIndex,
  resolveQueenKnowledge,
  type QueenKnowledgeEntry,
} from "../src/skills/knowledge";
import { SHIPPED_SKILLS, type ShippedSkill } from "../src/skills/shipped";
import {
  MAIL_CONTROL_BUSY,
  MAIL_CONTROL_LANE_FULL,
  MAIL_IDEMPOTENCY_CONFLICT,
  MAIL_ITEM_NOT_CLAIMABLE,
  MAIL_LEASE_NOT_HELD,
} from "../src/mail-service/store";
import { MAIL_EVIDENCE_MISSING } from "../src/mail-service/wake-ledger";

const ROOT = resolve(import.meta.dir, "..");
const TOOL_PATTERN = /\b(?:graph_locate|hive|memory)_[a-z0-9_]+\b/g;
const PATH_PATTERN = /\b(?:docs|skills|src|test)\/[A-Za-z0-9._/-]+(?::\d+)?/g;

type KnowledgeSurface = Readonly<{ name: string; body: string }>;

export const knowledgeDriftChecks = {
  toolDrift,
  roleCatalogDrift,
  refusalDrift,
  pathDrift,
  registryDrift,
};

function knowledgeSurfaces(
  entries: readonly QueenKnowledgeEntry[] = QUEEN_KNOWLEDGE,
  shippedSkills: readonly ShippedSkill[] = SHIPPED_SKILLS,
): KnowledgeSurface[] {
  return [
    { name: "QUEEN_POLICY", body: QUEEN_POLICY },
    ...entries.map((entry) => {
      const skill = shippedSkills.find(
        (candidate) => candidate.name === entry.skillName,
      );
      return {
        name: entry.skillName,
        body: skill?.content ?? "",
      };
    }),
  ];
}

function toolDrift(
  surfaces: readonly KnowledgeSurface[],
  policies: Readonly<Record<string, { action: string }>> = HIVE_TOOL_POLICIES,
): string[] {
  return surfaces.flatMap(({ name, body }) =>
    [...new Set(body.match(TOOL_PATTERN) ?? [])]
      .filter((tool) => !(tool in policies))
      .map((tool) => `${name} names unknown tool ${tool}`),
  );
}

function roleCatalogDrift(
  tool: HiveToolName,
  expectedRole: Role,
  policies: typeof HIVE_TOOL_POLICIES = HIVE_TOOL_POLICIES,
): string[] {
  const action = policies[tool].action;
  return (Object.keys(ROLE_GRANTS) as Role[]).flatMap((role) => {
    const visible = ROLE_GRANTS[role].actions.includes(action);
    return visible === (role === expectedRole)
      ? []
      : [`${tool} role catalog disagrees for ${role}`];
  });
}

function refusalDrift(
  surfaces: readonly KnowledgeSurface[],
  sourceRefusals: readonly string[],
): string[] {
  const knownCodes = new Set(sourceRefusals);
  return surfaces.flatMap(({ name, body }) =>
    [...new Set(body.match(/\b[A-Z][A-Z_]{2,}\b/g) ?? [])]
      .filter(
        (token) => token.startsWith("MAIL_") || token.startsWith("SPAWN_"),
      )
      .filter((token) => !knownCodes.has(token))
      .map((token) => `${name} quotes unknown refusal ${token}`),
  );
}

function pathDrift(
  surfaces: readonly KnowledgeSurface[],
  pathExists: (path: string) => boolean = (path) =>
    existsSync(resolve(ROOT, path)),
): string[] {
  return surfaces.flatMap(({ name, body }) =>
    [...new Set(body.match(PATH_PATTERN) ?? [])]
      .map((path) => path.replace(/:\d+$/, ""))
      .filter((path) => !pathExists(path))
      .map((path) => `${name} cites missing path ${path}`),
  );
}

function registryDrift(
  entries: readonly QueenKnowledgeEntry[],
  shippedSkills: readonly ShippedSkill[],
): string[] {
  const issues: string[] = [];
  for (const entry of entries) {
    const skill = shippedSkills.find(
      (candidate) => candidate.name === entry.skillName,
    );
    if (entry.summary.trim() === "")
      issues.push(`${entry.topic} has no summary`);
    if (entry.roles.length !== 1 || entry.roles[0] !== "queen") {
      issues.push(`${entry.topic} has invalid roles`);
    }
    if (skill === undefined || skill.content.trim() === "") {
      issues.push(`${entry.topic} has no resolvable body`);
    } else if (!skill.roles.includes("queen")) {
      issues.push(`${entry.topic} resolves to a non-queen skill`);
    }
  }
  if (new Set(entries.map((entry) => entry.topic)).size !== entries.length) {
    issues.push("registry has duplicate topics");
  }
  return issues;
}

const sourceRefusalCodes = [
  MAIL_CONTROL_BUSY,
  MAIL_CONTROL_LANE_FULL,
  MAIL_EVIDENCE_MISSING,
  MAIL_IDEMPOTENCY_CONFLICT,
  MAIL_ITEM_NOT_CLAIMABLE,
  MAIL_LEASE_NOT_HELD,
];

describe("compiled queen knowledge drift", () => {
  test("every mentioned tool exists and queen-only claims match role catalogs", () => {
    const surfaces = knowledgeSurfaces();
    expect(toolDrift(surfaces)).toEqual([]);
    expect(roleCatalogDrift("hive_knowledge", "orchestrator")).toEqual([]);
    expect(roleCatalogDrift("hive_run_bootstrap", "orchestrator")).toEqual([]);

    expect(
      toolDrift([{ name: "mutant", body: "call hive_not_a_real_tool" }]),
    ).toEqual(["mutant names unknown tool hive_not_a_real_tool"]);
    const mutatedPolicies = {
      ...HIVE_TOOL_POLICIES,
      hive_knowledge: {
        ...HIVE_TOOL_POLICIES.hive_knowledge,
        action: HIVE_TOOL_POLICIES.hive_status.action,
      },
    };
    expect(
      roleCatalogDrift("hive_knowledge", "orchestrator", mutatedPolicies),
    ).not.toEqual([]);
  });

  test("quoted typed refusals match daemon-owned refusal codes", () => {
    expect(refusalDrift(knowledgeSurfaces(), sourceRefusalCodes)).toEqual([]);
    expect(
      refusalDrift(
        [{ name: "mutant", body: "MAIL_MUTATED_REFUSAL" }],
        sourceRefusalCodes,
      ),
    ).toEqual(["mutant quotes unknown refusal MAIL_MUTATED_REFUSAL"]);
  });

  test("every cited repository path exists", () => {
    expect(pathDrift(knowledgeSurfaces())).toEqual([]);
    expect(
      pathDrift([{ name: "mutant", body: "src/not-a-real-path.ts:99" }]),
    ).toEqual(["mutant cites missing path src/not-a-real-path.ts"]);
  });

  test("registry entries resolve, have summaries and queen roles, and agree with both indexes", () => {
    expect(registryDrift(QUEEN_KNOWLEDGE, SHIPPED_SKILLS)).toEqual([]);
    expect(queenKnowledgeIndex()).toEqual(
      QUEEN_KNOWLEDGE.map(({ topic, summary }) => ({ topic, summary })),
    );
    expect(QUEEN_POLICY).toContain(QUEEN_KNOWLEDGE_INDEX);
    for (const entry of QUEEN_KNOWLEDGE) {
      expect(resolveQueenKnowledge(entry.topic)?.entry).toBe(entry);
    }

    const mutant = {
      ...QUEEN_KNOWLEDGE[0],
      skillName: "missing-md-module",
      summary: "",
      roles: ["agent"],
    } as unknown as QueenKnowledgeEntry;
    expect(registryDrift([mutant], SHIPPED_SKILLS)).toEqual([
      `${mutant.topic} has no summary`,
      `${mutant.topic} has invalid roles`,
      `${mutant.topic} has no resolvable body`,
    ]);
  });

  test("board conventions require non-optional scrum state tracking", () => {
    const board =
      resolveQueenKnowledge("board-conventions")?.skill.content ?? "";
    expect(board).toContain("non-optional scrum discipline");
    expect(board).toContain("let spawn mark it in progress");
    expect(board).toContain("The task owner writes the board");
    expect(board).toContain("Agents land their own work");
  });
});
