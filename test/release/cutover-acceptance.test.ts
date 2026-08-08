import { describe, expect, test } from "bun:test";
import {
  formatAcceptance,
  REQUIRED_VENDORS,
  type ReadEvidence,
  renderAcceptance,
} from "../../scripts/release/cutover-acceptance";
import { required } from "../required";

/**
 * The matrix has one job nobody else can do for it: refuse to say "ready" from
 * evidence that is not there. Most of these tests take something away and
 * check that the verdict notices.
 */

const conformance = (vendor: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    vendor,
    version: "1.0.0",
    steps: { "1-initialize": "pass", "2-prompt": "pass" },
    steadyStateUnknowns: [],
    ...overrides,
  });

/** Everything present and passing, so a removal below is the only difference. */
const complete = (): Map<string, string> => {
  const files = new Map<string, string>();
  for (const vendor of REQUIRED_VENDORS) {
    files.set(
      vendor.path,
      vendor.vendor === "codex"
        ? JSON.stringify({
            runtime: { version: "0.146.0" },
            steps: { "1-initialize": "pass" },
            steadyStateUnknowns: [],
          })
        : conformance(vendor.vendor),
    );
  }
  files.set(
    "audit.json",
    JSON.stringify({ deletionTargets: [], reviewedExceptions: [{ why: "x" }] }),
  );
  files.set(
    "mail-wake/test-run.txt",
    " 94 pass\n 0 fail\nRan 94 tests across 5 files. [1ms]\n" +
      " 2786 pass\n 0 fail\nRan 2801 tests across 238 files. [1ms]\n",
  );
  files.set("mail-wake/mutation-probes.txt", "probe 1\n 36 pass\n 2 fail\n");
  return files;
};

const readFrom =
  (files: Map<string, string>): ReadEvidence =>
  (path) =>
    files.get(path) ?? null;

const rowFor = (
  files: Map<string, string>,
  subject: string,
): ReturnType<typeof renderAcceptance>["rows"][number] =>
  required(
    renderAcceptance(readFrom(files)).rows.find(
      (row) => row.subject === subject,
    ),
    `no row for ${subject}`,
  );

