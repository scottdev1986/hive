import { describe, expect, test } from "bun:test";
import {
  auditEvidence,
  auditTerminalInput,
  INPUT_PROBES,
  probesMatching,
  REPOSITORY_ROOT,
  unexpectedFindings,
  unreachedDeletionTargets,
} from "../src/adapters/providers/protocol/terminal-input-audit";

const ROOT = REPOSITORY_ROOT;

/**
 * One line per probe, written the way the product would write it. If a probe's
 * pattern is wrong this snippet stops matching, which is the only reason the
 * audit's "repository is clean" verdict can be trusted once the deletion
 * targets are gone and there is nothing real left to match.
 */
const AUTOMATED_INPUT_SNIPPET = `
  const writer: AgentTurnInput = this.agentTurnInput(record, runId);
  await adapter.startInitialTurn?.(writer, kickoff);
  await input.writeAutomated({ bytes, transactionId });
  await this.sessiondInput.injectKeys(agent, keys, options);
  const framed = "\\x1b[200~" + kickoff + "\\x1b[201~";
  if (ghostty_paste_encode(mutable.ptr, mutable.len, bracketed, out, cap, &written) != OK) return;
  await tmux(["send-keys", "-t", pane, kickoff, "Enter"]);
  try queueInitialInput(allocator, encoder, &sink, boot.initial_input);
  const spawn = await adapter.prepareSpawn(context);
`;

describe("the terminal-input audit scanner", () => {
  test("fires on every banned construct, so a clean verdict means something", () => {
    expect(probesMatching(AUTOMATED_INPUT_SNIPPET).toSorted()).toEqual(
      INPUT_PROBES.map((probe) => probe.id).toSorted(),
    );
  });

  test("stays silent on source that only names the constructs in prose", () => {
    expect(
      probesMatching(
        "// Hive never types into a vendor terminal and never pastes a prompt.",
      ),
    ).toEqual([]);
  });

  test("every probe says what it rejects", () => {
    for (const probe of INPUT_PROBES) {
      expect(probe.rejects.length).toBeGreaterThan(0);
    }
  });
});

describe("the repository terminal-input audit", () => {
  test("finds no automated terminal-input path outside a deletion target", async () => {
    const unexpected = unexpectedFindings(await auditTerminalInput(ROOT));

    expect(
      unexpected.map(
        (finding) => `${finding.probeId} ${finding.file}:${finding.line}`,
      ),
    ).toEqual([]);
  });

  test("every declared deletion target still exists", async () => {
    expect(unreachedDeletionTargets(await auditTerminalInput(ROOT))).toEqual(
      [],
    );
  });

  test("Kimi's kickoff injection is gone, not merely flagged", async () => {
    const probe = INPUT_PROBES.find((each) => each.id === "start-initial-turn");
    const findings = await auditTerminalInput(ROOT);

    // It was named as a deletion target until the cutover removed it; nothing
    // may reintroduce it, so the target list stays empty rather than being
    // deleted along with the construct.
    expect(probe?.deletionTargets).toEqual([]);
    expect(findings.filter((f) => f.probeId === "start-initial-turn")).toEqual(
      [],
    );
  });

  test("no adapter can hand out a terminal writer any more", async () => {
    const findings = await auditTerminalInput(ROOT);

    expect(findings.filter((f) => f.probeId === "agent-turn-input")).toEqual(
      [],
    );
  });

  test("the audit is clean exactly when no deletion target is left", async () => {
    const findings = await auditTerminalInput(ROOT);
    const remaining = INPUT_PROBES.flatMap((probe) => probe.deletionTargets);

    expect(unexpectedFindings(findings).length > 0).toBe(remaining.length > 0);
  });
});

describe("the checked-in audit evidence", () => {
  const EVIDENCE = "docs/evidence/protocol-terminal/audit.json";

  test("matches what the probes currently say", async () => {
    const checkedIn = await Bun.file(`${ROOT}${EVIDENCE}`).json();

    expect(checkedIn).toEqual(
      JSON.parse(JSON.stringify(auditEvidence())) as unknown,
    );
  });

  test("lists every deletion target the probes declare", () => {
    const declared = INPUT_PROBES.flatMap((probe) =>
      probe.deletionTargets.map((file) => `${probe.id} ${file}`),
    );
    const evidence = auditEvidence().deletionTargets.map(
      (each) => `${each.probeId} ${each.file}`,
    );

    expect(evidence.toSorted()).toEqual(declared.toSorted());
  });

  test("every remaining target says what it would let automation do", () => {
    for (const target of auditEvidence().deletionTargets) {
      expect(target.rejects.length).toBeGreaterThan(0);
    }
  });

  test("the OpenTUI cutover leaves no reviewed source exception", () => {
    const evidence = auditEvidence();

    expect(evidence.reviewedExceptions).toEqual([]);
    expect(evidence.deletionTargets).toEqual([]);
  });
});
