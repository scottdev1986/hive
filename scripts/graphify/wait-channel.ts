#!/usr/bin/env bun
import { graphifyPin } from "../../src/adapters/graphify";
import { fetchGraphifyRelease } from "../../src/adapters/graphify-channel";

const expected = graphifyPin();

/**
 * The object ids of everything that determines the runtime channel's content:
 * the pin and the builder. The publisher stamps its manifest with the pushed
 * HEAD, which batching makes an unreliable name for the same sources — two
 * shas with identical graphify inputs produce identical channels, so identity
 * is judged on the inputs, never on which push happened to carry them.
 */
function graphifyInputIds(commit: string): string | null {
  const proc = Bun.spawnSync([
    "git",
    "rev-parse",
    `${commit}:graphify.lock`,
    `${commit}:scripts/graphify`,
  ]);
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
}

const expectedInputs = graphifyInputIds("HEAD");
if (expectedInputs === null) {
  throw new Error("cannot read this checkout's graphify inputs");
}
const deadline = Date.now() + 15 * 60_000;
let last = "channel not checked";

while (Date.now() < deadline) {
  try {
    const release = await fetchGraphifyRelease();
    if (
      release.manifest.graphifyVersion === expected &&
      graphifyInputIds(release.manifest.sourceCommit) === expectedInputs
    ) {
      console.log(
        `Graphify channel carries graphifyy==${expected} (${release.manifest.tag}) ` +
          `built from matching graphify sources at ${release.manifest.sourceCommit}`,
      );
      process.exit(0);
    }
    last =
      `channel carries ${release.manifest.graphifyVersion} from ` +
      `${release.manifest.sourceCommit}, whose graphify inputs differ from HEAD's`;
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
  }
  await Bun.sleep(10_000);
}
throw new Error(
  `Graphify channel did not publish graphifyy==${expected}: ${last}`,
);
