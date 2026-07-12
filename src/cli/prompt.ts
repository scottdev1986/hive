/**
 * The one interactive prompt surface in Hive's CLI.
 *
 * Hive's commands are non-interactive by principle (init's doc comment makes
 * it a design rule): scripts and CI must never hang on a question. This
 * helper keeps that promise structurally — it asks only when stdin AND stdout
 * are TTYs, and returns null otherwise so the caller falls back to its
 * scriptable default. Explicit flags always win before this is ever called.
 */
import { createInterface } from "node:readline/promises";

export type ConfirmFn = (
  question: string,
  defaultAnswer: boolean,
) => Promise<boolean | null>;

/** Ask a y/n question on the controlling terminal. Enter takes the default;
 * anything starting with y/Y is yes, n/N is no, and other input re-asks once
 * before taking the default. Returns null when there is no terminal to ask. */
export const confirmOnTty: ConfirmFn = async (question, defaultAnswer) => {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return null;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultAnswer ? "[Y/n]" : "[y/N]";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = (await readline.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (answer === "") return defaultAnswer;
      if (answer.startsWith("y")) return true;
      if (answer.startsWith("n")) return false;
    }
    return defaultAnswer;
  } finally {
    readline.close();
  }
};
