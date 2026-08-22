import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");

/** A source tree as the rules see it: repo-relative path to file text. */
type Sources = ReadonlyMap<string, string>;

function readSources(root: string): Sources {
  const sources = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if ([".ts", ".tsx"].includes(extname(path))) {
        sources.set(relative(REPO, path), readFileSync(path, "utf8"));
      }
    }
  };
  walk(join(root, "src"));
  return sources;
}

const SRC = readSources(REPO);

/**
 * Every relative edge out of one module.
 *
 * `export ... from` is matched the same as `import ... from`: a re-export
 * couples two modules exactly as an import does, and a rule that saw only
 * imports would be silent about a layer violation laundered through an index
 * file. Type-only imports count too — `import type` is erased at runtime, but
 * the compile-time dependency between the layers is real and is what these
 * rules are about.
 */
function importsOf(sources: Sources, file: string): string[] {
  const text = sources.get(file);
  if (text === undefined) return [];
  const found: string[] = [];
  for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const directory = file.split("/").slice(0, -1);
    for (const segment of (match[1] as string).split("/")) {
      if (segment === ".") continue;
      if (segment === "..") directory.pop();
      else directory.push(segment);
    }
    const base = directory.join("/");
    const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (candidate) => sources.has(candidate),
    );
    if (target !== undefined && target !== file) found.push(target);
  }
  for (const match of text.matchAll(/import\("(\.[^"]+)"\)/g)) {
    const directory = file.split("/").slice(0, -1);
    for (const segment of (match[1] as string).split("/")) {
      if (segment === ".") continue;
      if (segment === "..") directory.pop();
      else directory.push(segment);
    }
    const base = directory.join("/");
    const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (candidate) => sources.has(candidate),
    );
    if (target !== undefined && target !== file) found.push(target);
  }
  return found;
}

// ---------------------------------------------------------------------------
// R1 — who may address the daemon
// ---------------------------------------------------------------------------

/**
 * The modules allowed to build a daemon application request.
 *
 * There are two on purpose and they share no request helper: the user
 * client can present the user credential and the pane client can only ever
 * speak for one agent. Merging them would put the user credential path
 * within reach of a process that speaks for a single agent, so the duplication
 * between them is the boundary, not an oversight.
 *
 * Swift's WorkspaceDaemonClient is the third owner. It cannot appear in this
 * scan because it is not TypeScript, which is why the rule reads as two.
 */
const OWNED_DAEMON_CLIENTS: readonly string[] = [
  "src/cli/user-daemon-client.ts",
  "src/cli/agent-ui/pane-daemon-client.ts",
];

/**
 * Endpoints that are their own protocol rather than daemon application traffic.
 *
 * A handshake or health probe asks "which daemon is this, and is it alive" —
 * it runs BEFORE a client can be trusted, so requiring it to go through a
 * client would be circular. `/mcp` is a transport that vendors and the MCP SDK
 * address directly, and most of its appearances are configuration strings
 * handed to a vendor rather than requests at all.
 *
 * Without this carve-out the rule would fire on twenty call sites that are all
 * correct, and a rule that cries wolf twenty times gets an allowlist bolted on
 * and stops meaning anything.
 */
const SEPARATELY_OWNED_PROTOCOLS: readonly string[] = [
  "/handshake",
  "/health",
  "/mcp",
];

