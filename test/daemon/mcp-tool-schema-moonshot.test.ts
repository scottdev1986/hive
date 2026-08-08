import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  ROLE_GRANTS,
  type Role,
} from "../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  HIVE_TOOL_POLICIES,
  type HiveToolName,
} from "../../src/daemon/authorization/mcp-tool-policy";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { actingAs } from "../support/daemon-test-support";
import {
  HIVE_MCP_CATALOG_CACHE_TTL_MS,
  HIVE_MCP_VERSION_NEGOTIATION,
} from "../../src/shared/mcp-protocol";

/**
 * Moonshot (Kimi) rejects a tool declaration outright — HTTP 400, before any
 * inference — if its `parameters` JSON Schema strays outside "Moonshot
 * Flavored JSON Schema" (MFJS). The whole tool list rides in one request, so
 * one bad schema kills every kimi agent's session at 0% context.
 *
 * Constraints below are transcribed from the official spec, linked from the
 * platform's own tool-calling reference:
 *   https://platform.kimi.ai/docs/api/tool-use ("must be a subset of JSON
 *   Schema conforming to the MFJS specification")
 *   -> https://github.com/MoonshotAI/walle/blob/main/docs/mfjs-spec.md
 *
 * "items" (Field Definitions > Applicator Fields > items): "Type: Schema.
 * When the type is array, it defines the sub-schema of each element" — a
 * single schema object, never a tuple-form array. This is the exact defect
 * `allowedActions.items` shipped with: z.tuple() compiles to items-as-array.
 *
 * Explicitly unsupported (spec intro bullets): title, $comment, format,
 * prefixItems, unevaluatedItems, exclusiveMinimum, exclusiveMaximum,
 * minContains, maxContains. $ref is restricted to "#" or "#/$defs/...".
 */
const MOONSHOT_REJECTED_KEYWORDS = [
  "title",
  "$comment",
  "format",
  "prefixItems",
  "unevaluatedItems",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minContains",
  "maxContains",
] as const;

function walkMoonshotSchema(
  schema: unknown,
  path: string,
  violations: string[],
): void {
  if (typeof schema === "boolean") {
    // additionalProperties is documented as Union[bool, Schema]; every other
    // Schema-typed position (items, properties values, anyOf entries) is not,
    // so a bare boolean there is not a valid MFJS schema node.
    if (!path.endsWith(".additionalProperties")) {
      violations.push(`${path}: boolean schema is not valid MFJS here`);
    }
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;

  if (Array.isArray(node.items)) {
    violations.push(
      `${path}.items: tuple-form items array is rejected — MFJS "items" must be a single Schema object`,
    );
  } else if (node.items !== undefined) {
    walkMoonshotSchema(node.items, `${path}.items`, violations);
  }

  for (const rejected of MOONSHOT_REJECTED_KEYWORDS) {
    if (rejected in node) {
      violations.push(`${path}.${rejected}: keyword is unsupported by MFJS`);
    }
  }

  if (
    typeof node.$ref === "string" &&
    node.$ref !== "#" &&
    !node.$ref.startsWith("#/$defs/")
  ) {
    violations.push(
      `${path}.$ref: must be "#" or start with "#/$defs/", got ${node.$ref}`,
    );
  }

  if (node.properties !== null && typeof node.properties === "object") {
    for (const [name, sub] of Object.entries(
      node.properties as Record<string, unknown>,
    )) {
      walkMoonshotSchema(sub, `${path}.properties.${name}`, violations);
    }
  }
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((sub, index) => {
      walkMoonshotSchema(sub, `${path}.anyOf[${index}]`, violations);
    });
  }
  if (node.additionalProperties !== undefined) {
    walkMoonshotSchema(
      node.additionalProperties,
      `${path}.additionalProperties`,
      violations,
    );
  }
  if (node.$defs !== null && typeof node.$defs === "object") {
    for (const [name, sub] of Object.entries(
      node.$defs as Record<string, unknown>,
    )) {
      walkMoonshotSchema(sub, `${path}.$defs.${name}`, violations);
    }
  }
}

