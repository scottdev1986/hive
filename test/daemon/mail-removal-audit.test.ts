// The audit that makes the cutover irreversible.
//
// Deleting a system once is easy; keeping it deleted is not. Every check here
// fails the build if any part of the terminal notice path comes back — as a
// symbol, as a tool name in a brief, as SQL against a dropped table, as an
// Escape byte, as a re-wireable daemon option, or as an import edge from the
// message service into the session host.
//
// Each scanner is self-tested against a string that SHOULD trip it, so a
// scanner that silently stopped matching fails here rather than passing a clean
// tree by accident. A clean-tree pass alone would prove only that the tree is
// clean, not that anyone would notice if it stopped being.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { HiveDaemonOptions } from "../../src/daemon/server";
import { required } from "../required";

const REPO = join(import.meta.dir, "..", "..");
// `.hive/skills` is not a copy nobody reads: it is what an agent's own
// `.claude/skills` symlinks into, so it is the text a model actually gets. A
// stale tool name there reaches a mind; one in `skills/` only reaches a build.
const SCANNED_ROOTS = [".hive/skills", "src", "test", "qa", "skills"];

/** This file names every banned pattern, so it cannot scan itself. */
const SELF = relative(REPO, import.meta.path);

/**
 * The two places a banned string is evidence rather than a call.
 *
 * The migration test builds the pre-mailbox schema on purpose — it is what the
 * migration is tested against — and the vendor telemetry fixtures are captured
 * wire transcripts from live runs. Rewriting a recording to match today's tool
 * names would falsify an observation, so they are named here instead.
 */
const ALLOWED = (path: string): boolean =>
  path === "test/daemon/mail-migration.test.ts" ||
  path.startsWith("test/daemon/__fixtures__/") ||
  // Codex names assistant output AgentMessage in its generated wire schema;
  // that vendor-owned homonym cannot restore Hive's deleted delivery type.
  path.startsWith(
    "src/adapters/providers/codex-app-server/generated/0.146.0/",
  ) ||
  path === "test/daemon/tool-telemetry.test.ts" ||
  path === "test/adapters/providers/opencode.test.ts" ||
  path === "test/adapters/providers/shared/graphify-hook.test.ts";

const sourceFiles = (): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      // Shipped worker skills are scanned too: they reach every agent at spawn,
      // so a tool name left in one is the same post-restart lie as a brief.
      if ([".ts", ".tsx", ".js", ".md"].includes(extname(path))) {
        found.push(path);
      }
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(REPO, root));
  return found.filter((path) => {
    const repoPath = relative(REPO, path);
    return repoPath !== SELF && !ALLOWED(repoPath);
  });
};

const FILES = sourceFiles().map((path) => ({
  path: relative(REPO, path),
  text: readFileSync(path, "utf8"),
}));

/**
 * The migration is the one place the old names may still appear: it reads those
 * rows once and drops the tables in the same transaction. It is exempted by
 * name rather than by pattern, and the test below proves it is still the
 * migration — a second reader added to this file would have to delete the drops
 * to get past that.
 */
const MIGRATION = "src/mail-service/store.ts";

/**
 * The one file that names the Escape byte without sending one: it strips ANSI
 * out of captured terminal evidence. The invariant is that nothing WRITES an
 * Escape, and a text scan cannot see direction, so this is exempted by name and
 * held to being a redactor by the test below.
 */
const REDACTOR = "src/daemon/status-service/activity-snapshot.ts";

const scan = (pattern: RegExp, exempt: string | null = null): string[] =>
  FILES.filter((file) => file.path !== exempt && pattern.test(file.text)).map(
    (file) => file.path,
  );

/**
 * Symbols the deleted system owned. Any one of them reappearing means a piece
 * of the notice path is back, whether or not it is wired to anything.
 */
const BANNED_SYMBOLS = [
  "MessageDelivery",
  "AgentMessage",
  "SessionSender",
  "RootProtocolDeliverer",
  "flushQueued",
  "flushUrgent",
  "wakeOrchestrator",
  "wakeIdleRecipients",
  "formatNotice",
  "deliverAgentNotice",
  "message_attempts",
  "beginMessageAttempt",
  "hive-notice:",
  "MessageLifecycleState",
  "TerminalDeliveryAttempt",
  "MESSAGE_TERMINAL_CONTRACT",
  "deliveryBlocked",
  "queuedDeliveryNote",
];

/** The four tool names, as literals — briefs and scenario scripts included. */
const BANNED_TOOL_NAMES = [
  "hive_send",
  "hive_inbox",
  "hive_ack_message",
  "hive_read_message",
];

