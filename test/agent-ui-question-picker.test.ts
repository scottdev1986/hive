import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
});

afterEach(async () => {
  await harness.close();
});

async function settle(): Promise<void> {
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
}

/** The question Kimi sends for an AskUserQuestion, per its captured fixture. */
function askQuestion(): void {
  harness.ui.onProviderEvent(
    harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
  );
  harness.ui.onProviderEvent(
    harness.driver.emit({
      kind: "question-waiting",
      requestId: "perm-1",
      turnId: "t1",
      summary: "AskUserQuestion",
      detail: "Pick one: alpha or beta?",
      options: [
        { optionId: "q0_opt_0", name: "alpha", kind: "allow" },
        { optionId: "q0_opt_1", name: "beta", kind: "allow" },
        { optionId: "q0_skip", name: "Skip", kind: "reject" },
      ],
    }),
  );
}

describe("a question is readable and answerable", () => {
  test("the question text and every option are on screen", async () => {
    askQuestion();
    await settle();
    const frame = harness.testRenderer.captureCharFrame();

    expect(frame).toContain("Pick one: alpha or beta?");
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("Skip");
  });

  test("the question card absorbs the provider's duplicate question-tool row", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "ask-1",
        toolName: "AskUserQuestion",
        detail: "duplicate raw question tool row",
      }),
    );
    askQuestion();
    await settle();

    const tool = harness.ui
      .snapshot()
      .view.transcript.find(
        (entry) => entry.kind === "tool" && entry.toolCallId === "ask-1",
      );
    expect(tool?.kind === "tool" ? tool.absorbedByElicitation : undefined).toBe(
      true,
    );
    expect(harness.testRenderer.captureCharFrame()).not.toContain(
      "duplicate raw question tool row",
    );
  });

  test("Enter answers with the highlighted option, not the first one", async () => {
    askQuestion();
    await settle();
    harness.testRenderer.mockInput.pressArrow("down");
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "perm-1", outcome: "allow", optionId: "q0_opt_1" },
    ]);
  });

  test("a digit picks that option outright", async () => {
    askQuestion();
    await settle();
    await harness.testRenderer.mockInput.typeText("3");
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "perm-1", outcome: "deny", optionId: "q0_skip" },
    ]);
  });

  test("Escape takes the vendor's own reject option", async () => {
    askQuestion();
    await settle();
    harness.testRenderer.mockInput.pressEscape();
    await Bun.sleep(30);
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "perm-1", outcome: "deny", optionId: "q0_skip" },
    ]);
  });

  test("a digit typed into a draft is text, not an answer", async () => {
    askQuestion();
    await settle();
    await harness.testRenderer.mockInput.typeText("plan 2");
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([]);
    expect(harness.ui.snapshot().draft).toBe("plan 2");
  });

  test("typed text answers a structured question instead of becoming a new turn", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "question-waiting",
        requestId: "custom-1",
        turnId: "t1",
        summary: "Framework",
        options: [],
        questions: [
          {
            questionId: "framework",
            text: "Which framework should I use?",
            header: "Framework",
            multiSelect: false,
            allowCustom: true,
            secret: false,
            options: [
              { optionId: "React", name: "React", kind: "allow" },
              { optionId: "Vue", name: "Vue", kind: "allow" },
            ],
          },
        ],
      }),
    );
    await settle();

    await harness.testRenderer.mockInput.typeText("Svelte");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      {
        requestId: "custom-1",
        outcome: "allow",
        answers: { framework: "Svelte" },
      },
    ]);
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);
    expect(harness.ui.snapshot().draft).toBe("");
  });

  test("a question parks an in-progress prompt and restores it after settlement", async () => {
    await harness.testRenderer.mockInput.typeText("keep my unfinished prompt");
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "question-waiting",
        requestId: "parked-1",
        turnId: "t1",
        summary: "Framework",
        options: [],
        questions: [
          {
            questionId: "framework",
            text: "Which framework?",
            header: "Framework",
            multiSelect: false,
            allowCustom: true,
            secret: false,
            options: [],
          },
        ],
      }),
    );
    await settle();

    expect(harness.ui.snapshot().draft).toBe("");
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Type your answer",
    );
    await harness.testRenderer.mockInput.typeText("Svelte");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "elicitation-settled",
        requestId: "parked-1",
        outcome: "answered",
      }),
    );
    await settle();

    expect(harness.ui.snapshot().draft).toBe("keep my unfinished prompt");
    expect(harness.driver.submissions).toEqual([]);
  });

  test("secret answers are masked while typing and redacted from the transcript", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "question-waiting",
        requestId: "secret-1",
        turnId: "t1",
        summary: "Credentials",
        options: [],
        questions: [
          {
            questionId: "token",
            text: "Paste the temporary token",
            header: "Token",
            multiSelect: false,
            allowCustom: true,
            secret: true,
            options: [],
          },
          {
            questionId: "environment",
            text: "Which environment?",
            header: "Environment",
            multiSelect: false,
            allowCustom: true,
            secret: false,
            options: [],
          },
        ],
      }),
    );
    await settle();

    await harness.testRenderer.mockInput.typeText(" temporary-secret ");
    await settle();
    expect(harness.ui.snapshot().draft).toBe("•".repeat(18));
    expect(harness.testRenderer.captureCharFrame()).not.toContain(
      "temporary-secret",
    );

    harness.testRenderer.mockInput.pressEnter();
    await settle();
    const secondQuestion = harness.testRenderer.captureCharFrame();
    expect(secondQuestion).toContain("••••••");
    expect(secondQuestion).not.toContain("temporary-secret");

    await harness.testRenderer.mockInput.typeText("staging");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.driver.permissionDecisions).toEqual([
      {
        requestId: "secret-1",
        outcome: "allow",
        answers: {
          token: " temporary-secret ",
          environment: "staging",
        },
      },
    ]);

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "elicitation-settled",
        requestId: "secret-1",
        outcome: "answered",
      }),
    );
    const entry = harness.ui
      .snapshot()
      .view.transcript.find(
        (candidate) =>
          candidate.kind === "elicitation" &&
          candidate.requestId === "secret-1",
      );
    expect(entry?.kind === "elicitation" ? entry.chosen.token : undefined).toBe(
      undefined,
    );
  });

  test("an option the vendor never offered is refused", async () => {
    askQuestion();
    await settle();
    await harness.ui.answerPending("q0_invented");

    expect(harness.driver.permissionDecisions).toEqual([]);
  });
});

