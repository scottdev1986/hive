// What `status: verified` is allowed to mean.
//
// The rule has two halves and a test that only proves one cannot tell this
// change from deleting the validator outright: an author stamping their own
// article must be REFUSED, and a different session stamping it on a later date
// must SUCCEED. Both are asserted here, along with the three refusals that make
// "a different session" a check the daemon performs rather than a promise the
// caller keeps.

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import {
  readMemoryFact,
  verifyMemoryFact,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import type { MemoryWriteInput } from "../../src/schemas/memory";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-verification-"));
  tempRoots.push(root);
  return root;
}

const article: MemoryWriteInput = {
  scope: "repo",
  topic: "testing",
  title: "Verification is not something an author does to their own article",
  body: "A claim written on one day, to be checked on a later one by somebody else.",
  source: "agent",
  evidence: "verification.test.ts",
  status: "unverified",
  supersedes: [],
  author: "heidi",
  date: "2026-08-01",
};

test("REFUSED: an author cannot write their own article verified", async () => {
  const root = await makeRoot();
  await expect(
    writeMemoryFact(root, {
      ...article,
      status: "verified",
      verified: "2026-08-01",
    }),
  ).rejects.toThrow("an author cannot verify their own article");
});

test("REFUSED: an author cannot verify their own article afterwards either", async () => {
  const root = await makeRoot();
  const written = await writeMemoryFact(root, article);
  await expect(
    verifyMemoryFact(root, "repo", written.id, {
      verifier: "heidi",
      date: "2026-08-05",
    }),
  ).rejects.toThrow("heidi wrote it");
});

test("SUCCEEDS: a different session verifies on a later date", async () => {
  const root = await makeRoot();
  const written = await writeMemoryFact(root, article);
  expect(written.status).toBe("unverified");

  const verified = await verifyMemoryFact(root, "repo", written.id, {
    verifier: "octavia",
    date: "2026-08-05",
  });

  expect(verified.status).toBe("verified");
  expect(verified.verified).toBe("2026-08-05");
  // The signal the corpus never had: a verification standing LATER than the
  // body it checks. `updated` must not move, or the distance is erased.
  expect(verified.date).toBe("2026-08-01");
  expect(verified.author).toBe("heidi");

  // On disk, not just in the returned object.
  const onDisk = await readMemoryFact(root, "repo", written.id);
  expect(onDisk?.status).toBe("verified");
  expect(onDisk?.verified).toBe("2026-08-05");
  expect(onDisk?.date).toBe("2026-08-01");
});

test("REFUSED: a verification dated the day the body was written", async () => {
  const root = await makeRoot();
  const written = await writeMemoryFact(root, article);
  await expect(
    verifyMemoryFact(root, "repo", written.id, {
      verifier: "octavia",
      date: "2026-08-01",
    }),
  ).rejects.toThrow("must be later than the body");
});

test("REFUSED: an article with no recorded author cannot be verified by anyone", async () => {
  const root = await makeRoot();
  const { author: _dropped, ...anonymous } = article;
  const written = await writeMemoryFact(root, anonymous);
  expect(written.author).toBeUndefined();

  await expect(
    verifyMemoryFact(root, "repo", written.id, {
      verifier: "octavia",
      date: "2026-08-05",
    }),
  ).rejects.toThrow("records no author");
});

test("the author survives an update, so a rewrite cannot hand authorship away", async () => {
  const root = await makeRoot();
  const written = await writeMemoryFact(root, article);

  const updated = await writeMemoryFact(root, {
    ...article,
    id: written.id,
    author: "octavia",
    body: "The body changed, and with it the claim that was checked.",
    supersedes: [written.id],
  });

  expect(updated.author).toBe("heidi");
});

test("a write may carry an existing verification but never create one", async () => {
  const root = await makeRoot();
  const written = await writeMemoryFact(root, article);
  await verifyMemoryFact(root, "repo", written.id, {
    verifier: "octavia",
    date: "2026-08-05",
  });

  // Same body, same verified date: a metadata edit, which is what an offline
  // consolidation performs when it merges a duplicate into a verified article.
  const carried = await writeMemoryFact(root, {
    ...article,
    id: written.id,
    status: "verified",
    verified: "2026-08-05",
    evidence: "Offline consolidation merged a duplicate into this article.",
  });
  expect(carried.status).toBe("verified");
  expect(carried.verified).toBe("2026-08-05");

  // A changed body with the same badge is the hole this closes.
  await expect(
    writeMemoryFact(root, {
      ...article,
      id: written.id,
      status: "verified",
      verified: "2026-08-05",
      body: "A different claim wearing the old article's verification.",
      supersedes: [written.id],
    }),
  ).rejects.toThrow("an author cannot verify their own article");
});

test("the author lands in the article file and survives a read back", async () => {
  const root = await makeRoot();
  const written = await writeMemoryFact(root, article);
  const contents = await readFile(written.path, "utf8");
  expect(contents).toContain("author: heidi");

  const reread = await readMemoryFact(root, "repo", written.id);
  expect(reread?.author).toBe("heidi");
});