/** Modules that build a daemon application URL without being allowed to. */
function unownedDaemonRequests(sources: Sources): string[] {
  const found: string[] = [];
  for (const [file, text] of sources) {
    if (OWNED_DAEMON_CLIENTS.includes(file)) continue;
    // The port is always interpolated, so the literal that follows it is the
    // path. An empty capture means the path is interpolated too, which is a
    // general-purpose client and exactly what only the owned two may be.
    for (const match of text.matchAll(
      /http:\/\/127\.0\.0\.1:\$\{[^}]*\}([^`"'\s$\\]*)/g,
    )) {
      const path = match[1] as string;
      if (SEPARATELY_OWNED_PROTOCOLS.includes(path)) continue;
      found.push(`${file} ${path === "" ? "(interpolated path)" : path}`);
    }
  }
  return found.sort();
}

describe("R1 — who may address the daemon", () => {
  test("no module outside the owned clients builds a daemon request", () => {
    expect(unownedDaemonRequests(SRC)).toEqual([]);
  });

  test("the rule refuses a new caller that builds its own daemon URL", () => {
    // Without this the assertion above is indistinguishable from a regex that
    // stopped matching anything at all.
    const violating: Sources = new Map([
      [
        "src/cli/rogue.ts",
        `await fetch(\`http://127.0.0.1:\${port}/agent-status\`, init);`,
      ],
    ]);
    expect(unownedDaemonRequests(violating)).toEqual([
      "src/cli/rogue.ts /agent-status",
    ]);
  });

  test("the rule leaves the separately owned protocols alone", () => {
    // The other half of the control: a scanner that flagged every localhost
    // string would also "catch" the violation above.
    const legal: Sources = new Map([
      [
        "src/daemon/lifecycle/daemon-lifecycle.ts",
        `await fetch(\`http://127.0.0.1:\${port}/handshake\`, init);
await fetch(\`http://127.0.0.1:\${port}/health\`, init);
const url = \`http://127.0.0.1:\${port}/mcp\`;`,
      ],
    ]);
    expect(unownedDaemonRequests(legal)).toEqual([]);
  });

  test("the rule refuses a general-purpose client outside the owned two", () => {
    // A third client with an interpolated path is the failure this rule most
    // needs to catch: it is not one endpoint, it is a way to reach all of them.
    const violating: Sources = new Map([
      [
        "src/daemon/second-client.ts",
        `await this.fetcher(\`http://127.0.0.1:\${this.port}\${path}\`, init);`,
      ],
    ]);
    expect(unownedDaemonRequests(violating)).toEqual([
      "src/daemon/second-client.ts (interpolated path)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// R2 — who may write a compiled article
// ---------------------------------------------------------------------------

/**
 * The one module that writes a compiled article and both of its projections.
 *
 * An article exists in three places at once — the file, the keyword row and the
 * vector — and only this module keeps them agreeing. A second writer that wrote
 * the file and neither index has already happened here: same input, same store,
 * an article no search could reach.
 */
const COMPILED_ARTICLE_WRITER = "src/memory-service/write-service.ts";

/**
 * Modules that call the underlying file write directly, and why each is not the
 * defect above.
 *
 * These are exceptions a reader can evaluate, which is the point of writing
 * them down rather than pattern-matching them away. None of them can be fixed
 * by routing through the service: each would need the service to write WITHOUT
 * indexing, and widening the invariant to satisfy the rule that guards it is
 * the rule defeating itself.
 */
const DIRECT_WRITER_EXCEPTIONS: Readonly<Record<string, string>> = {
  // Bootstrap writer: no index exists yet, indexing deferred via reindexMemory.
  "src/cli/init.ts": "hive init runs before any daemon or index exists",
  // Drives the file write and the index upsert as SEPARATE steps against its
  // own throwaway in-memory index, because the seam between them is the thing
  // it exists to probe. Routed through the service it would test the service
  // instead of the layers under it.
  "src/memory-service/self-test.ts":
    "the canary probes the write/index seam itself",
  // Only the no-live-daemon branch writes without the service: it constructs
  // no index, while the live branch supplies the daemon's writer.
  "src/memory-service/consolidate.ts":
    "offline consolidation has no index in process",
};

/** Modules that write a compiled article without being the writer or an
 * acknowledged exception. */
function unownedArticleWriters(sources: Sources): string[] {
  const found: string[] = [];
  for (const [file, text] of sources) {
    if (file === COMPILED_ARTICLE_WRITER) continue;
    if (file in DIRECT_WRITER_EXCEPTIONS) continue;
    // The binding itself, not a mention. Most of src/memory-service names
    // writeMemoryFact as an injected dependency and is being handed the
    // service's own write; two more only name it in prose. What makes a second
    // writer is importing the file write from the store.
    for (const match of text.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"[^"]*\/store"/g,
    )) {
      if (/\bwriteMemoryFact\b/.test(match[1] as string)) found.push(file);
    }
  }
  return found.sort();
}

describe("R2 — who may write a compiled article", () => {
  test("only the write service writes an article, exceptions aside", () => {
    expect(unownedArticleWriters(SRC)).toEqual([]);
  });

  test("every acknowledged exception still exists and still writes", () => {
    // An exception for a module that stopped writing is dead weight that makes
    // the list look scarier than the tree is, and an exception for a module
    // that was deleted hides the next one added under the same name.
    for (const file of Object.keys(DIRECT_WRITER_EXCEPTIONS)) {
      const text = SRC.get(file);
      expect({
        file,
        writes: text !== undefined && /\bwriteMemoryFact\b/.test(text),
      }).toEqual({ file, writes: true });
    }
  });

  test("the rule refuses a new direct writer", () => {
    const violating: Sources = new Map([
      [
        "src/cli/rogue.ts",
        'import { writeMemoryFact } from "../memory-service/store";\n' +
          "await writeMemoryFact(root, input);",
      ],
    ]);
    expect(unownedArticleWriters(violating)).toEqual(["src/cli/rogue.ts"]);
  });

  test("the rule leaves a module that receives the write as a dependency", () => {
    // The other half of the control. Most of src/memory-service names writeMemoryFact
    // as an injected dep, and a rule that flagged those would be unusable.
    const legal: Sources = new Map([
      [
        "src/memory-service/library.ts",
        "interface Deps { writeMemoryFact: (input: X) => Promise<Y> }\n" +
          "await deps.writeMemoryFact(input);",
      ],
    ]);
    expect(unownedArticleWriters(legal)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R3 — the layer DAG
// ---------------------------------------------------------------------------

/**
 * What each layer may import. `shared` is the leaf below `schemas`; `cli` is the composition
 * layer and may reach everything below it. A layer may always import itself.
 *
 * `workspace` is absent on purpose: it is a Swift artifact and imports no
 * TypeScript, so it cannot appear in this graph at all.
 *
 * Directories under `src/` that are not named here (config, release, skills,
 * update-service) are unowned by this rule and neither constrain nor are constrained.
 */
const LAYER_MAY_IMPORT: Readonly<Record<string, readonly string[]>> = {
  shared: [],
  persistence: ["shared"],
  schemas: ["shared"],
  adapters: ["schemas", "shared"],
  "usage-service": ["adapters", "persistence", "schemas", "shared"],
  "memory-service": [
    "adapters",
    "persistence",
    "usage-service",
    "schemas",
    "shared",
  ],
  "mail-service": ["persistence", "schemas", "shared"],
  daemon: [
    "adapters",
    "mail-service",
    "memory-service",
    "persistence",
    "usage-service",
    "schemas",
    "shared",
  ],
  cli: [
    "adapters",
    "mail-service",
    "memory-service",
    "persistence",
    "usage-service",
    "schemas",
    "shared",
    "daemon",
  ],
};

/** The named layer a module belongs to, or null when the rule does not own it. */
function layerOf(path: string): string | null {
  const parts = path.split("/");
  if (parts[0] !== "src" || parts.length < 3) return null;
  const directory = parts[1] as string;
  return directory in LAYER_MAY_IMPORT ? directory : null;
}

/** Every edge the layer map forbids, as `from -> to`, sorted. */
function forbiddenLayerEdges(sources: Sources): string[] {
  const found = new Set<string>();
  for (const file of sources.keys()) {
    const from = layerOf(file);
    if (from === null) continue;
    for (const target of importsOf(sources, file)) {
      const to = layerOf(target);
      if (to === null || to === from) continue;
      if ((LAYER_MAY_IMPORT[from] as readonly string[]).includes(to)) continue;
      found.add(`${file} -> ${target}`);
    }
  }
  return [...found].sort();
}

/**
 * The edges that violate the layer map today, every one of them named.
 *
 * THIS LIST MAY ONLY SHRINK. The count is asserted separately, so adding a
 * thirty-first entry is a deliberate act a reviewer sees rather than a quiet
 * append — an allowlist that only ever grows is a permanent second architecture,
 * and the count assertion is the only thing that stops it becoming one. There is
 * no wildcard here and no skip: a violation is either fixed or written down.
 *
 * The unit is the exact `from -> to` pair rather than the importing file. If it
 * were the file, a module already on the list could acquire new forbidden
 * targets forever without the count moving.
 */
const KNOWN_FORBIDDEN_EDGES: readonly string[] = [
  // Graphify provisioning reads the daemon's per-project state dir.
  "src/adapters/graphify.ts -> src/daemon/project-identity-core/state.ts",
  // The Codex session reads the daemon's model-capability records.
  "src/adapters/providers/codex-app-server/session.ts -> src/daemon/provider-capabilities/discovery.ts",
  // ...and computes context occupancy with the usage service's own helper.
  "src/adapters/providers/codex-app-server/session.ts -> src/usage-service/context-occupancy.ts",
  // The ACP normalizer reports context occupancy with the usage helper.
  "src/adapters/providers/protocol/acp-normalize.ts -> src/usage-service/context-occupancy.ts",
  // The Claude stream adapter reads the daemon's model-capability records.
  "src/adapters/providers/protocol/claude-stream-session.ts -> src/daemon/provider-capabilities/discovery.ts",
  // Mail reports its own delivery failures into the daemon's log sink.
  "src/mail-service/service.ts -> src/daemon/observability/daemon-log.ts",
  // Episodic memory stores its database under the daemon's project state dir.
  "src/memory-service/episodic.ts -> src/daemon/project-identity-core/state.ts",
  // Memory query and tools read status freshness from the status service.
  "src/memory-service/query.ts -> src/daemon/status-service/status-service.ts",
  // Recall names the user subject to exclude it from agent recall.
  "src/memory-service/recall.ts -> src/daemon/authorization/credentials.ts",
  // The memory MCP tools register through the daemon's policy registrar.
  "src/memory-service/memory-tools.ts -> src/daemon/authorization/mcp-tool-policy.ts",
  // The protocol facts report talks to the daemon through the pane's client.
  "src/usage-service/protocol-facts-report.ts -> src/cli/agent-ui/pane-daemon-client.ts",
  // The quota ledger is keyed by daemon instance and checks its liveness.
  "src/usage-service/quota-ledger.ts -> src/daemon/lifecycle/daemon-lifecycle.ts",
  // The quota MCP tools register through the daemon's policy registrar and
  // read its model inventory.
  "src/usage-service/quota-tools.ts -> src/daemon/authorization/mcp-tool-policy.ts",
  "src/usage-service/quota-tools.ts -> src/daemon/provider-capabilities/model-inventory.ts",
  // Spending against a quota requires the daemon's authorized-launch proof.
  "src/usage-service/usage-quota.ts -> src/daemon/routing-service/authorized-launch.ts",
  // The token usage client detects the test runner and speaks to the daemon
  // through the user client.
  "src/usage-service/token-usage-client.ts -> src/cli/invoker.ts",
  "src/usage-service/token-usage-client.ts -> src/cli/user-daemon-client.ts",
];

/**
 * Strongly connected components that span more than one named layer.
 *
 * A cycle inside one layer is a shape its owner can refactor. A cycle ACROSS
 * layers means the layer boundary is not real in that region, which is what
 * this rule is about, so components confined to a single layer are not reported.
 */
function layerSpanningCycles(sources: Sources): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const connect = (root: string): void => {
    // Iterative Tarjan: the real graph is deep enough that recursion here is a
    // stack overflow waiting for the tree to grow.
    const work: Array<{ node: string; edge: number }> = [
      { node: root, edge: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work.at(-1) as { node: string; edge: number };
      const edges = importsOf(sources, frame.node);
      if (frame.edge < edges.length) {
        const next = edges[frame.edge] as string;
        frame.edge += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node) as number, index.get(next) as number),
          );
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent !== undefined) {
        low.set(
          parent.node,
          Math.min(
            low.get(parent.node) as number,
            low.get(frame.node) as number,
          ),
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        const layers = new Set(
          component.map(layerOf).filter((layer) => layer !== null),
        );
        if (component.length > 1 && layers.size > 1) {
          components.push(component.sort());
        }
      }
    }
  };

  for (const file of sources.keys()) if (!index.has(file)) connect(file);
  return components.sort((a, b) =>
    (a[0] as string).localeCompare(b[0] as string),
  );
}

describe("R3 — the layer DAG", () => {
  test("the tree has exactly the forbidden edges that are written down", () => {
    expect(forbiddenLayerEdges(SRC)).toEqual([...KNOWN_FORBIDDEN_EDGES].sort());
  });

  test("the ratchet is the size it claims, so a new entry is deliberate", () => {
    // Asserted separately from the comparison above. Without this, a
    // nineteenth violation could be legalised by appending one line to the
    // list, and the suite would stay green with nobody the wiser.
    expect(KNOWN_FORBIDDEN_EDGES).toHaveLength(17);
    expect(new Set(KNOWN_FORBIDDEN_EDGES).size).toBe(17);
  });

  test("the layer rule refuses an edge that is not on the list", () => {
    // schemas is the leaf and may import nothing, so this is the cheapest
    // possible violation to construct — and if the scanner ever stops seeing
    // it, every empty result above becomes meaningless.
    const violating: Sources = new Map([
      ["src/schemas/thing.ts", 'import { x } from "../daemon/db";'],
      ["src/daemon/db.ts", "export const x = 1;"],
    ]);
    expect(forbiddenLayerEdges(violating)).toEqual([
      "src/schemas/thing.ts -> src/daemon/db.ts",
    ]);
  });

  test("the layer rule allows an edge the map permits", () => {
    // The other half of the control: a scanner that reported everything would
    // also "catch" the violation above.
    const legal: Sources = new Map([
      ["src/adapters/thing.ts", 'import type { X } from "../schemas/mail";'],
      ["src/schemas/mail.ts", "export type X = 1;"],
    ]);
    expect(forbiddenLayerEdges(legal)).toEqual([]);
  });

  test("the layer rule sees a violation laundered through a re-export", () => {
    const reexport: Sources = new Map([
      ["src/schemas/thing.ts", 'export { x } from "../daemon/db";'],
      ["src/daemon/db.ts", "export const x = 1;"],
    ]);
    expect(forbiddenLayerEdges(reexport)).toEqual([
      "src/schemas/thing.ts -> src/daemon/db.ts",
    ]);
  });

  test("no cycle spans named layers", () => {
    expect(layerSpanningCycles(SRC)).toEqual([]);
  });

  test("the cycle rule refuses a new cycle across layers", () => {
    const cyclic: Sources = new Map([
      ["src/mail-service/a.ts", 'import { b } from "../usage-service/b";'],
      ["src/usage-service/b.ts", 'import { a } from "../mail-service/a";'],
    ]);
    expect(layerSpanningCycles(cyclic)).toEqual([
      ["src/mail-service/a.ts", "src/usage-service/b.ts"],
    ]);
  });

  test("the cycle rule ignores a cycle inside one layer", () => {
    // Three such components exist in the tree today. They are a layer owner's
    // business, and reporting them here would bury the one that is not.
    const internal: Sources = new Map([
      ["src/usage-service/a.ts", 'import { b } from "./b";'],
      ["src/usage-service/b.ts", 'import { a } from "./a";'],
    ]);
    expect(layerSpanningCycles(internal)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R4 — who may issue SQL
// ---------------------------------------------------------------------------

/**
 * Modules that own SQLite persistence.
 *
 * This is intentionally an exact list, not a filename convention. A suffix
 * such as `-store.ts` is useful communication but a scanner that trusted the
 * suffix would let any service rename itself into permission. New persistence
 * gets a named owner here; ordinary services depend on that owner instead of
 * reaching through `HiveDatabase.database`.
 */
const SQL_OWNERS: readonly string[] = [
  "src/daemon/capability-snapshot-store.ts",
  "src/daemon/database/access-store.ts",
  "src/daemon/database/agent-store.ts",
  "src/daemon/database/event-store.ts",
  "src/daemon/database/history-store.ts",
  "src/daemon/database/hive-database.ts",
  "src/daemon/database/identity.ts",
  "src/daemon/database/runtime-store.ts",
  "src/daemon/database/schema.ts",
  "src/daemon/hierarchy-store.ts",
  "src/daemon/manifest-journal.ts",
  "src/daemon/mutation-lease.ts",
  "src/daemon/observability/observability-store.ts",
  "src/daemon/queen-provider-store.ts",
  "src/daemon/routing-decision-store.ts",
  "src/daemon/routing-policy-store.ts",
  "src/daemon/status/status-store.ts",
  "src/daemon/succession-store.ts",
  "src/mail-service/store.ts",
  "src/mail-service/wake-store.ts",
  "src/memory-service/episodic.ts",
  "src/memory-service/fts-index.ts",
  "src/memory-service/query.ts",
  "src/usage-service/quota-ledger.ts",
  "src/usage-service/token-usage.ts",
];

/** A direct call through a raw SQLite handle, including `db.database.query`. */
const DIRECT_SQL_CALL =
  /\b(?:[A-Za-z_$][\w$]*\.)?database\s*\.\s*(?:exec|query|run|transaction)\s*\(/m;

function directSqlOwners(sources: Sources): string[] {
  return [...sources]
    .filter(([, text]) => DIRECT_SQL_CALL.test(text))
    .map(([file]) => file)
    .sort();
}

describe("R4 — who may issue SQL", () => {
  test("only named persistence owners call the raw database", () => {
    expect(directSqlOwners(SRC)).toEqual([...SQL_OWNERS].sort());
  });

  test("every named owner still exists and still issues SQL", () => {
    for (const file of SQL_OWNERS) {
      expect({
        file,
        ownsSql: DIRECT_SQL_CALL.test(SRC.get(file) ?? ""),
      }).toEqual({ file, ownsSql: true });
    }
  });

  test("the rule refuses SQL embedded in a service", () => {
    const violating: Sources = new Map([
      [
        "src/daemon/rogue-service.ts",
        'export const load = (db: HiveDatabase) => db.database.query("SELECT 1").get();',
      ],
    ]);
    expect(directSqlOwners(violating)).toEqual(["src/daemon/rogue-service.ts"]);
  });

  test("the rule recognizes multiline calls used by stores", () => {
    const store: Sources = new Map([
      [
        "src/mail-service/store.ts",
        "const row = this.db.database\n  .query(sql)\n  .get();",
      ],
    ]);
    expect(directSqlOwners(store)).toEqual(["src/mail-service/store.ts"]);
  });
});

// ---------------------------------------------------------------------------
// R5 — the old database barrel stays deleted
// ---------------------------------------------------------------------------

function legacyDatabaseBarrels(sources: Sources): string[] {
  return [...sources.keys()]
    .filter((file) => file === "src/daemon/db.ts")
    .sort();
}

describe("R5 — the old database barrel stays deleted", () => {
  test("the old database barrel does not exist", () => {
    expect(legacyDatabaseBarrels(SRC)).toEqual([]);
  });

  test("the rule refuses a reintroduced barrel", () => {
    const violating: Sources = new Map([
      ["src/daemon/db.ts", 'export { HiveDatabase } from "./database";'],
    ]);
    expect(legacyDatabaseBarrels(violating)).toEqual(["src/daemon/db.ts"]);
  });
});