describe("a multi-question ask is answered one question at a time", () => {
  function askTwo(): void {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "question-waiting",
        requestId: "perm-2",
        turnId: "t1",
        summary: "Transport",
        detail: "Which transport?",
        options: [],
        questions: [
          {
            questionId: "Which transport?",
            text: "Which transport?",
            header: "Transport",
            multiSelect: false,
            allowCustom: true,
            secret: false,
            options: [
              { optionId: "HTTP/2", name: "HTTP/2", kind: "allow" },
              { optionId: "WebSocket", name: "WebSocket", kind: "allow" },
            ],
          },
          {
            questionId: "Which environments?",
            text: "Which environments?",
            header: "Rollout",
            multiSelect: true,
            allowCustom: true,
            secret: false,
            options: [
              { optionId: "staging", name: "staging", kind: "allow" },
              { optionId: "prod", name: "prod", kind: "allow" },
            ],
          },
        ],
      }),
    );
  }

  test("answering the first question does not settle the request", async () => {
    askTwo();
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([]);
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Which environments?",
    );
  });

  test("every answer is sent once, keyed by question, after the last one", async () => {
    askTwo();
    await settle();
    harness.testRenderer.mockInput.pressArrow("down");
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    // Multi-select: space toggles, Enter confirms.
    await harness.testRenderer.mockInput.typeText(" ");
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      {
        requestId: "perm-2",
        outcome: "allow",
        answers: {
          "Which transport?": "WebSocket",
          "Which environments?": ["staging"],
        },
      },
    ]);
  });

  test("a multi-select records several labels", async () => {
    askTwo();
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    await harness.testRenderer.mockInput.typeText(" ");
    await settle();
    harness.testRenderer.mockInput.pressArrow("down");
    await settle();
    await harness.testRenderer.mockInput.typeText(" ");
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(
      harness.driver.permissionDecisions[0]?.answers?.["Which environments?"],
    ).toEqual(["staging", "prod"]);
  });

  test("left and right move between questions without answering", async () => {
    askTwo();
    await settle();
    harness.testRenderer.mockInput.pressArrow("right");
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Which environments?",
    );
    harness.testRenderer.mockInput.pressArrow("left");
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Which transport?",
    );
    expect(harness.driver.permissionDecisions).toEqual([]);
  });

  test("left and right move the cursor, not the question, while a draft is being typed", async () => {
    askTwo();
    await settle();
    await harness.testRenderer.mockInput.typeText("gRPC");
    harness.testRenderer.mockInput.pressArrow("right");
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Which transport?",
    );
    harness.testRenderer.mockInput.pressTab();
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Which environments?",
    );
    expect(harness.ui.snapshot().draft).toBe("gRPC");
  });

  test("an earlier answer can be revisited and changed before the request is sent", async () => {
    askTwo();
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    harness.testRenderer.mockInput.pressArrow("left");
    await settle();
    // Revisiting highlights the answer already given.
    expect(harness.testRenderer.captureCharFrame()).toContain("❯ 1  HTTP/2");
    harness.testRenderer.mockInput.pressArrow("down");
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    // Re-answering moves on to the question still waiting, and nothing has been sent.
    expect(harness.driver.permissionDecisions).toEqual([]);
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Which environments?",
    );
    await harness.testRenderer.mockInput.typeText(" ");
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.driver.permissionDecisions).toEqual([
      {
        requestId: "perm-2",
        outcome: "allow",
        answers: {
          "Which transport?": "WebSocket",
          "Which environments?": ["staging"],
        },
      },
    ]);
  });

  test("the card lists an Other row that typing highlights", async () => {
    askTwo();
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Other — type your own below",
    );
    await harness.testRenderer.mockInput.typeText("g");
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "❯ ✎  Other — type your own below",
    );
  });

  test("Escape on a question with no reject option neither answers nor interrupts", async () => {
    askTwo();
    await settle();
    await harness.testRenderer.mockInput.typeText("half an ans");
    harness.testRenderer.mockInput.pressEscape();
    await Bun.sleep(30);
    await settle();

    expect(harness.ui.snapshot().draft).toBe("");
    expect(harness.driver.cancelledTurns).toEqual([]);
    expect(harness.driver.permissionDecisions).toEqual([]);
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Which transport?",
    );
  });

  test("a settled card keeps what was answered", async () => {
    askTwo();
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    await harness.testRenderer.mockInput.typeText("canary");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "elicitation-settled",
        requestId: "perm-2",
        outcome: "answered",
      }),
    );
    // The provider event schedules its repaint on the next tick.
    await Bun.sleep(10);
    await settle();

    expect(harness.testRenderer.captureCharFrame()).toContain(
      "✓ Transport: HTTP/2 · Rollout: canary",
    );
  });

  test("a multi-select keeps selected options beside a typed custom answer", async () => {
    askTwo();
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    await harness.testRenderer.mockInput.typeText(" ");
    await settle();
    await harness.testRenderer.mockInput.typeText("canary");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      {
        requestId: "perm-2",
        outcome: "allow",
        answers: {
          "Which transport?": "HTTP/2",
          "Which environments?": ["staging", "canary"],
        },
      },
    ]);
  });
});

describe("a bare approval offers Hive's verdicts", () => {
  function askApproval(): void {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "approval-waiting",
        requestId: "allow-1",
        turnId: "t1",
        toolName: "bash",
        summary: "run tests",
        detail: "bun test",
      }),
    );
  }

  test("2 allows for the rest of the session", async () => {
    askApproval();
    await settle();
    await harness.testRenderer.mockInput.typeText("2");
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "allow-1", outcome: "allow", scope: "session" },
    ]);
  });

  test("3 denies, and the settled card says so", async () => {
    askApproval();
    await settle();
    await harness.testRenderer.mockInput.typeText("3");
    await settle();
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "elicitation-settled",
        requestId: "allow-1",
        outcome: "deny",
      }),
    );
    // The provider event schedules its repaint on the next tick.
    await Bun.sleep(10);
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "allow-1", outcome: "deny" },
    ]);
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "✗ run tests — No",
    );
  });
});
