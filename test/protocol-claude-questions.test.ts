import { describe, expect, test } from "bun:test";
import { claudeQuestions } from "../src/adapters/providers/protocol/claude-stream-questions";

/**
 * Shape captured from Claude Code 2.1.220 driving `AskUserQuestion` over
 * stream-json; see the `can_use_tool` control request it sends.
 */
const askInput = {
  questions: [
    {
      question: "Which colour do you prefer?",
      header: "Colour",
      multiSelect: false,
      options: [
        { label: "Red", description: "You prefer red.", preview: "#f00" },
        { label: "Blue", description: "You prefer blue." },
      ],
    },
    {
      question: "Which environments?",
      header: "Rollout",
      multiSelect: true,
      options: [{ label: "staging", description: "Safe." }],
    },
  ],
};

describe("Claude Code questions", () => {
  test("every question and option is read out of the tool input", () => {
    const questions = claudeQuestions(askInput);

    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      questionId: "Which colour do you prefer?",
      header: "Colour",
      multiSelect: false,
      allowCustom: true,
      secret: false,
    });
    expect(questions[0]?.options.map((option) => option.name)).toEqual([
      "Red",
      "Blue",
    ]);
    expect(questions[0]?.options[0]?.description).toBe("You prefer red.");
    expect(questions[0]?.options[0]?.preview).toBe("#f00");
    expect(questions[0]?.options[1]?.preview).toBeNull();
    expect(questions[1]?.multiSelect).toBe(true);
  });

  test("the question id is the question text, which is how answers key back", () => {
    // Claude Code matches `answers` by exact question text; a derived id would
    // read to the model as "the user did not answer the questions".
    for (const question of claudeQuestions(askInput)) {
      expect(question.questionId).toBe(question.text);
    }
  });

  test("an option id is its label, because that is what is sent back", () => {
    const [first] = claudeQuestions(askInput);
    for (const option of first?.options ?? []) {
      expect(option.optionId).toBe(option.name);
    }
  });

  test("a non-question tool input yields no questions", () => {
    expect(claudeQuestions({ command: "pwd" })).toEqual([]);
    expect(claudeQuestions(undefined)).toEqual([]);
  });
});
