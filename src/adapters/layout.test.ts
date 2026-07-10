import { describe, expect, test } from "bun:test";
import {
  centermostFrameIndex,
  computeLayout,
  DEFAULT_LAYOUT_OPTIONS,
  type ComputedLayout,
  type Frame,
} from "./layout";

// A 16" MacBook Pro visible frame: menu bar shaved off the top.
const laptop: Frame = { x: 0, y: 33, width: 1728, height: 1084 };
const desktop: Frame = { x: 0, y: 25, width: 2560, height: 1415 };
const cramped: Frame = { x: 0, y: 25, width: 800, height: 575 };

const area = (frame: Frame): number => frame.width * frame.height;

function allFrames(layout: ComputedLayout): Frame[] {
  return layout.orchestrator === null
    ? layout.workers
    : [layout.orchestrator, ...layout.workers];
}

function expectWithin(frame: Frame, screen: Frame): void {
  expect(frame.width).toBeGreaterThan(0);
  expect(frame.height).toBeGreaterThan(0);
  expect(frame.x).toBeGreaterThanOrEqual(screen.x);
  expect(frame.y).toBeGreaterThanOrEqual(screen.y);
  expect(frame.x + frame.width).toBeLessThanOrEqual(screen.x + screen.width);
  expect(frame.y + frame.height).toBeLessThanOrEqual(screen.y + screen.height);
}

function expectNoOverlap(frames: Frame[]): void {
  for (let a = 0; a < frames.length; a += 1) {
    for (let b = a + 1; b < frames.length; b += 1) {
      const first = frames[a]!;
      const second = frames[b]!;
      const overlapsHorizontally = first.x < second.x + second.width &&
        second.x < first.x + first.width;
      const overlapsVertically = first.y < second.y + second.height &&
        second.y < first.y + first.height;
      expect(overlapsHorizontally && overlapsVertically).toEqual(false);
    }
  }
}

function expectIntegerFrames(frames: Frame[]): void {
  for (const frame of frames) {
    expect(Number.isInteger(frame.x)).toEqual(true);
    expect(Number.isInteger(frame.y)).toEqual(true);
    expect(Number.isInteger(frame.width)).toEqual(true);
    expect(Number.isInteger(frame.height)).toEqual(true);
  }
}

function expectValid(layout: ComputedLayout, screen: Frame): void {
  const frames = allFrames(layout);
  expectIntegerFrames(frames);
  for (const frame of frames) {
    expectWithin(frame, screen);
  }
  expectNoOverlap(frames);
}

function expectFullCoverage(layout: ComputedLayout, screen: Frame): void {
  const total = allFrames(layout).reduce((sum, frame) => sum + area(frame), 0);
  expect(total).toEqual(area(screen));
}

