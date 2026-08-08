// The Memory Library: one unified, paginated list across every kind of thing Hive remembers, and the fenced mutation path that edits it. Why a new list rather than memory_search/memory_read: search ranks by relevance to a query and read fetches one known id. Neither can walk the whole corpus once, in a stable order, without repeating or skipping a row when something is written mid-walk — which is exactly what a paginated screen does. And neither returns facts, digests, or raw evidence at all. STABILITY IS THE POINT. Rows are ordered by `key` — kind, then scope, then id, with numeric ids zero-padded so they sort numerically — and a page is "the next N keys after the cursor". That order is a property of each row's own identity, so a row written mid-walk lands at its own key and never renumbers a key the client is already holding. Ordering by date or by relevance would shift rows under the cursor on every write, showing one row twice and skipping another.

import {
  type MemoryFact,
  type MemoryScope,
  type MemoryWriteInput,
  MemoryWriteInputSchema,
} from "../schemas/memory";
import {
  type MemoryListItem,
  type MemoryListPage,
  MemoryListPageSchema,
  type MemoryListRequest,
  MemoryListRequestSchema,
  type MemoryMutationRequest,
  type MemoryMutationResult,
  MemoryMutationResultSchema,
} from "../schemas/memory-projections";
import type { EpisodicStore } from "./episodic";
import {
  listRawObservations,
  revisionOf,
  wikiScopeExists,
  withMemoryEnvelope,
} from "./projections";
import { discoverMemoryFacts, readMemoryFact } from "./memory-store";
import { serializeMemoryFile } from "./article-format";

const rowKey = (kind: string, scope: string, id: string): string =>
  `${kind} ${scope} ${id}`;

/** An article's revision is the hash of its canonical serialization, not of the bytes on disk: a reader and a writer both go through the same parse-then-serialize path, so a hand-edited file's cosmetic differences do not read as a phantom concurrent edit. */
export function articleRevision(fact: MemoryFact): string {
  return revisionOf(serializeMemoryFile(fact));
}

function articleItem(fact: MemoryFact): MemoryListItem {
  const kind = fact.kind === "pitfall" ? "pitfall" : "article";
  const fields = {
    key: rowKey(kind, fact.scope, fact.id),
    scope: fact.scope,
    id: fact.id,
    title: fact.title,
    topic: fact.topic,
    updated: fact.date,
    revision: articleRevision(fact),
    source: fact.source,
    status: fact.status,
    verified: fact.verified ?? null,
    supersedes: fact.supersedes,
    rawRefs: fact.raw,
    evidence: fact.evidence,
  };
  return kind === "pitfall"
    ? { kind: "pitfall", ...fields }
    : { kind: "article", ...fields };
}

export interface MemoryLibraryDeps {
  repoRoot: string;
  /** null = this daemon has no episodic store, so facts and digests are absent from the corpus rather than empty in it. */
  episodic: EpisodicStore | null;
}

/** Every row of the corpus, in key order. Read whole, then sliced. The corpus is a few hundred rows spread across four stores with no shared index to join on, so one pass and a slice is both the simplest implementation and the one that makes the stable order self-evident. If a corpus ever outgrows that, the ordering contract above is what a keyset query would have to preserve. */
async function collectRows(
  deps: MemoryLibraryDeps,
): Promise<{ items: MemoryListItem[]; anyStore: boolean }> {
  const items: MemoryListItem[] = [];
  // Whether a store EXISTS, never whether it produced rows. Inferring existence from a row count reports a freshly initialized project — wiki directories built, nothing written yet — as `absent` rather than `empty`, and a user reading that believes a fresh install is a wiped one.
  let anyStore = deps.episodic !== null;

  for (const scope of ["repo", "global"] as MemoryScope[]) {
    if (await wikiScopeExists(deps.repoRoot, scope)) anyStore = true;
    for (const fact of await discoverMemoryFacts(deps.repoRoot, scope).catch(
      () => [],
    )) {
      items.push(articleItem(fact));
    }
    for (const raw of await listRawObservations(deps.repoRoot, scope)) {
      items.push({
        kind: "raw-ref",
        key: rowKey("raw-ref", scope, raw.id),
        scope,
        id: raw.id,
        title: raw.id,
        topic: raw.topic,
        updated: raw.date,
        revision: revisionOf(`${raw.path}:${raw.bytes}`),
        source: "raw-observation",
        status: "immutable",
        path: raw.path,
        bytes: raw.bytes,
      });
    }
  }

  items.sort((left, right) => (left.key < right.key ? -1 : 1));
  return { items, anyStore };
}

export async function buildMemoryListPage(
  deps: MemoryLibraryDeps,
  request: MemoryListRequest = {},
): Promise<MemoryListPage> {
  const input = MemoryListRequestSchema.parse(request);
  const { items, anyStore } = await collectRows(deps);
  const { kinds, scopes, statuses } = input;
  const matched = items.filter(
    (item) =>
      (kinds == null || kinds.includes(item.kind)) &&
      (scopes == null || scopes.includes(item.scope)) &&
      (statuses == null || statuses.includes(item.status)),
  );
  const cursor = input.cursor ?? null;
  const after =
    cursor === null ? matched : matched.filter((item) => item.key > cursor);
  const page = after.slice(0, input.limit);
  const last = page.at(-1);
  return MemoryListPageSchema.parse(
    withMemoryEnvelope({
      state: !anyStore ? "absent" : matched.length === 0 ? "empty" : "ok",
      items: page,
      nextCursor:
        last !== undefined && after.length > page.length ? last.key : null,
      total: matched.length,
    }),
  );
}

