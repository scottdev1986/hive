import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  agentTmuxSession,
  hiveInstanceSuffix,
  isTmuxSessionForInstance,
  orchestratorTmuxSession,
} from "./tmux-sessions";

describe("instance-scoped tmux session names", () => {
  test("derives stable short names from the resolved absolute HIVE_HOME", () => {
    const home = "/tmp/hive-instance/../hive-instance";
    expect(hiveInstanceSuffix(home)).toEqual(hiveInstanceSuffix(resolve(home)));
    expect(hiveInstanceSuffix(home)).toMatch(/^[0-9a-f]{10}$/);
    expect(agentTmuxSession("maya", home)).toEqual(
      `hive-maya-${hiveInstanceSuffix(home)}`,
    );
    expect(orchestratorTmuxSession(home)).toEqual(
      `hive-orchestrator-${hiveInstanceSuffix(home)}`,
    );
  });

  test("different HIVE_HOMEs cannot match each other's sessions", () => {
    const scratchA = "/tmp/hive-a";
    const scratchB = "/tmp/hive-b";
    expect(isTmuxSessionForInstance(agentTmuxSession("maya", scratchA), scratchA))
      .toEqual(true);
    expect(isTmuxSessionForInstance(agentTmuxSession("maya", scratchB), scratchA))
      .toEqual(false);
    expect(isTmuxSessionForInstance(orchestratorTmuxSession(scratchB), scratchA))
      .toEqual(false);
    expect(isTmuxSessionForInstance("hive-orchestrator", scratchA)).toEqual(false);
    expect(isTmuxSessionForInstance("hive-maya", scratchA)).toEqual(false);
  });
});