describe("MFJS validator sanity", () => {
  test("catches tuple-form items", () => {
    const badSchema = {
      type: "object",
      properties: {
        allowedActions: {
          type: "array",
          items: [{ type: "string", const: "message" }],
        },
      },
    };
    const violations: string[] = [];
    walkMoonshotSchema(badSchema, "tool_with_array_field", violations);
    expect(violations).toEqual([
      'tool_with_array_field.properties.allowedActions.items: tuple-form items array is rejected — MFJS "items" must be a single Schema object',
    ]);
  });

  test("accepts a single-object items schema", () => {
    const goodSchema = {
      type: "object",
      properties: {
        allowedActions: {
          type: "array",
          items: { type: "string", const: "message" },
        },
      },
    };
    const violations: string[] = [];
    walkMoonshotSchema(goodSchema, "tool_with_array_field", violations);
    expect(violations).toEqual([]);
  });
});

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by schema tests");
  }
}

async function makeDaemon(): Promise<HiveDaemon> {
  const home = await mkdtemp(join(tmpdir(), "hive-mcp-schema-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-mcp-schema-repo-"));
  tempRoots.push(repoRoot);
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
  });
}

function visibleHiveToolNames(role: Role): HiveToolName[] {
  const actions = ROLE_GRANTS[role].actions;
  return (Object.keys(HIVE_TOOL_POLICIES) as HiveToolName[]).filter((name) =>
    actions.includes(HIVE_TOOL_POLICIES[name].action),
  );
}

async function listRoleTools(daemon: HiveDaemon, role: Role) {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(daemon, `schema-${role}`, role) },
  );
  const client = new Client(
    { name: `hive-${role}-schema-test`, version: "1.0.0" },
    { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
  );
  await client.connect(transport);
  try {
    return await client.listTools();
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe("MCP 2026 role-scoped tool catalog", () => {
  test("advertises exactly each role's grant and complete v2 metadata", async () => {
    const daemon = await makeDaemon();
    try {
      const roles: Role[] = ["user", "orchestrator", "writer", "reader"];
      const advertised = new Set<string>();
      for (const role of roles) {
        const listed = await listRoleTools(daemon, role);
        expect(listed.ttlMs).toBe(HIVE_MCP_CATALOG_CACHE_TTL_MS);
        expect(listed.cacheScope).toBe("private");

        const names = listed.tools.map((tool) => tool.name).sort();
        expect(names).toEqual(visibleHiveToolNames(role).sort());
        for (const tool of listed.tools) {
          advertised.add(tool.name);
          const policy =
            HIVE_TOOL_POLICIES[tool.name as keyof typeof HIVE_TOOL_POLICIES];
          expect(tool.annotations).toEqual(policy.annotations);
          expect(tool.outputSchema).toBeDefined();
          for (const outputKey of policy.outputKeys) {
            expect(tool.outputSchema?.properties).toHaveProperty(outputKey);
          }
          if (policy.outputKeys.length === 1) {
            expect(tool.outputSchema?.required).toContain(policy.outputKeys[0]);
          }
        }
      }
      expect([...advertised].sort()).toEqual(
        Object.keys(HIVE_TOOL_POLICIES).sort(),
      );
    } finally {
      await daemon.stop();
    }
  });
});

describe("every MCP tool schema Hive serves is valid Moonshot Flavored JSON Schema", () => {
  test("no tool's inputSchema or outputSchema violates a documented MFJS constraint", async () => {
    const daemon = await makeDaemon();
    try {
      const violations: string[] = [];
      const inspected = new Set<string>();
      for (const role of [
        "user",
        "orchestrator",
        "writer",
        "reader",
      ] as const) {
        const { tools } = await listRoleTools(daemon, role);
        for (const tool of tools) {
          if (inspected.has(tool.name)) continue;
          inspected.add(tool.name);
          walkMoonshotSchema(
            tool.inputSchema,
            `${tool.name}.inputSchema`,
            violations,
          );
          if (tool.outputSchema !== undefined) {
            walkMoonshotSchema(
              tool.outputSchema,
              `${tool.name}.outputSchema`,
              violations,
            );
          }
        }
      }
      expect([...inspected].sort()).toEqual(
        Object.keys(HIVE_TOOL_POLICIES).sort(),
      );
      expect(violations).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });
});
