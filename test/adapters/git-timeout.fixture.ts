import { runGit } from "../../src/adapters/git";

// SAFETY: The test owns this value and its fields.
const cwd = process.argv[2] as string;
const timeoutMs = Number(process.argv[3]);
const result = await runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs });
console.log(JSON.stringify(result));
