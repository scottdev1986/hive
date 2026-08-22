/** Child half of the runner's deadline test. Bun snapshots the environment at process start, so a PATH stubbed from inside the test process never reaches a spawned grandchild — only a child born with the stub `git` already first on its PATH measures the runner's real deadline behavior. */
import { runGit } from "../../src/adapters/git";

// SAFETY: The test owns this value and its fields.
const cwd = process.argv[2] as string;
const timeoutMs = Number(process.argv[3]);
const result = await runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs });
console.log(JSON.stringify(result));
