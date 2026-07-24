#!/usr/bin/env bun
import { graphifyPin } from "../../src/adapters/graphify";
import { fetchGraphifyRelease } from "../../src/adapters/graphify-channel";

const expected = graphifyPin();
const deadline = Date.now() + 15 * 60_000;
let last = "channel not checked";

while (Date.now() < deadline) {
  try {
    const release = await fetchGraphifyRelease();
    if (release.manifest.graphifyVersion === expected) {
      console.log(
        `Graphify channel carries graphifyy==${expected} (${release.manifest.tag})`,
      );
      process.exit(0);
    }
    last = `channel carries ${release.manifest.graphifyVersion}`;
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
  }
  await Bun.sleep(10_000);
}
throw new Error(
  `Graphify channel did not publish graphifyy==${expected}: ${last}`,
);
