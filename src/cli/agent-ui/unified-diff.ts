import { createTwoFilesPatch } from "diff";
import type { ToolFileChange } from "../../adapters/providers/protocol/types";

export function unifiedDiff(change: ToolFileChange): string {
  const created = change.oldText === null;
  return createTwoFilesPatch(
    created ? "/dev/null" : change.path,
    change.path,
    change.oldText ?? "",
    change.newText,
    undefined,
    undefined,
    { context: 3 },
  );
}

export interface DiffStats {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

export interface ProjectedFileChange {
  readonly path: string;
  readonly diff: string;
  readonly rows: number;
}

export interface ToolDiffProjection {
  readonly changes: readonly ProjectedFileChange[];
  readonly stats: DiffStats;
}

export type ToolDiffProjectionState =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly projection: ToolDiffProjection }
  | { readonly status: "error" };

interface DiffWorkerRequest {
  readonly id: number;
  readonly changes: readonly ToolFileChange[];
}

interface DiffWorkerResponse {
  readonly id: number;
  readonly projection?: ToolDiffProjection;
  readonly error?: string;
}

const BACKGROUND_DIFF_INPUT_CHARS = 16 * 1024;

export function sameToolFileChanges(
  left: readonly ToolFileChange[],
  right: readonly ToolFileChange[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((change, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      change.path === other.path &&
      change.oldText === other.oldText &&
      change.newText === other.newText
    );
  });
}

export function projectToolChanges(
  changes: readonly ToolFileChange[],
): ToolDiffProjection {
  let added = 0;
  let removed = 0;
  const projected = changes.map((change) => {
    const diff = unifiedDiff(change);
    const summary = summarizeUnifiedDiff(diff);
    added += summary.stats.added;
    removed += summary.stats.removed;
    return { path: change.path, diff, rows: summary.rows };
  });
  return {
    changes: projected,
    stats: {
      files: new Set(changes.map((change) => change.path)).size,
      added,
      removed,
    },
  };
}

class DiffProjectionWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (projection: ToolDiffProjection) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  project(changes: readonly ToolFileChange[]): Promise<ToolDiffProjection> {
    const worker = this.worker ?? this.start();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: DiffWorkerRequest = { id, changes };
      worker.postMessage(request);
    });
  }

  dispose(): void {
    this.failPending(new Error("diff worker disposed"));
    this.worker?.terminate();
    this.worker = null;
  }

  private start(): Worker {
    const worker = new Worker(
      new URL("./unified-diff-worker.ts", import.meta.url).href,
      { ref: false },
    );
    worker.addEventListener(
      "message",
      (event: MessageEvent<DiffWorkerResponse>) => {
        const response = event.data;
        const pending = this.pending.get(response.id);
        if (pending === undefined) return;
        this.pending.delete(response.id);
        if (response.projection !== undefined) {
          pending.resolve(response.projection);
        } else {
          pending.reject(new Error(response.error ?? "diff worker failed"));
        }
      },
    );
    worker.addEventListener("error", (event) => {
      this.failPending(new Error(event.message));
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function shouldProjectInBackground(
  changes: readonly ToolFileChange[],
): boolean {
  let inputChars = 0;
  for (const change of changes) {
    inputChars += (change.oldText?.length ?? 0) + change.newText.length;
    if (inputChars > BACKGROUND_DIFF_INPUT_CHARS) return true;
  }
  return false;
}

export class ToolDiffProjectionCache {
  private readonly background = new DiffProjectionWorker();
  private readonly byToolCall = new Map<
    string,
    {
      readonly changes: readonly ToolFileChange[];
      readonly state: ToolDiffProjectionState;
    }
  >();

  constructor(
    private readonly onReady: (toolCallId: string) => void = () => {},
  ) {}

  project(
    toolCallId: string,
    changes: readonly ToolFileChange[],
  ): ToolDiffProjectionState {
    const cached = this.byToolCall.get(toolCallId);
    if (cached !== undefined && sameToolFileChanges(cached.changes, changes)) {
      return cached.state;
    }
    if (!shouldProjectInBackground(changes)) {
      const state = {
        status: "ready",
        projection: projectToolChanges(changes),
      } as const;
      this.byToolCall.set(toolCallId, { changes, state });
      return state;
    }
    const state = { status: "pending" } as const;
    const pending = { changes, state };
    this.byToolCall.set(toolCallId, pending);
    void this.background.project(changes).then(
      (projection) => {
        if (this.byToolCall.get(toolCallId) !== pending) return;
        this.byToolCall.set(toolCallId, {
          changes,
          state: { status: "ready", projection },
        });
        this.onReady(toolCallId);
      },
      () => {
        if (this.byToolCall.get(toolCallId) !== pending) return;
        this.byToolCall.set(toolCallId, {
          changes,
          state: { status: "error" },
        });
        this.onReady(toolCallId);
      },
    );
    return state;
  }

  clear(): void {
    this.byToolCall.clear();
    this.background.dispose();
  }
}

function summarizeUnifiedDiff(diff: string): {
  readonly stats: DiffStats;
  readonly rows: number;
} {
  let files = 0;
  let added = 0;
  let removed = 0;
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++ ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { stats: { files, added, removed }, rows: lines.length };
}

export function unifiedDiffStats(diff: string): DiffStats {
  return summarizeUnifiedDiff(diff).stats;
}

const FILETYPES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  md: "markdown",
  markdown: "markdown",
  zig: "zig",
};

export function filetypeFor(path: string): string | undefined {
  const extension = path.split(".").pop();
  return extension === undefined
    ? undefined
    : FILETYPES[extension.toLowerCase()];
}
