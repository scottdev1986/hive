#!/usr/bin/env bun
/** B2.5.3: mutation-verified 100 MiB ordered output through a real Workspace pane. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const workspaceRoot = join(repoRoot, "workspace");
const evidence = process.env.HIVE_B25_EVIDENCE
  ?? join(repoRoot, "raw/qualification/hive-b25-production-pane");
const transcriptPath = join(evidence, "matrix/stress-100mib-pane-xctest.txt");
const matrixPath = join(evidence, "matrix/stress-100mib-pane.txt");
const manifestPath = join(evidence, "manifests/stress-100mib-pane.json");
const priorTranscript = join(
  repoRoot, "raw/qualification/ghostty-b1-gate5-ordered/arm64-stress-xctest.txt",
);
const priorChecksums = join(
  repoRoot, "raw/qualification/ghostty-b1-gate5-ordered/evidence-sha256.txt",
);
const testSource = join(
  workspaceRoot, "Tests/HiveWorkspaceTests/PaneOrderedOutputStressTests.swift",
);
const runID = `b25-pane-${Date.now().toString(36)}`;
const startedAt = new Date().toISOString();

mkdirSync(join(evidence, "matrix"), { recursive: true });
mkdirSync(join(evidence, "manifests"), { recursive: true });

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function command(argv: string[], cwd = repoRoot): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function requireMatch(output: string, pattern: RegExp, label: string): RegExpMatchArray {
  const match = output.match(pattern);
  if (match === null) throw new Error(`missing ${label} in pane stress transcript`);
  return match;
}

const head = command(["git", "rev-parse", "HEAD"]);
const child = Bun.spawn(
  ["swift", "test", "--filter", "PaneOrderedOutputStressTests"],
  {
    cwd: workspaceRoot,
    env: { ...process.env, HIVE_B25_STRESS_RUN_ID: runID },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
const output = `${stdout}${stderr}`;
writeFileSync(transcriptPath, output);
if (exitCode !== 0) throw new Error(`pane stress XCTest failed (${exitCode}); see ${transcriptPath}`);
if (!output.includes("Test Suite 'PaneOrderedOutputStressTests' passed")) {
  throw new Error("focused pane stress suite did not report passed");
}

const metrics = requireMatch(
  output,
  /B25 PANE 100MIB: bytes=(\d+) chunks=(\d+) runID=(\S+) duration=([\d.]+)s heartbeats=(\d+) maxHeartbeatGap=([\d.]+)s streamHighWater=(\d+) stressAppliedAcks=(\d+) finalAppliedAcks=(\d+)/,
  "100 MiB metrics",
);
const mutation = requireMatch(
  output,
  /B25 PANE MUTATION: one-byte sequence gap rejected at highWater=(\d+)/,
  "one-byte sequence-gap mutation",
);
const parsed = {
  bytes: Number(metrics[1]),
  chunks: Number(metrics[2]),
  runID: metrics[3]!,
  durationSeconds: Number(metrics[4]),
  heartbeats: Number(metrics[5]),
  maxHeartbeatGapSeconds: Number(metrics[6]),
  streamHighWater: Number(metrics[7]),
  stressAppliedAcks: Number(metrics[8]),
  finalAppliedAcks: Number(metrics[9]),
  mutationHighWater: Number(mutation[1]),
};
const targetBytes = 100 * 1024 * 1024;
if (parsed.bytes !== targetBytes || parsed.chunks !== 1_600 || parsed.runID !== runID) {
  throw new Error(`stress volume/run nonce mismatch: ${JSON.stringify(parsed)}`);
}
if (parsed.heartbeats <= 10 || parsed.maxHeartbeatGapSeconds >= 0.5) {
  throw new Error(`main run loop was not responsive: ${JSON.stringify(parsed)}`);
}
if (
  parsed.streamHighWater !== parsed.mutationHighWater + targetBytes
  || parsed.stressAppliedAcks !== parsed.chunks + 1
  || parsed.finalAppliedAcks !== parsed.stressAppliedAcks + 1
) {
  throw new Error(`ordered high-water/APPLIED receipts mismatch: ${JSON.stringify(parsed)}`);
}

const priorBytes = readFileSync(priorTranscript);
const priorDigest = sha256(priorBytes);
const priorLine = readFileSync(priorChecksums, "utf8")
  .split("\n")
  .find((line) => line.endsWith("./arm64-stress-xctest.txt"));
if (priorLine === undefined || priorLine.split(/\s+/)[0] !== priorDigest) {
  throw new Error("Gate 5 row-C prior-art transcript failed its recorded SHA-256");
}
const priorText = priorBytes.toString("utf8");
for (const control of [
  "testLargeOrderedStreamProvesReplyOrderAndLosslessContent",
  "testVolumeByteLossControlFailsOnSingleVolumeByteMutation",
  "testConcurrentCallersAreSerializedAndUncoordinatedGapsRejected",
]) {
  if (!priorText.includes(`${control}]' passed`)) {
    throw new Error(`Gate 5 prior art is missing green control ${control}`);
  }
}

const lines = [
  `${startedAt} HEAD=${head}`,
  `${startedAt} runID=${runID} focusedSuite=PaneOrderedOutputStressTests`,
  `${startedAt} GREEN real ProjectWindowController -> agent PaneView -> HiveTerminalView -> real Ghostty C manual surface`,
  `${startedAt} GREEN production pump entry=pumpHostFrame; content-sensitive ordered frames=${parsed.chunks}; APPLIED receipts=${parsed.stressAppliedAcks}`,
  `${startedAt} GREEN bytes=${parsed.bytes} duration=${parsed.durationSeconds}s heartbeats=${parsed.heartbeats} maxHeartbeatGap=${parsed.maxHeartbeatGapSeconds}s`,
  `${startedAt} GREEN contiguous streamHighWater=${parsed.streamHighWater}; post-volume semantic sentinel rendered`,
  `${startedAt} MUTATION VERIFIED one-byte sequence gap -> REBASE_REQUIRED; highWater remained ${parsed.mutationHighWater}`,
  `${startedAt} PRIOR ART VERIFIED Gate 5 full-volume byte equality + single-byte content mutation + concurrent serialization sha256=${priorDigest}`,
  `${startedAt} NOTE locked XCTest cannot create the physical Metal surface; this row uses the real headless Ghostty C surface inside the real Workspace pane hierarchy. Production physical pane evidence is a separate B2.5 cell.`,
  `${startedAt} transcript=${transcriptPath}`,
  `${startedAt} RESULT: B2.5.3 100 MiB pane ordered-output responsiveness GREEN`,
];
writeFileSync(matrixPath, `${lines.join("\n")}\n`);
writeFileSync(manifestPath, `${JSON.stringify({
  cell: "stress-100mib-pane",
  ok: true,
  head,
  startedAt,
  runID,
  test: {
    filter: "PaneOrderedOutputStressTests",
    transcript: transcriptPath,
    source: testSource,
    sourceSha256: sha256(readFileSync(testSource)),
  },
  panePath: [
    "ProjectWindowController",
    "PaneView(agent:aria)",
    "HiveTerminalView",
    "pumpHostFrame",
    "AttachReplayClient",
    "OutputRangeApplicator",
    "hive_ghostty_surface_process_output_v1",
  ],
  metrics: parsed,
  limits: { maxHeartbeatGapSeconds: 0.5 },
  mutation: {
    kind: "one-byte stream sequence gap",
    expected: "REBASE_REQUIRED with unchanged high-water",
    observedHighWater: parsed.mutationHighWater,
  },
  priorArt: {
    artifact: priorTranscript,
    sha256: priorDigest,
    controls: [
      "full-volume byte equality across 100 MiB",
      "single-volume-byte mutation",
      "forced-overlap concurrent serialization",
    ],
  },
  environment: {
    arch: command(["uname", "-m"]),
    macOS: command(["sw_vers", "-productVersion"]),
    swift: command(["swift", "--version"], workspaceRoot).split("\n")[0],
  },
}, null, 2)}\n`);

console.log(`B2.5 PANE STRESS PROOF OK runID=${runID}`);
