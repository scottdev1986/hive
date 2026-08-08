/** The cutover acceptance matrix, rendered from evidence rather than from opinion. Nothing here decides whether the cutover is ready. It reads what each agent actually measured and reports what is there, what disagrees, and what nobody has answered yet. The one rule that shapes everything: a missing input is never a pass. An absent file, an absent key and an empty list are three different facts, and collapsing them is how a matrix certifies a cutover that never happened. */

export type ReadEvidence = (relativePath: string) => string | null;

export type RowVerdict = "pass" | "fail" | "missing" | "open";

export type AcceptanceRow = Readonly<{
  area: string;
  subject: string;
  verdict: RowVerdict;
  detail: string;
}>;

export type AcceptanceReport = Readonly<{
  schemaVersion: 1;
  /** `pass` only when every row passed. `blocked` means nothing contradicted the cutover but something is still unanswered — which is not the same as ready, and is deliberately not spelled "pass". */
  verdict: "pass" | "blocked" | "fail";
  counts: Readonly<Record<RowVerdict, number>>;
  rows: readonly AcceptanceRow[];
}>;

type VendorEvidence = Readonly<{
  vendor: string;
  path: string;
  version: (parsed: Record<string, unknown>) => string | null;
}>;

const nested = (
  parsed: Record<string, unknown>,
  key: string,
): string | null => {
  const runtime = parsed.runtime;
  if (typeof runtime !== "object" || runtime === null) return null;
  const value = (runtime as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const topLevel = (parsed: Record<string, unknown>): string | null =>
  typeof parsed.version === "string" && parsed.version.length > 0
    ? parsed.version
    : null;

/** The five vendors the plan requires, named here rather than discovered. Globbing the evidence directory would let a vendor pass by not existing: delete the folder and the matrix stops asking about it. The list is the requirement, so it is written down. */
export const REQUIRED_VENDORS: readonly VendorEvidence[] = [
  {
    vendor: "kimi",
    path: "kimi/conformance.json",
    version: topLevel,
  },
  {
    vendor: "opencode",
    path: "opencode/conformance.json",
    version: topLevel,
  },
  { vendor: "grok", path: "grok/conformance.json", version: topLevel },
  {
    vendor: "codex",
    path: "codex/conformance-0.146.0.json",
    version: (parsed) => nested(parsed, "version"),
  },
  {
    vendor: "claude",
    path: "claude/conformance.json",
    version: topLevel,
  },
];

const parseJson = (raw: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** A step somebody with authority looked at and accepted anyway. An accepted exception is not the same as a passing step and is never spelled that way: the row records who accepted it and why, so a reader can disagree with the person rather than with the table. An exception without an acceptor is ignored, because "somebody said it was fine" is not evidence. */
type ReviewedException = Readonly<{
  vendor: string;
  step: string;
  acceptedBy: string;
  why: string;
}>;

const reviewedExceptions = (read: ReadEvidence): ReviewedException[] => {
  const raw = read("reviewed-exceptions.json");
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ReviewedException =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ReviewedException).vendor === "string" &&
      typeof (entry as ReviewedException).step === "string" &&
      typeof (entry as ReviewedException).acceptedBy === "string" &&
      typeof (entry as ReviewedException).why === "string",
  );
};

const conformanceRows = (
  evidence: VendorEvidence,
  parsed: Record<string, unknown>,
  accepted: readonly ReviewedException[],
): AcceptanceRow[] => {
  const rows: AcceptanceRow[] = [];
  const version = evidence.version(parsed);
  rows.push({
    area: "runtime truth",
    subject: evidence.vendor,
    verdict: version === null ? "missing" : "pass",
    detail:
      version === null
        ? "no installed version recorded, so the run cannot be tied to a build"
        : `${evidence.path}: measured against ${version}`,
  });

  const steps = parsed.steps;
  if (typeof steps !== "object" || steps === null) {
    rows.push({
      area: "conformance",
      subject: evidence.vendor,
      verdict: "missing",
      detail: "no conformance steps recorded",
    });
  } else {
    const entries = Object.entries(steps as Record<string, unknown>);
    const notPass = entries.filter(([, value]) => value !== "pass");
    const acceptedFor = (step: string) =>
      accepted.find(
        (each) => each.vendor === evidence.vendor && each.step === step,
      );
    const unreviewed = notPass.filter(
      ([step]) => acceptedFor(step) === undefined,
    );
    const reviewed = notPass
      .map(([step]) => acceptedFor(step))
      .filter((each): each is ReviewedException => each !== undefined);
    rows.push({
      area: "conformance",
      subject: evidence.vendor,
      verdict:
        entries.length === 0
          ? "missing"
          : unreviewed.length === 0
            ? "pass"
            : "open",
      detail:
        entries.length === 0
          ? "the step list is empty"
          : unreviewed.length > 0
            ? // Reported verbatim rather than judged. A documented vendor
              unreviewed
                .map(([step, value]) => `${step}=${String(value)}`)
                .join("; ")
            : reviewed.length === 0
              ? `${evidence.path}: ${entries.length} steps, all pass`
              : `${evidence.path}: ${entries.length} steps, ` +
                reviewed
                  .map(
                    (each) =>
                      `${each.step} accepted by ${each.acceptedBy}: ${each.why}`,
                  )
                  .join("; "),
    });
  }

  const unknowns = parsed.steadyStateUnknowns;
  rows.push({
    area: "status",
    subject: `${evidence.vendor} steady-state unknowns`,
    verdict: !Array.isArray(unknowns)
      ? "missing"
      : unknowns.length === 0
        ? "pass"
        : "fail",
    detail: !Array.isArray(unknowns)
      ? // The bar is that this list is empty. A file that never wrote the key
        "steadyStateUnknowns was never recorded, so emptiness is unproven"
      : unknowns.length === 0
        ? `${evidence.path}: none`
        : unknowns.map(String).join(", "),
  });
  return rows;
};

const vendorRows = (
  evidence: VendorEvidence,
  read: ReadEvidence,
  accepted: readonly ReviewedException[],
): AcceptanceRow[] => {
  const raw = read(evidence.path);
  if (raw === null) {
    return [
      {
        area: "conformance",
        subject: evidence.vendor,
        verdict: "missing",
        detail: `no evidence at ${evidence.path}`,
      },
    ];
  }
  const parsed = parseJson(raw);
  if (parsed === null) {
    return [
      {
        area: "conformance",
        subject: evidence.vendor,
        verdict: "fail",
        detail: `${evidence.path} is not a JSON object`,
      },
    ];
  }
  return conformanceRows(evidence, parsed, accepted);
};

const auditRow = (read: ReadEvidence): AcceptanceRow => {
  const raw = read("audit.json");
  if (raw === null) {
    return {
      area: "cutover",
      subject: "deletion targets",
      verdict: "missing",
      detail: "no audit.json; the old architecture's absence is unproven",
    };
  }
  const parsed = parseJson(raw);
  const targets = parsed?.deletionTargets;
  if (!Array.isArray(targets)) {
    return {
      area: "cutover",
      subject: "deletion targets",
      verdict: "missing",
      detail: "audit.json records no deletionTargets list",
    };
  }
  return {
    area: "cutover",
    subject: "deletion targets",
    verdict: targets.length === 0 ? "pass" : "fail",
    detail:
      targets.length === 0
        ? "audit.json: empty; nothing of the old architecture is left to delete"
        : // Reviewed exceptions are by design and are not counted here; only
          `${targets.length} still awaiting deletion`,
  };
};

/** Every run a log records, with the breadth each one actually covered. Breadth is the point. A log can hold a green subdirectory run and a red whole-suite run, and reading "0 fail" out of it without asking WHICH RUN said so is how a subdirectory number gets quoted as if it were the suite. That mistake hid a red conformance test for hours, so the widest run is picked explicitly rather than the first one that matches. */
type RecordedRun = Readonly<{ files: number; tests: number; failed: number }>;

const recordedRuns = (log: string): RecordedRun[] => {
  const runs: RecordedRun[] = [];
  const lines = log.split("\n");
  let failed: number | null = null;
  for (const line of lines) {
    const fail = /^\s*(\d+) fail\s*$/.exec(line);
    if (fail?.[1] !== undefined) failed = Number(fail[1]);
    const ran = /^Ran (\d+) tests across (\d+) files/.exec(line);
    if (ran?.[1] === undefined || ran[2] === undefined) continue;
    // A run that never printed a fail count is not a run that passed.
    if (failed === null) continue;
    runs.push({ tests: Number(ran[1]), files: Number(ran[2]), failed });
    failed = null;
  }
  return runs;
};

const widestRun = (log: string): RecordedRun | null =>
  recordedRuns(log).reduce<RecordedRun | null>(
    (widest, run) =>
      widest === null || run.files > widest.files ? run : widest,
    null,
  );

const mailWakeRows = (read: ReadEvidence): AcceptanceRow[] => {
  const source = "mail-wake/test-run.txt";
  const run = read(source);
  const probes = read("mail-wake/mutation-probes.txt");
  const rows: AcceptanceRow[] = [];
  const widest = run === null ? null : widestRun(run);
  rows.push({
    area: "mail",
    subject: "wake and delivery suites",
    verdict:
      run === null || widest === null
        ? "missing"
        : widest.failed === 0
          ? "pass"
          : "fail",
    detail:
      run === null
        ? `no ${source}`
        : widest === null
          ? `${source} records no completed run`
          : `${source}: ${widest.tests} tests across ${widest.files} files, ` +
            `${widest.failed} fail`,
  });
  const brokenRuleWasCaught =
    probes !== null && /^\s*[1-9]\d* fail\s*$/m.test(probes);
  rows.push({
    area: "mail",
    subject: "mutation probe integrity",
    verdict:
      probes === null ? "missing" : brokenRuleWasCaught ? "pass" : "fail",
    detail:
      probes === null
        ? "no mail-wake/mutation-probes.txt"
        : brokenRuleWasCaught
          ? "mail-wake/mutation-probes.txt: breaking a rule fails tests"
          : "no probe caused a failure; the tests do not discriminate",
  });
  return rows;
};

/** Work nothing on disk can attest to, carried so it cannot be forgotten. An unfinished migration that nothing reports is indistinguishable from one that was done, which is the failure these rows exist to prevent. They close the same way a step exception does — somebody with authority records that they looked, and the row then names them. The row never simply disappears, because a matrix that forgets an item cannot be asked about it later. */
const OPEN_ITEMS: readonly Readonly<{
  area: string;
  subject: string;
  detail: string;
}>[] = [
  {
    area: "mail",
    subject: "sinceBrokerSeq migration",
    detail:
      "the frontend must resume from the notification cursor; a client still " +
      "resuming on the mailbox sequence cannot see a re-announcement",
  },
];

const openRows = (accepted: readonly ReviewedException[]): AcceptanceRow[] =>
  OPEN_ITEMS.map((item) => {
    const closed = accepted.find(
      (each) => each.vendor === item.area && each.step === item.subject,
    );
    return closed === undefined
      ? { ...item, verdict: "open" as const }
      : {
          area: item.area,
          subject: item.subject,
          verdict: "pass" as const,
          detail: `closed by ${closed.acceptedBy}: ${closed.why}`,
        };
  });

export function renderAcceptance(read: ReadEvidence): AcceptanceReport {
  const accepted = reviewedExceptions(read);
  const rows: AcceptanceRow[] = [
    ...REQUIRED_VENDORS.flatMap((vendor) => vendorRows(vendor, read, accepted)),
    auditRow(read),
    ...mailWakeRows(read),
    ...openRows(accepted),
  ];
  const counts = {
    pass: rows.filter((row) => row.verdict === "pass").length,
    fail: rows.filter((row) => row.verdict === "fail").length,
    missing: rows.filter((row) => row.verdict === "missing").length,
    open: rows.filter((row) => row.verdict === "open").length,
  };
  return {
    schemaVersion: 1,
    verdict:
      counts.fail > 0
        ? "fail"
        : counts.missing + counts.open > 0
          ? "blocked"
          : "pass",
    counts,
    rows,
  };
}

const SYMBOL: Record<RowVerdict, string> = {
  pass: "PASS",
  fail: "FAIL",
  missing: "MISSING",
  open: "OPEN",
};

export function formatAcceptance(report: AcceptanceReport): string {
  const width = (pick: (row: AcceptanceRow) => string): number =>
    report.rows.reduce((widest, row) => Math.max(widest, pick(row).length), 0);
  const areaWidth = width((row) => row.area);
  const subjectWidth = width((row) => row.subject);
  const lines = report.rows.map(
    (row) =>
      `${row.area.padEnd(areaWidth)}  ${row.subject.padEnd(subjectWidth)}  ` +
      `${SYMBOL[row.verdict].padEnd(7)}  ${row.detail}`,
  );
  return [
    "CUTOVER ACCEPTANCE",
    "",
    ...lines,
    "",
    `${report.verdict.toUpperCase()} — ${report.counts.pass} pass, ` +
      `${report.counts.fail} fail, ${report.counts.missing} missing, ` +
      `${report.counts.open} open`,
  ].join("\n");
}
