import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatRate,
  renderProgressLine,
  startDownload,
} from "./progress";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`);

describe("formatBytes", () => {
  test("scales to the unit a human would use", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(65_231_808)).toBe("65.2 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.40 GB");
  });
});

describe("formatRate", () => {
  test("renders bytes per second, and refuses to invent one", () => {
    expect(formatRate(9_600_000)).toBe("9.6 MB/s");
    // Before any time has passed there is no rate. Showing 0 B/s would read as
    // a stalled download; showing nothing reads as "not yet known", which is true.
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0)).toBe("—");
  });
});

describe("renderProgressLine", () => {
  test("names the artifact, the fraction, the counts, and the speed", () => {
    const line = renderProgressLine({
      name: "hive-darwin-arm64",
      read: 34_100_000,
      total: 65_200_000,
      bytesPerSecond: 9_600_000,
      columns: 100,
    });
    expect(line).toContain("hive-darwin-arm64");
    expect(line).toContain("52%");
    expect(line).toContain("34.1 MB/65.2 MB");
    expect(line).toContain("9.6 MB/s");
    expect(line).toMatch(/\[#+-+\]/);
  });

  test("without a Content-Length it shows what it knows and invents no percentage", () => {
    const line = renderProgressLine({
      name: "hive-darwin-arm64",
      read: 1_000_000,
      total: null,
      bytesPerSecond: 500_000,
    });
    expect(line).toContain("1.0 MB");
    expect(line).toContain("500.0 KB/s");
    expect(line).not.toContain("%");
    expect(line).not.toContain("[");
  });

  test("never exceeds the terminal width, because a wrapped bar smears on redraw", () => {
    for (const columns of [40, 60, 80, 120]) {
      const line = renderProgressLine({
        name: "hive-darwin-arm64",
        read: 34_100_000,
        total: 65_200_000,
        bytesPerSecond: 9_600_000,
        columns,
      });
      expect(line.length).toBeLessThan(columns);
    }
  });

  test("a terminal reporting zero columns still gets the full line", () => {
    // A PTY that is not a real terminal (`script`, some CI runners) reports
    // columns as 0. `??` does not catch a zero, so this silently degraded to a
    // bare percentage — no bar, no counts, no speed — on exactly the machines
    // whose output someone is reading. Caught by running it, so it is pinned here.
    for (const columns of [0, undefined, Number.NaN, -1]) {
      const line = renderProgressLine({
        name: "hive-darwin-arm64",
        read: 34_100_000,
        total: 65_200_000,
        bytesPerSecond: 9_600_000,
        columns: columns as number | undefined,
      });
      expect(line).toContain("52%");
      expect(line).toContain("34.1 MB/65.2 MB");
      expect(line).toContain("9.6 MB/s");
      expect(line).toMatch(/\[#+-+\]/);
    }
  });

  test("a complete download reads as 100%, not 99%", () => {
    const line = renderProgressLine({
      name: "a",
      read: 100,
      total: 100,
      bytesPerSecond: 10,
      columns: 80,
    });
    expect(line).toContain("100%");
  });
});

describe("startDownload", () => {
  test("announces the artifact and its size before a single byte arrives", () => {
    const written: string[] = [];
    startDownload("hive-darwin-arm64", 65_231_808, {
      write: (text) => written.push(text),
      isTTY: true,
      columns: 100,
      now: () => 0,
    });
    // The size comes from the already-verified manifest, so it costs no round
    // trip and is on screen at the moment the user is asked to wait.
    expect(written.join("")).toContain("downloading hive-darwin-arm64 (65.2 MB)");
  });

  test("redraws one line on a TTY rather than scrolling a wall of output", () => {
    const written: string[] = [];
    let clock = 0;
    const reporter = startDownload("hive-darwin-arm64", 1_000, {
      write: (text) => written.push(text),
      isTTY: true,
      columns: 100,
      now: () => clock,
    });
    for (let read = 0; read <= 1_000; read += 100) {
      clock += 100; // past the redraw throttle each time
      reporter.onProgress(read, 1_000);
    }
    reporter.finish("done.");

    const bars = written.filter((chunk) => chunk.includes("\r"));
    expect(bars.length).toBeGreaterThan(1);
    // Every redraw erases the previous line instead of printing a new one.
    for (const bar of bars) expect(bar.startsWith(`\r${ESC}[2K`)).toBe(true);
    expect(written.join("")).toContain("done.");
  });

  test("throttles redraws, so a fast download does not spend its time drawing", () => {
    const written: string[] = [];
    let clock = 0;
    const reporter = startDownload("a", 10_000, {
      write: (text) => written.push(text),
      isTTY: true,
      columns: 100,
      now: () => clock,
    });
    // 1000 chunks arriving inside a single redraw interval.
    for (let index = 0; index < 1_000; index += 1) {
      clock += 1;
      reporter.onProgress(index * 10, 10_000);
    }
    const bars = written.filter((chunk) => chunk.includes("\r"));
    expect(bars.length).toBeLessThan(20);
  });

  test("a pipe or a CI log gets no ANSI and no carriage returns", () => {
    const written: string[] = [];
    const reporter = startDownload("hive-darwin-arm64", 65_231_808, {
      write: (text) => written.push(text),
      isTTY: false,
      now: () => 0,
    });
    for (let read = 0; read <= 65_231_808; read += 6_523_180) {
      reporter.onProgress(read, 65_231_808);
    }
    reporter.finish("hive 0.0.9 staged.");

    const output = written.join("");
    // The whole point of the non-TTY branch: a `\r`-redrawn bar in a log file
    // is one enormous unreadable line.
    expect(output).not.toContain("\r");
    expect(output).not.toMatch(ANSI);
    expect(output).toContain("downloading hive-darwin-arm64 (65.2 MB)");
    expect(output).toContain("hive 0.0.9 staged.");
    // One line for the announcement, one for the summary. Nothing in between.
    expect(output.trimEnd().split("\n")).toHaveLength(2);
  });

  test("an unknown size still announces the artifact by name", () => {
    const written: string[] = [];
    startDownload("HiveWorkspace.tar.gz", null, {
      write: (text) => written.push(text),
      isTTY: false,
    });
    expect(written.join("")).toBe("downloading HiveWorkspace.tar.gz\n");
  });
});