describe("the legacy message path stays deleted", () => {
  test("the scanner sees a violation when there is one", () => {
    // The positive control for every scan below: the same matcher, run against
    // text that should trip it. Without this, an empty result cannot be told
    // apart from a scanner that stopped working.
    for (const symbol of [...BANNED_SYMBOLS, ...BANNED_TOOL_NAMES]) {
      expect(new RegExp(escaped(symbol)).test(`x ${symbol} y`)).toBe(true);
    }
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((file) => file.path.startsWith("qa/"))).toBe(true);
    // The mirror is the newest root and the one an agent actually reads, so it
    // gets the same proof-of-coverage as the rest: a root that silently stopped
    // being walked would otherwise report "clean" forever.
    expect(FILES.some((file) => file.path.startsWith(".hive/skills/"))).toBe(
      true,
    );
    expect(FILES.some((file) => file.path.startsWith("src/"))).toBe(true);
    expect(FILES.some((file) => file.path.startsWith("test/"))).toBe(true);
  });

  test("no source file names a deleted symbol", () => {
    for (const symbol of BANNED_SYMBOLS) {
      const exempt = symbol === "message_attempts" ? MIGRATION : null;
      expect({
        symbol,
        found: scan(new RegExp(escaped(symbol)), exempt),
      }).toEqual({ symbol, found: [] });
    }
  });

  test("no source file names a deleted tool, including briefs and scripts", () => {
    for (const tool of BANNED_TOOL_NAMES) {
      expect({ tool, found: scan(toolPattern(tool)) }).toEqual({
        tool,
        found: [],
      });
    }
  });

  test("a deleted tool name split across string literals is still a name", () => {
    // Concatenation is the cheapest way past a literal scan, and a name
    // assembled at runtime reaches the model exactly as if it were written
    // whole. The scanner ignores quotes, the concatenation user and the
    // whitespace around them, so every split of every name is caught.
    for (const tool of BANNED_TOOL_NAMES) {
      const pattern = toolPattern(tool);
      for (let cut = 1; cut < tool.length; cut += 1) {
        const split = `"${tool.slice(0, cut)}" + "${tool.slice(cut)}"`;
        expect({ split, caught: pattern.test(split) }).toEqual({
          split,
          caught: true,
        });
      }
      expect(
        pattern.test(`'${tool.slice(0, 5)}' +\n  '${tool.slice(5)}'`),
      ).toBe(true);
    }
  });

  test("no source file touches a dropped table, by any statement", () => {
    // Reading was never the only way to use a table: writing to one puts it
    // back just as surely. Case- and whitespace-insensitive, and a schema
    // qualifier does not hide the name either.
    for (const table of ["messages", "message_attempts"]) {
      const sql = new RegExp(
        `(?:from|into|update|join)\\s+(?:main\\.|temp\\.)?${table}\\b`,
        "i",
      );
      expect({ table, found: scan(sql, MIGRATION) }).toEqual({
        table,
        found: [],
      });
      for (const evasion of [
        `SELECT id  FROM   ${table.toUpperCase()} WHERE x`,
        `INSERT INTO ${table} (id) VALUES (?)`,
        `UPDATE ${table} SET state = 'x'`,
        `SELECT id FROM main.${table} WHERE x`,
        `SELECT a FROM other JOIN ${table} ON x`,
      ]) {
        expect({ evasion, caught: sql.test(evasion) }).toEqual({
          evasion,
          caught: true,
        });
      }
    }
  });

  test("nothing under the daemon or the mail service writes an Escape byte", () => {
    // The accelerator that interrupted agents mid-turn. It had exactly one
    // sender, and this keeps the count at zero — in both forms it can take:
    // the escape written into source, and a raw ESC byte pasted in.
    const written = /\\u001b|\\x1b|\\033|fromCharCode\(\s*(?:27|0x1b)\s*\)/i;
    const raw = new RegExp(String.fromCharCode(27));
    for (const [name, pattern] of [
      ["written", written],
      ["raw", raw],
    ] as const) {
      expect({
        name,
        found: FILES.filter(
          (file) =>
            (file.path.startsWith("src/daemon/") ||
              file.path.startsWith("src/mail-service/")) &&
            file.path !== REDACTOR &&
            pattern.test(file.text),
        ).map((file) => file.path),
      }).toEqual({ name, found: [] });
    }
    // Both controls are assembled from their parts, so no editor, formatter or
    // shell can quietly turn either into the character it is looking for.
    const backslash = "\\";
    for (const spelling of [
      `${backslash}u001b`,
      `${backslash}x1b`,
      `${backslash}033`,
      "String.fromCharCode(27)",
      "String.fromCharCode(0x1b)",
    ]) {
      expect({ spelling, caught: written.test(spelling) }).toEqual({
        spelling,
        caught: true,
      });
    }
    expect(raw.test(`x ${String.fromCharCode(27)} y`)).toBe(true);
  });

  test("the daemon has no seam to re-wire terminal delivery through", () => {
    // Type-level, so the check cannot drift from the real options: naming a
    // removed key in a satisfies-checked literal is a compile error, and the
    // grep catches a key added back under the same name anywhere else.
    const options = {
      repoRoot: "/tmp/audit",
    } satisfies Partial<HiveDaemonOptions>;
    expect(options.repoRoot).toBe("/tmp/audit");
    for (const seam of ["sessionSender", "rootProtocol"]) {
      const declared = new RegExp(`\\b${seam}\\b`);
      expect({
        seam,
        found: FILES.filter(
          (file) => file.path.startsWith("src/") && declared.test(file.text),
        ).map((file) => file.path),
      }).toEqual({ seam, found: [] });
      expect(declared.test(`  ${seam}?: unknown;`)).toBe(true);
    }
  });

  test("the message service depends on no session-host or provider module", () => {
    // Walked over real import statements rather than asserted about the two
    // entry files, so a dependency added three modules deep is still caught.
    //
    // The shared database is a leaf here. Everything in the daemon imports it,
    // and the terminal-binding row types it carries are records about
    // terminals, not the ability to write to one — following through it would
    // report the whole daemon as a dependency of everything and measure
    // nothing. What must stay unreachable is the code that can perform a write.
    const visited = new Set<string>();
    const queue = [
      "src/mail-service/store.ts",
      "src/mail-service/mail-tools.ts",
    ];
    const LEAF = "src/daemon/database/hive-database.ts";
    while (queue.length > 0) {
      // SAFETY: The test owns this value and its fields.
      const current = queue.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      const text = FILES.find((file) => file.path === current)?.text;
      if (text === undefined || current === LEAF) continue;
      for (const match of text.matchAll(/from "(\.[^"]+)"/g)) {
        // SAFETY: The test owns this value and its fields.
        const resolved = resolveImport(current, match[1] as string);
        if (resolved !== null) queue.push(resolved);
      }
    }
    // The modules that can put bytes into a terminal, and the adapters that
    // launch the vendors. Neither is reachable from the message service.
    expect(
      [...visited].filter(
        (path) =>
          path.includes("sessiond-agent-input") ||
          path.includes("sessiond-viewer-attach") ||
          path.startsWith("src/adapters/providers/"),
      ),
    ).toEqual([]);
    // The walk reaches past the entry files, so an empty result above means
    // "nothing there", not "the walk stopped at the door".
    expect(visited.size).toBeGreaterThan(3);
    expect(visited).toContain("src/schemas/mail.ts");
  });

  test("the one file that names an Escape only ever strips it", () => {
    // What makes the exemption safe: this file removes the byte from evidence
    // it captured. If it ever gains a way to send input, the exemption is
    // covering a writer and this fails.
    const redactor = required(
      FILES.find((file) => file.path === REDACTOR),
    ).text;
    expect(redactor).toContain('replaceAll(ANSI, "")');
    for (const write of ["injectAutomated", "writeAutomated", "injectKeys"]) {
      expect({ write, present: redactor.includes(write) }).toEqual({
        write,
        present: false,
      });
    }
  });

  test("the migration's own legacy statements are exactly these three", () => {
    // What makes the exemption above safe. Exempting the file would hide a
    // second reader added to it, so the exemption is pinned to the statements
    // themselves: one read of the rows being moved, and the two drops that end
    // the table's life. A fourth line mentioning either table fails here.
    const migration = required(
      FILES.find((file) => file.path === MIGRATION),
    ).text;
    const statements = [
      ...migration.matchAll(
        /.*(?:from\s+messages|drop\s+table\s+messages|message_attempts).*/gi,
      ),
    ].map((match) => match[0].trim());
    expect(statements).toEqual([
      "FROM messages",
      'db.database.exec("DROP TABLE message_attempts");',
      'db.database.exec("DROP TABLE messages");',
    ]);
  });

  test("a fresh database has the mailbox and neither dropped table", () => {
    const db = new HiveDatabase(":memory:");
    const tables = new Set(
      // SAFETY: The test owns this value and its fields.
      (
        db.database
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    for (const table of [
      "mail_items",
      "mail_events",
      "mail_leases",
      "mail_sequences",
      "mail_dead_letters",
    ]) {
      expect({ table, present: tables.has(table) }).toEqual({
        table,
        present: true,
      });
    }
    expect(tables.has("messages")).toBe(false);
    expect(tables.has("message_attempts")).toBe(false);
    db.close();
  });
});

/**
 * A tool name, however it is spelled out.
 *
 * Quotes, the concatenation user and the whitespace around them are allowed
 * between any two characters, so a name broken into pieces to get past a
 * literal scan is matched the same as one written whole.
 */
function toolPattern(tool: string): RegExp {
  return new RegExp([...tool].map(escaped).join("[\"'\\s+`]*"));
}

function escaped(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** A relative import as a repo path, or null when it leaves the scanned tree. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const directory = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") directory.pop();
    else directory.push(part);
  }
  const base = directory.join("/");
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (FILES.some((file) => file.path === candidate)) return candidate;
  }
  return null;
}
