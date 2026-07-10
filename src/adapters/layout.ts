// Pure window-layout computation for the Hive terminal wall. No osascript,
// no I/O: screens and windows are plain frames in top-left-origin global
// coordinates (the space AppleScript window bounds use), which keeps every
// arrangement decision unit-testable.

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Smallest useful worker viewer, in pixels. Below this, centered mode
   * yields to the uniform grid. */
  minWorkerWidth: number;
  minWorkerHeight: number;
  /** Preferred orchestrator column width as a fraction of the screen. */
  centerFraction: number;
  /** The orchestrator column may be squeezed down to this fraction before
   * centered mode is abandoned; above one third of the screen it is always
   * wider than a side column, so the orchestrator stays the largest window. */
  minCenterFraction: number;
  minCenterWidth: number;
  /** Orchestrator size when it is the only hive window on screen. */
  soloWidthFraction: number;
  soloHeightFraction: number;
  /** Target cell width:height ratio for the uniform grid fallback. */
  gridCellAspect: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  minWorkerWidth: 420,
  minWorkerHeight: 260,
  centerFraction: 0.42,
  minCenterFraction: 0.36,
  minCenterWidth: 600,
  soloWidthFraction: 0.7,
  soloHeightFraction: 0.85,
  gridCellAspect: 1.5,
};

export type LayoutMode = "centered" | "grid";

export interface ComputedLayout {
  mode: LayoutMode;
  orchestrator: Frame | null;
  workers: Frame[];
}

/** Integer partition boundary: splitting `extent` into `count` parts, the
 * edge between part `index - 1` and part `index`. Guarantees exact tiling
 * with no rounding gaps or overlaps. */
const boundary = (
  index: number,
  count: number,
  start: number,
  extent: number,
): number => start + Math.round((index * extent) / count);

/** Tile `count` frames into a region as `cols` columns of stacked rows,
 * column-major, extra rows going to the earlier columns. */