export interface MemoryMutationDeps {
  repoRoot: string;
  /** Run an operation inside the daemon's memory critical section — the same one every other memory write takes. The fence read and the write it guards MUST happen inside one of these. Checking the revision and then writing outside the lock is a time-of-check-to-time-of-use hole: two editors read the same revision, both fences pass, both write, and the second silently discards the first while reporting success. The operations below therefore receive the UNSERIALIZED write and delete primitives — taking the lock again inside would deadlock against the one already held. */
  serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  writeMemoryFact: (
    input: MemoryWriteInput,
  ) => Promise<{ scope: MemoryScope; id: string }>;
  deleteMemoryFact: (scope: MemoryScope, id: string) => Promise<boolean>;
}

type Fence =
  | { ok: true; fact: MemoryFact }
  | { ok: false; result: MemoryMutationResult };

async function fence(
  repoRoot: string,
  scope: MemoryScope,
  id: string,
  expectedRevision: string,
): Promise<Fence> {
  const fact = await readMemoryFact(repoRoot, scope, id);
  const current = fact === null ? null : articleRevision(fact);
  if (fact === null || current !== expectedRevision) {
    return {
      ok: false,
      result: MemoryMutationResultSchema.parse({
        state: "conflict",
        scope,
        id,
        currentRevision: current,
        detail:
          fact === null
            ? `[${scope}] ${id} no longer exists`
            : `[${scope}] ${id} has changed since revision ${expectedRevision}`,
      }),
    };
  }
  return { ok: true, fact };
}

/** The articles the delete guard would refuse for, as data. Naming them is the whole value of the refusal; "referenced" on its own is unactionable. */
async function referrers(
  repoRoot: string,
  scope: MemoryScope,
  id: string,
): Promise<string[]> {
  return (await discoverMemoryFacts(repoRoot, scope))
    .filter((other) => other.id !== id && other.supersedes.includes(id))
    .map((other) => other.id);
}

async function applied(
  repoRoot: string,
  scope: MemoryScope,
  id: string,
): Promise<MemoryMutationResult> {
  // Read the revision back off disk rather than hashing what was sent: the write path normalizes fields, and the client's next edit has to fence on what is actually stored.
  const written = await readMemoryFact(repoRoot, scope, id);
  return MemoryMutationResultSchema.parse({
    state: "applied",
    scope,
    id,
    revision: written === null ? null : articleRevision(written),
  });
}

/** Everything below runs inside the caller's memory critical section: the fence read, the guard, the write, and the readback. */
async function mutateLocked(
  deps: MemoryMutationDeps,
  request: MemoryMutationRequest,
): Promise<MemoryMutationResult> {
  if (request.action === "create") {
    const input = MemoryWriteInputSchema.parse(request.input);
    // Create carries no revision, so it must never land on an article that already exists — that is a blind overwrite THROUGH the door the update path's fence is guarding. The underlying write treats a known id plus a self-supersede as a legitimate update, which is exactly the shape that slips past. Refuse on the id, and hand back the revision an update would need.
    if (input.id !== undefined) {
      const existing = await readMemoryFact(
        deps.repoRoot,
        input.scope,
        input.id,
      );
      if (existing !== null) {
        return MemoryMutationResultSchema.parse({
          state: "already-exists",
          scope: input.scope,
          id: input.id,
          currentRevision: articleRevision(existing),
          detail:
            `[${input.scope}] ${input.id} already exists. Create never ` +
            "overwrites; reissue as an update naming this revision.",
        });
      }
    }
    const written = await deps.writeMemoryFact(input);
    return applied(deps.repoRoot, written.scope, written.id);
  }

  if (request.action === "update") {
    const checked = await fence(
      deps.repoRoot,
      request.scope,
      request.id,
      request.expectedRevision,
    );
    if (!checked.ok) return checked.result;
    // The id and scope come from the fenced request, not from the payload, so an edit cannot fence one article and rewrite another.
    const input = MemoryWriteInputSchema.parse({
      ...request.input,
      scope: request.scope,
      id: request.id,
    });
    const written = await deps.writeMemoryFact(input);
    return applied(deps.repoRoot, written.scope, written.id);
  }

  const checked = await fence(
    deps.repoRoot,
    request.scope,
    request.id,
    request.expectedRevision,
  );
  if (!checked.ok) return checked.result;
  const blockers = await referrers(deps.repoRoot, request.scope, request.id);
  if (blockers.length > 0) {
    return MemoryMutationResultSchema.parse({
      state: "referenced",
      scope: request.scope,
      id: request.id,
      referencedBy: blockers,
      detail:
        `[${request.scope}] ${request.id} is still listed in supersedes by ` +
        `${blockers.join(", ")}. Update or delete the referencing article first.`,
    });
  }
  await deps.deleteMemoryFact(request.scope, request.id);
  return MemoryMutationResultSchema.parse({
    state: "applied",
    scope: request.scope,
    id: request.id,
    revision: null,
  });
}

export async function applyMemoryMutation(
  deps: MemoryMutationDeps,
  request: MemoryMutationRequest,
): Promise<MemoryMutationResult> {
  return await deps.serialize(() => mutateLocked(deps, request));
}