describe("the cutover acceptance matrix", () => {
  test("everything measured and answered is the only way to pass", () => {
    const report = renderAcceptance(readFrom(complete()));
    // The migration row is deliberately unanswerable from evidence, so a
    // complete run is blocked rather than passing. That is the point: the
    // matrix cannot be talked into "ready" while something is unresolved.
    expect(report.verdict).toBe("blocked");
    expect(report.counts.fail).toBe(0);
    expect(report.counts.missing).toBe(0);
    expect(report.counts.open).toBe(1);
    expect(rowFor(complete(), "sinceBrokerSeq migration").verdict).toBe("open");
  });

  test("an absent vendor is missing, never absent-and-fine", () => {
    for (const vendor of REQUIRED_VENDORS) {
      const files = complete();
      files.delete(vendor.path);
      const report = renderAcceptance(readFrom(files));
      expect(report.verdict).not.toBe("pass");
      expect(
        report.rows.some(
          (row) => row.subject === vendor.vendor && row.verdict === "missing",
        ),
      ).toBe(true);
    }
  });

  test("deleting a vendor's evidence folder cannot delete the requirement", () => {
    // The five are named in code rather than discovered on disk, so an empty
    // evidence tree reports five missing vendors instead of nothing to check.
    const report = renderAcceptance(() => null);
    // Blocked rather than failed: an empty tree contradicts nothing, it simply
    // knows nothing. What matters is that knowing nothing never reads as ready.
    expect(report.verdict).toBe("blocked");
    expect(report.counts.pass).toBe(0);
    expect(report.counts.missing).toBeGreaterThanOrEqual(
      REQUIRED_VENDORS.length,
    );
  });

  test("an unrecorded steady-state unknowns list is missing, not empty", () => {
    const files = complete();
    files.set("kimi/conformance.json", conformance("kimi", {}));
    const kimi = JSON.parse(required(files.get("kimi/conformance.json"))) as {
      steadyStateUnknowns?: unknown;
    };
    delete kimi.steadyStateUnknowns;
    files.set("kimi/conformance.json", JSON.stringify(kimi));
    expect(rowFor(files, "kimi steady-state unknowns").verdict).toBe("missing");
  });

  test("a non-empty steady-state unknowns list fails and names them", () => {
    const files = complete();
    files.set(
      "kimi/conformance.json",
      conformance("kimi", { steadyStateUnknowns: ["contextUsage", "fork"] }),
    );
    const row = rowFor(files, "kimi steady-state unknowns");
    expect(row.verdict).toBe("fail");
    expect(row.detail).toContain("contextUsage");
  });

  test("an unrecorded version fails the runtime-truth row", () => {
    const files = complete();
    files.set("grok/conformance.json", conformance("grok", { version: "" }));
    expect(rowFor(files, "grok").verdict).toBe("missing");
  });

  test("a step that is not a plain pass is surfaced verbatim, not judged", () => {
    const files = complete();
    files.set(
      "grok/conformance.json",
      conformance("grok", {
        steps: { "1-initialize": "pass", "6-load": "measured: no-replay" },
      }),
    );
    const rows = renderAcceptance(readFrom(files)).rows;
    const row = required(
      rows.find(
        (each) => each.area === "conformance" && each.subject === "grok",
      ),
    );
    // A documented vendor omission and a real failure are indistinguishable
    // from here, so it asks a user rather than choosing for them.
    expect(row.verdict).toBe("open");
    expect(row.detail).toContain("measured: no-replay");
  });

  test("an empty step list is missing rather than vacuously complete", () => {
    const files = complete();
    files.set("grok/conformance.json", conformance("grok", { steps: {} }));
    const row = required(
      renderAcceptance(readFrom(files)).rows.find(
        (each) => each.area === "conformance" && each.subject === "grok",
      ),
    );
    expect(row.verdict).toBe("missing");
  });

  test("unparseable evidence fails instead of being skipped", () => {
    const files = complete();
    files.set("claude/conformance.json", "{not json");
    const report = renderAcceptance(readFrom(files));
    expect(report.verdict).toBe("fail");
  });

  test("the deletion-target list must be present and empty", () => {
    const missing = complete();
    missing.delete("audit.json");
    expect(rowFor(missing, "deletion targets").verdict).toBe("missing");

    const unlisted = complete();
    unlisted.set("audit.json", JSON.stringify({ reviewedExceptions: [] }));
    expect(rowFor(unlisted, "deletion targets").verdict).toBe("missing");

    const outstanding = complete();
    outstanding.set(
      "audit.json",
      JSON.stringify({ deletionTargets: [{ path: "old.ts" }] }),
    );
    expect(rowFor(outstanding, "deletion targets").verdict).toBe("fail");
  });

  test("reviewed exceptions are by design and do not block", () => {
    const files = complete();
    files.set(
      "audit.json",
      JSON.stringify({
        deletionTargets: [],
        reviewedExceptions: [{ path: "kept.ts", why: "reviewed" }],
      }),
    );
    expect(rowFor(files, "deletion targets").verdict).toBe("pass");
  });

  test("a probe log where nothing broke is a failure, not a clean sheet", () => {
    const files = complete();
    files.set("mail-wake/mutation-probes.txt", "probe 1\n 36 pass\n 0 fail\n");
    // Breaking a rule that no test notices proves the tests are decoration.
    const row = rowFor(files, "mutation probe integrity");
    expect(row.verdict).toBe("fail");
    expect(row.detail).toContain("do not discriminate");
  });

  test("a recorded run with failures fails the mail row", () => {
    const files = complete();
    files.set(
      "mail-wake/test-run.txt",
      " 90 pass\n 4 fail\nRan 94 tests across 238 files. [1ms]\n",
    );
    expect(rowFor(files, "wake and delivery suites").verdict).toBe("fail");
  });

  test("the widest run is the one quoted, not the first green one", () => {
    const files = complete();
    // A subdirectory run that passes above a whole-suite run that fails is
    // exactly the shape that hid a red conformance test for hours.
    files.set(
      "mail-wake/test-run.txt",
      " 94 pass\n 0 fail\nRan 94 tests across 5 files. [1ms]\n" +
        " 2780 pass\n 6 fail\nRan 2801 tests across 238 files. [1ms]\n",
    );
    const row = rowFor(files, "wake and delivery suites");
    expect(row.verdict).toBe("fail");
    expect(row.detail).toContain("238 files");
    expect(row.detail).toContain("6 fail");
  });

  test("a log with no completed run is missing rather than green", () => {
    const files = complete();
    files.set("mail-wake/test-run.txt", " 94 pass\n 0 fail\n");
    // No "Ran N tests" line means nothing finished; a bare fail count could
    // have come from anywhere.
    expect(rowFor(files, "wake and delivery suites").verdict).toBe("missing");
  });

  test("every passing row names the file its number came from", () => {
    const report = renderAcceptance(readFrom(complete()));
    for (const row of report.rows.filter((each) => each.verdict === "pass")) {
      expect(row.detail).toMatch(/\.json|\.txt/);
    }
  });

  test("the table shows every row and the verdict", () => {
    const rendered = formatAcceptance(renderAcceptance(readFrom(complete())));
    expect(rendered).toContain("CUTOVER ACCEPTANCE");
    expect(rendered).toContain("BLOCKED");
    for (const vendor of REQUIRED_VENDORS) {
      expect(rendered).toContain(vendor.vendor);
    }
  });
});

