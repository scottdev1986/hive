import type { ToolFileChange } from "../../adapters/providers/protocol/types";
import { projectToolChanges, type ToolDiffProjection } from "./unified-diff";
import { errorMessage } from "../../shared/error-message";

interface DiffWorkerRequest {
  readonly id: number;
  readonly changes: readonly ToolFileChange[];
}

interface DiffWorkerResponse {
  readonly id: number;
  readonly projection?: ToolDiffProjection;
  readonly error?: string;
}

self.onmessage = (event: MessageEvent<DiffWorkerRequest>) => {
  const response: DiffWorkerResponse = (() => {
    try {
      return {
        id: event.data.id,
        projection: projectToolChanges(event.data.changes),
      };
    } catch (error) {
      return {
        id: event.data.id,
        error: errorMessage(error),
      };
    }
  })();
  self.postMessage(response);
};
