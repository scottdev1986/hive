import { createInterface } from "node:readline/promises";

export type ConfirmFn = (
  question: string,
  defaultAnswer: boolean,
) => Promise<boolean | null>;

export const confirmOnTty: ConfirmFn = async (question, defaultAnswer) => {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return null;
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const suffix = defaultAnswer ? "[Y/n]" : "[y/N]";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = (await readline.question(`${question} ${suffix} `))
        .trim()
        .toLowerCase();
      if (answer === "") return defaultAnswer;
      if (answer.startsWith("y")) return true;
      if (answer.startsWith("n")) return false;
    }
    return defaultAnswer;
  } finally {
    readline.close();
  }
};