describe("reviewed exceptions", () => {
  const withException = (files: Map<string, string>) => {
    files.set(
      "grok/conformance.json",
      conformance("grok", {
        steps: { "1-initialize": "pass", "6-load": "measured: no-replay" },
      }),
    );
    return files;
  };

  const grokConformance = (files: Map<string, string>) =>
    required(
      renderAcceptance(readFrom(files)).rows.find(
        (row) => row.area === "conformance" && row.subject === "grok",
      ),
    );

  test("an accepted step passes and names who accepted it and why", () => {
    const files = withException(complete());
    files.set(
      "reviewed-exceptions.json",
      JSON.stringify([
        {
          vendor: "grok",
          step: "6-load",
          acceptedBy: "queen 2026-08-02",
          why: "documented omission",
        },
      ]),
    );
    const row = grokConformance(files);
    expect(row.verdict).toBe("pass");
    expect(row.detail).toContain("accepted by queen 2026-08-02");
    expect(row.detail).toContain("documented omission");
  });

  test("an exception with no acceptor is not an acceptance", () => {
    const files = withException(complete());
    files.set(
      "reviewed-exceptions.json",
      JSON.stringify([{ vendor: "grok", step: "6-load", why: "trust me" }]),
    );
    // "Somebody said it was fine" is not evidence, so the row stays open.
    expect(grokConformance(files).verdict).toBe("open");
  });

  test("an exception for a different step does not cover this one", () => {
    const files = withException(complete());
    files.set(
      "reviewed-exceptions.json",
      JSON.stringify([
        {
          vendor: "grok",
          step: "5-cancel",
          acceptedBy: "queen",
          why: "unrelated",
        },
      ]),
    );
    expect(grokConformance(files).verdict).toBe("open");
  });

  test("an exception for a different vendor does not cross over", () => {
    const files = withException(complete());
    files.set(
      "reviewed-exceptions.json",
      JSON.stringify([
        { vendor: "kimi", step: "6-load", acceptedBy: "queen", why: "kimi's" },
      ]),
    );
    expect(grokConformance(files).verdict).toBe("open");
  });
});

describe("open items", () => {
  const migration = (files: Map<string, string>) =>
    required(
      renderAcceptance(readFrom(files)).rows.find(
        (row) => row.subject === "sinceBrokerSeq migration",
      ),
    );

  test("an open item stays open until somebody records that they closed it", () => {
    expect(migration(complete()).verdict).toBe("open");
  });

  test("closing it names who did and why, and does not remove the row", () => {
    const files = complete();
    files.set(
      "reviewed-exceptions.json",
      JSON.stringify([
        {
          vendor: "mail",
          step: "sinceBrokerSeq migration",
          acceptedBy: "ava 2026-08-02",
          why: "the frontend resumes on the cursor",
        },
      ]),
    );
    const row = migration(files);
    // A matrix that forgets an item cannot be asked about it later, so the row
    // survives its own closure.
    expect(row.verdict).toBe("pass");
    expect(row.detail).toContain("closed by ava 2026-08-02");
  });
});