function tileColumns(region: Frame, count: number, cols: number): Frame[] {
  const frames: Frame[] = [];
  const baseRows = Math.floor(count / cols);
  const extraRows = count % cols;
  for (let column = 0; column < cols; column += 1) {
    const rows = baseRows + (column < extraRows ? 1 : 0);
    const left = boundary(column, cols, region.x, region.width);
    const right = boundary(column + 1, cols, region.x, region.width);
    for (let row = 0; row < rows; row += 1) {
      const top = boundary(row, rows, region.y, region.height);
      const bottom = boundary(row + 1, rows, region.y, region.height);
      frames.push({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
    }
  }
  return frames;
}

/** Uniform grid over the whole screen, row-major. Rows split the width
 * among only the cells they actually hold, so a partial last row stretches
 * instead of leaving a hole. Never fails: cells just get small. */
function tileGrid(screen: Frame, total: number, options: LayoutOptions): Frame[] {
  if (total <= 0) {
    return [];
  }
  let bestCols = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let cols = 1; cols <= total; cols += 1) {
    const rows = Math.ceil(total / cols);
    const cellAspect = (screen.width / cols) / (screen.height / rows);
    const score = Math.abs(Math.log(cellAspect / options.gridCellAspect));
    if (score < bestScore) {
      bestScore = score;
      bestCols = cols;
    }
  }

  const rows = Math.ceil(total / bestCols);
  const frames: Frame[] = [];
  let placed = 0;
  for (let row = 0; row < rows; row += 1) {
    const cellsInRow = Math.min(bestCols, total - placed);
    const top = boundary(row, rows, screen.y, screen.height);
    const bottom = boundary(row + 1, rows, screen.y, screen.height);
    for (let cell = 0; cell < cellsInRow; cell += 1) {
      const left = boundary(cell, cellsInRow, screen.x, screen.width);
      const right = boundary(cell + 1, cellsInRow, screen.x, screen.width);
      frames.push({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
      placed += 1;
    }
  }
  return frames;
}

export function centermostFrameIndex(frames: Frame[], screen: Frame): number {
  const centerX = screen.x + screen.width / 2;
  const centerY = screen.y + screen.height / 2;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const distance = (frame.x + frame.width / 2 - centerX) ** 2 +
      (frame.y + frame.height / 2 - centerY) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/** Centered mode: the orchestrator is a full-height center column, workers
 * stack in symmetric side columns (right side takes the odd worker). Returns
 * null when the screen cannot hold every worker at the configured minimum
 * cell size while keeping the center column dominant. */
function computeCentered(
  screen: Frame,
  workerCount: number,
  options: LayoutOptions,
): ComputedLayout | null {
  const maxRows = Math.floor(screen.height / options.minWorkerHeight);
  if (maxRows < 1) {
    return null;
  }
  const leftCount = Math.floor(workerCount / 2);
  const rightCount = workerCount - leftCount;
  const leftCols = leftCount === 0 ? 0 : Math.ceil(leftCount / maxRows);
  const rightCols = Math.ceil(rightCount / maxRows);
  const sideCols = Math.max(leftCols, rightCols);

  const minCenter = Math.max(
    options.minCenterWidth,
    Math.round(screen.width * options.minCenterFraction),
  );
  const maxCenter = screen.width - 2 * sideCols * options.minWorkerWidth;
  if (maxCenter < minCenter) {
    return null;
  }
  const centerWidth = Math.min(
    maxCenter,
    Math.max(minCenter, Math.round(screen.width * options.centerFraction)),
  );
  const sideWidth = Math.round((screen.width - centerWidth) / 2);

  const rightFrames = tileColumns(
    {
      x: screen.x + screen.width - sideWidth,
      y: screen.y,
      width: sideWidth,
      height: screen.height,
    },
    rightCount,
    rightCols,
  );
  const leftFrames = leftCount === 0 ? [] : tileColumns(
    { x: screen.x, y: screen.y, width: sideWidth, height: screen.height },
    leftCount,
    leftCols,
  );

  // An unused left side is folded into the orchestrator instead of being
  // left as a dead strip.
  const orchestratorX = leftCount === 0 ? screen.x : screen.x + sideWidth;
  return {
    mode: "centered",
    orchestrator: {
      x: orchestratorX,
      y: screen.y,
      width: screen.x + screen.width - sideWidth - orchestratorX,
      height: screen.height,
    },
    workers: [...rightFrames, ...leftFrames],
  };
}

/**
 * Arrange the hive window wall on one screen.
 *
 * Centered mode keeps the orchestrator materially larger than any worker
 * (full height, and the widest column by construction). When worker count or
 * screen size make that infeasible, everything degrades to a uniform grid in
 * which the orchestrator holds the most central cell. Worker frames come back
 * in input order: right side top-to-bottom, then left side, or reading order
 * in grid mode.
 */
export function computeLayout(
  screen: Frame,
  workerCount: number,
  hasOrchestrator: boolean,
  overrides: Partial<LayoutOptions> = {},
): ComputedLayout {
  const options = { ...DEFAULT_LAYOUT_OPTIONS, ...overrides };
  const count = Math.max(0, Math.floor(workerCount));

  if (!hasOrchestrator) {
    return {
      mode: "grid",
      orchestrator: null,
      workers: tileGrid(screen, count, options),
    };
  }

  if (count === 0) {
    const width = Math.min(
      screen.width,
      Math.max(
        options.minCenterWidth,
        Math.round(screen.width * options.soloWidthFraction),
      ),
    );
    const height = Math.round(screen.height * options.soloHeightFraction);
    return {
      mode: "centered",
      orchestrator: {
        x: screen.x + Math.round((screen.width - width) / 2),
        y: screen.y + Math.round((screen.height - height) / 2),
        width,
        height,
      },
      workers: [],
    };
  }

  const centered = computeCentered(screen, count, options);
  if (centered !== null) {
    return centered;
  }

  const cells = tileGrid(screen, count + 1, options);
  const orchestratorIndex = centermostFrameIndex(cells, screen);
  return {
    mode: "grid",
    orchestrator: cells[orchestratorIndex] ?? null,
    workers: cells.filter((_, index) => index !== orchestratorIndex),
  };
}
