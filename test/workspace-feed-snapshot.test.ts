import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceFeedSnapshotFixture,
  WORKSPACE_FEED_SNAPSHOT_FIXTURE,
} from "../scripts/test-fixtures/workspace-feed-snapshot";

describe("the shared Workspace feed wire fixture", () => {
  test("is the exact snapshot emitted by the TypeScript producer", async () => {
    const generated = await buildWorkspaceFeedSnapshotFixture();
    const fixture = await Bun.file(WORKSPACE_FEED_SNAPSHOT_FIXTURE).json();

    expect(fixture).toEqual(generated);
    expect(fixture.v).toBe(1);
    expect(fixture.autonomy).toBe("dangerous");
    expect(fixture.orchestrator).toEqual({ status: "working" });
    expect(fixture.agents[0]).toMatchObject({
      name: "indexer",
      tool: "codex",
      model: "gpt-5.4",
      status: "working",
      taskDescription: "Index the repository",
      tmuxSession: "hive-indexer",
      contextPct: 41.5,
      readOnly: false,
    });
  });
});
