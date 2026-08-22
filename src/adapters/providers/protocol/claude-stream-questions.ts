import { isRecord, isString } from "../../../shared/is-record";
import { asString, type JsonObject } from "./claude-stream-wire";
import type { ElicitationOption, ElicitationQuestion } from "./types";

export const ASK_USER_QUESTION = "AskUserQuestion";

/** Claude Code's AskUserQuestion input as structured questions. The tool arrives as an ordinary `can_use_tool` permission request rather than on a question-specific channel, so the questions have to be read out of the tool input. The answer goes back the same way — see `answersInput` — keyed by the question text, which is why `questionId` is that text verbatim. */
export function claudeQuestions<T>(input: T): readonly ElicitationQuestion[] {
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  const questions: ElicitationQuestion[] = [];
  for (const entry of input.questions) {
    if (!isRecord(entry)) continue;
    const text = asString(entry.question);
    if (text === null) continue;
    const options: ElicitationOption[] = [];
    if (Array.isArray(entry.options)) {
      for (const option of entry.options) {
        const label = isRecord(option)
          ? asString(option.label)
          : asString(option);
        if (label === null) continue;
        options.push({
          optionId: label,
          name: label,
          kind: "allow",
          description: isRecord(option) ? asString(option.description) : null,
        });
      }
    }
    questions.push({
      questionId: text,
      text,
      header: asString(entry.header),
      multiSelect: entry.multiSelect === true,
      allowCustom: true,
      secret: false,
      options,
    });
  }
  return questions;
}

/** The tool input to allow with, carrying the person's selections. Claude Code reads answers off the input the permission layer returns and matches them against each question's labels; anything it cannot match reads to the model as "the user did not answer". A question with no selection is left out rather than sent empty, so a partial answer stays partial instead of being reported as a refusal of the questions that were answered. */
export function answersInput<T>(
  input: T,
  answers: Readonly<Record<string, string | readonly string[]>>,
): JsonObject {
  const base = isRecord(input) ? input : {};
  const chosen: JsonObject = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (!isString(value)) {
      if (value.length === 0) continue;
      chosen[questionId] = [...value];
      continue;
    }
    if (value === "") continue;
    chosen[questionId] = value;
  }
  return { ...base, answers: chosen };
}

/** Claude Code's AskUserQuestion input, rendered as text, for surfaces that show an elicitation as a line rather than a picker. */
export function claudeQuestionText<T>(input: T): string | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const blocks: string[] = [];
  for (const entry of input.questions) {
    if (!isRecord(entry)) continue;
    const question = asString(entry.question);
    if (question === null) continue;
    const header = asString(entry.header);
    const lines = [header === null ? question : `${header}: ${question}`];
    if (Array.isArray(entry.options)) {
      for (const option of entry.options) {
        const label = isRecord(option)
          ? asString(option.label)
          : asString(option);
        if (label !== null) lines.push(`  • ${label}`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.length === 0 ? null : blocks.join("\n\n");
}