describe("computeLayout with an orchestrator", () => {
  test("a lone orchestrator floats centered and large", () => {
    const layout = computeLayout(laptop, 0, true);

    expect(layout.mode).toEqual("centered");
    expect(layout.workers).toEqual([]);
    const orchestrator = layout.orchestrator!;
    expectValid(layout, laptop);
    expect(orchestrator.width).toBeGreaterThanOrEqual(
      Math.round(laptop.width * 0.7),
    );
    const centerX = orchestrator.x + orchestrator.width / 2;
    const centerY = orchestrator.y + orchestrator.height / 2;
    expect(Math.abs(centerX - (laptop.x + laptop.width / 2))).toBeLessThan(2);
    expect(Math.abs(centerY - (laptop.y + laptop.height / 2))).toBeLessThan(2);
  });

  test("one worker gets a side column and the orchestrator absorbs the rest", () => {
    const layout = computeLayout(laptop, 1, true);

    expect(layout.mode).toEqual("centered");
    expect(layout.workers.length).toEqual(1);
    expectValid(layout, laptop);
    expectFullCoverage(layout, laptop);
    const worker = layout.workers[0]!;
    const orchestrator = layout.orchestrator!;
    expect(worker.width).toBeGreaterThanOrEqual(
      DEFAULT_LAYOUT_OPTIONS.minWorkerWidth,
    );
    expect(orchestrator.x).toEqual(laptop.x);
    expect(worker.x).toEqual(orchestrator.x + orchestrator.width);
    expect(area(orchestrator)).toBeGreaterThan(area(worker) * 1.3);
  });

  test.each([2, 3, 4, 5, 6, 7, 8])(
    "%d workers tile symmetric side columns around a dominant center",
    (workerCount) => {
      const layout = computeLayout(desktop, workerCount, true);

      expect(layout.mode).toEqual("centered");
      expect(layout.workers.length).toEqual(workerCount);
      expectValid(layout, desktop);
      expectFullCoverage(layout, desktop);

      const orchestrator = layout.orchestrator!;
      expect(orchestrator.height).toEqual(desktop.height);
      for (const worker of layout.workers) {
        expect(worker.width).toBeGreaterThanOrEqual(
          DEFAULT_LAYOUT_OPTIONS.minWorkerWidth,
        );
        expect(worker.height).toBeGreaterThanOrEqual(
          DEFAULT_LAYOUT_OPTIONS.minWorkerHeight,
        );
        expect(area(orchestrator)).toBeGreaterThan(area(worker));
      }

      // Odd worker counts put the extra worker on the right side.
      const rightCount = Math.ceil(workerCount / 2);
      const rightWorkers = layout.workers.filter((worker) =>
        worker.x > orchestrator.x
      );
      expect(rightWorkers.length).toEqual(rightCount);

      // The orchestrator column is horizontally centered.
      const leftGap = orchestrator.x - desktop.x;
      const rightGap = desktop.x + desktop.width -
        (orchestrator.x + orchestrator.width);
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
    },
  );

  test("workers arrive right side first, top to bottom", () => {
    const layout = computeLayout(desktop, 5, true);
    const orchestrator = layout.orchestrator!;
    const [first, second, third, fourth, fifth] = layout.workers;

    // Right column: 3 workers stacked top to bottom.
    expect(first!.x).toBeGreaterThan(orchestrator.x);
    expect(second!.y).toBeGreaterThan(first!.y);
    expect(third!.y).toBeGreaterThan(second!.y);
    // Left column: remaining 2.
    expect(fourth!.x).toBeLessThan(orchestrator.x);
    expect(fifth!.y).toBeGreaterThan(fourth!.y);
  });

  test("falls back to a uniform grid when worker minimums cannot hold", () => {
    const layout = computeLayout(cramped, 6, true);

    expect(layout.mode).toEqual("grid");
    expect(layout.workers.length).toEqual(6);
    expectValid(layout, cramped);
    expectFullCoverage(layout, cramped);

    // The orchestrator holds the most central cell.
    const frames = allFrames(layout);
    const central = frames[centermostFrameIndex(frames, cramped)]!;
    expect(layout.orchestrator).toEqual(central);
  });

  test("grid fallback keeps every window usable at large counts", () => {
    const layout = computeLayout(laptop, 15, true);

    expect(layout.mode).toEqual("grid");
    expect(layout.workers.length).toEqual(15);
    expectValid(layout, laptop);
    expectFullCoverage(layout, laptop);
  });

  test("absurd counts on tiny screens still produce sane frames", () => {
    const tiny: Frame = { x: 0, y: 20, width: 320, height: 240 };
    const layout = computeLayout(tiny, 40, true);

    expect(layout.workers.length).toEqual(40);
    expectValid(layout, tiny);
    expectFullCoverage(layout, tiny);
  });

  test("negative and fractional worker counts are clamped", () => {
    expect(computeLayout(laptop, -3, true).workers).toEqual([]);
    expect(computeLayout(laptop, 2.9, true).workers.length).toEqual(2);
  });
});

describe("computeLayout without an orchestrator", () => {
  test("zero windows yields an empty layout", () => {
    const layout = computeLayout(laptop, 0, false);
    expect(layout.orchestrator).toBeNull();
    expect(layout.workers).toEqual([]);
  });

  test("workers alone tile the whole screen", () => {
    const layout = computeLayout(laptop, 5, false);

    expect(layout.orchestrator).toBeNull();
    expect(layout.workers.length).toEqual(5);
    expectValid(layout, laptop);
    expectFullCoverage(layout, laptop);
  });
});

describe("layout options", () => {
  test("stricter worker minimums force the grid fallback sooner", () => {
    const centered = computeLayout(desktop, 4, true);
    expect(centered.mode).toEqual("centered");

    const grid = computeLayout(desktop, 4, true, {
      minWorkerWidth: 1200,
    });
    expect(grid.mode).toEqual("grid");
  });

  test("centered mode splits a side into multiple columns when rows run out", () => {
    // 10 workers, 5 per side; at most 3 rows fit, so each side needs 2 columns.
    const wide: Frame = { x: 0, y: 25, width: 3800, height: 1000 };
    const layout = computeLayout(wide, 10, true, {
      minWorkerHeight: 320,
      minWorkerWidth: 420,
    });

    expect(layout.mode).toEqual("centered");
    expectValid(layout, wide);
    expectFullCoverage(layout, wide);
    const orchestrator = layout.orchestrator!;
    const rightXs = new Set(
      layout.workers.filter((worker) => worker.x > orchestrator.x)
        .map((worker) => worker.x),
    );
    expect(rightXs.size).toEqual(2);
    for (const worker of layout.workers) {
      expect(worker.height).toBeGreaterThanOrEqual(320);
      expect(worker.width).toBeGreaterThanOrEqual(420);
    }
  });
});
