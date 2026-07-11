import { describe, expect, test } from "bun:test";
import {
  assessResources,
  descendantsOf,
  parseAvailableMemoryMb,
  parseProcessTable,
  processCommandName,
  treeRunsCommand,
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

describe("is the launched process alive in this pane", () => {
  // Exactly what `ps -axo pid=,ppid=,rss=,command=` returns for a real hive
  // pane, captured from one: the pane's process is the wrapper shell, and the
  // provider is its child.
  const pane = parseProcessTable([
    ` 1915  6158   2416 zsh -c (claude "hi"); s=$?; if [ "$s" -ne 0 ]; then sleep 15; fi; exit $s`,
    " 1917  1915 425488 claude hi",
  ].join("\n"));

  test("finds the provider under the wrapper shell", () => {
    expect(treeRunsCommand(pane, [1915], "claude")).toBe(true);
  });

  test("a wrapper that merely MENTIONS the provider is not the provider", () => {
    // The load-bearing subtlety. The wrapper's command line contains the string
    // "claude" — hive put it there — so a substring match would call any wrapper
    // a live agent, including one whose child has exited, which is the exact
    // failure this check exists to catch. Only argv[0] names what is running.
    const orphaned = parseProcessTable(
      ` 1915  6158   2416 zsh -c (claude "hi"); s=$?; if [ "$s" -ne 0 ]; then sleep 15; fi; exit $s`,
    );
    expect(orphaned).toHaveLength(1);
    expect(treeRunsCommand(orphaned, [1915], "claude")).toBe(false);
  });

  test("names the binary, not the path it was found at", () => {
    expect(processCommandName("/Users/x/.local/bin/codex -c model=gpt")).toEqual("codex");
    expect(processCommandName("claude hi")).toEqual("claude");
  });

  test("the app-server host is a `hive` process, and is found as one", () => {
    // A check hardcoded to "codex" would report every app-server agent dead.
    const host = parseProcessTable([
      " 2001  6158   2416 zsh -c (hive codex-app-server-host --port 4317)",
      " 2002  2001  90000 hive codex-app-server-host --port 4317",
    ].join("\n"));
    expect(treeRunsCommand(host, [2001], "hive")).toBe(true);
    expect(treeRunsCommand(host, [2001], "codex")).toBe(false);
  });
});
