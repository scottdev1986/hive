import {
  type MemoryFact,
  MemoryFactSchema,
  type MemoryScope,
  MemorySourceSchema,
  normalizeMemorySource,
} from "../schemas/memory";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseList(raw: string): string[] {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return trimmed.length === 0
    ? []
    : trimmed
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

function serializeList(values: string[]): string {
  return `[${values.join(", ")}]`;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function serializeMemoryFile(
  fact: Pick<
    MemoryFact,
    | "title"
    | "date"
    | "topic"
    | "source"
    | "evidence"
    | "status"
    | "kind"
    | "supersedes"
    | "raw"
    | "tags"
    | "body"
  > &
    Partial<Pick<MemoryFact, "verified" | "author">>,
): string {
  const lines = [
    "---",
    `title: ${oneLine(fact.title)}`,
    `updated: ${fact.date}`,
    `topic: ${fact.topic}`,
    `source: ${fact.source}`,
    `status: ${fact.status}`,
  ];
  if (fact.kind === "pitfall") lines.push(`kind: ${fact.kind}`);
  if (fact.author !== undefined) lines.push(`author: ${fact.author}`);
  if (fact.verified !== undefined) lines.push(`verified: ${fact.verified}`);
  lines.push(
    `evidence: ${oneLine(fact.evidence)}`,
    `tags: ${serializeList(fact.tags)}`,
    `supersedes: ${serializeList(fact.supersedes)}`,
    `raw: ${serializeList(fact.raw)}`,
    "---",
    "",
    fact.body.trimEnd(),
    "",
  );
  return lines.join("\n");
}

export function parseMemoryFile(
  id: string,
  scope: MemoryScope,
  path: string,
  contents: string,
): MemoryFact {
  const lines = contents.split(/\r?\n/);
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (lines[0]?.trim() !== "---" || closingIndex < 1) {
    throw new Error(`Malformed compiled memory article: ${path}`);
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  const rawSource = fields.get("source");
  const source =
    rawSource === undefined
      ? ({ success: false } as const)
      : MemorySourceSchema.safeParse(normalizeMemorySource(rawSource));
  return MemoryFactSchema.parse({
    id,
    scope,
    topic: fields.get("topic"),
    title: fields.get("title"),
    body: lines
      .slice(closingIndex + 1)
      .join("\n")
      .trim(),
    tags: parseList(fields.get("tags") ?? "[]"),
    date: fields.get("updated"),
    path,
    source: source.success ? source.data : undefined,
    evidence: fields.get("evidence"),
    status: fields.get("status"),
    kind: fields.get("kind"),
    supersedes: parseList(fields.get("supersedes") ?? "[]"),
    raw: parseList(fields.get("raw") ?? "[]"),
    verified: ISO_DATE.test(fields.get("verified") ?? "")
      ? fields.get("verified")
      : undefined,
    author: fields.get("author"),
  });
}

export { parseList, serializeList };
