import { describe, expect, test } from "bun:test";
import {
  assessResources,
  descendantsOf,
  parseAvailableMemoryMb,
  parseProcessTable,
  type ProcessSample,
} from "./resources";

const sample = (
  pid: number,
  ppid: number,
  rssMb: number,
  command = "some-process",
): ProcessSample => ({ pid, ppid, rssMb, command });

describe("parseProcessTable", () => {
  test("parses ps output and converts rss to megabytes", () => {
    const parsed = parseProcessTable([
      "  101     1  2048 /opt/homebrew/bin/bun test",
      "  202   101 10240 codex app-server --stdio",
      "garbage line",
      "",
    ].join("\n"));
    expect(parsed).toEqual([
      { pid: 101, ppid: 1, rssMb: 2, command: "/opt/homebrew/bin/bun test" },
      { pid: 202, ppid: 101, rssMb: 10, command: "codex app-server --stdio" },
    ]);
  });
});

describe("parseAvailableMemoryMb", () => {
  test("sums reclaimable page classes at the reported page size", () => {
    const raw = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                              65536.",
      "Pages active:                           540432.",
      "Pages inactive:                          65536.",
      "Pages speculative:                       16384.",
      "Pages purgeable:                         16384.",
    ].join("\n");
    // (65536 + 65536 + 16384 + 16384) pages * 16 KiB = 2560 MiB
    expect(parseAvailableMemoryMb(raw)).toBe(2560);
  });

  test("returns null for unrecognizable output", () => {
    expect(parseAvailableMemoryMb("no vm_stat here")).toBeNull();
  });
});

describe("descendantsOf", () => {
  test("walks the full tree under the roots, tolerating cycles", () => {
    const samples = [
      sample(10, 1, 1),
      sample(20, 10, 1),
      sample(30, 20, 1),
      sample(40, 40, 1), // self-parented, unrelated
      sample(50, 1, 1),
    ];
    expect(descendantsOf(samples, [10]).map((entry) => entry.pid))
      .toEqual([10, 20, 30]);
    expect(descendantsOf(samples, [40]).map((entry) => entry.pid))
      .toEqual([40]);
  });
});

describe("assessResources", () => {
  const limits = {
    enabled: true,
    perProcessMemoryMb: 12_288,
    minSystemAvailableMb: 4_096,
  };

  test("flags oversized processes under watched sessions only", () => {
    const samples = [
      sample(500, 1, 200, "hive daemon"),
      sample(10, 1, 100, "claude"), // maya's pane root
      sample(11, 10, 90_000, "bun test"), // the runaway
      sample(90, 1, 90_000, "unrelated-user-process"),
    ];
    const assessment = assessResources({
      samples,
      sessions: [{ owner: "maya", rootPids: [10] }],
      daemonPid: 500,
      availableMb: 30_000,
      limits,
    });
    expect(assessment.kills).toEqual([
      { owner: "maya", process: sample(11, 10, 90_000, "bun test") },
    ]);
    expect(assessment.daemonRssMb).toBe(200);
    expect(assessment.memoryPressure).toBe(false);
  });

  test("never kills the daemon itself and reports memory pressure", () => {
    const samples = [sample(500, 1, 90_000, "hive daemon")];
    const assessment = assessResources({
      samples,
      sessions: [{ owner: "orchestrator", rootPids: [500] }],
      daemonPid: 500,
      availableMb: 1_000,
      limits,
    });
    expect(assessment.kills).toEqual([]);
    expect(assessment.memoryPressure).toBe(true);
  });

  test("attributes a process shared by two sessions exactly once", () => {
    const samples = [sample(10, 1, 90_000, "bun test")];
    const assessment = assessResources({
      samples,
      sessions: [
        { owner: "maya", rootPids: [10] },
        { owner: "sam", rootPids: [10] },
      ],
      daemonPid: 500,
      availableMb: null,
      limits,
    });
    expect(assessment.kills).toHaveLength(1);
    expect(assessment.memoryPressure).toBe(false);
  });
});
