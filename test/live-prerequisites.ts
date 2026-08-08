import { existsSync } from "node:fs";
import type {
  NormalizedProviderEvent,
  SubmissionReceipt,
} from "../src/adapters/providers/protocol/types";
import { probeProviderExecutable } from "../src/adapters/providers/shared/provider-executable";

export function requireLiveInput(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required for this live test; provide a dedicated test input explicitly because the test sandbox never inherits your vendor home`,
    );
  }
  return value;
}

export function requireStagedLiveFile(inputName: string, path: string): void {
  requireLiveInput(inputName);
  if (!existsSync(path)) {
    throw new Error(
      `${inputName} could not be staged at ${path}; run this leg through bun run test:live and check that the declared file is readable`,
    );
  }
}

export function requireExecutable(
  vendor: string,
  executable: string | null,
): string {
  if (executable === null) {
    throw new Error(
      `${vendor} is not installed on PATH; test:live requires the real vendor CLI and never treats an absent vendor as a skip`,
    );
  }
  return executable;
}

export function requireVerifiedVersion(
  vendor: string,
  actual: string | null,
  verifiedSeries: string,
): string {
  if (actual === null) {
    throw new Error(`${vendor} did not report an installed version`);
  }
  const prefix = `${verifiedSeries}.`;
  if (!actual.startsWith(prefix)) {
    throw new Error(
      `${vendor} moved outside the verified ${verifiedSeries}.x series to ${actual}; re-verify the live protocol and update the bound`,
    );
  }
  return actual;
}

export function installedCliVersion(executable: string): string | null {
  const output = probeProviderExecutable(executable);
  if (output === null) return null;
  return /(\d+\.\d+\.\d+[^\s)]*)/.exec(output)?.[1] ?? null;
}

export function requireSuccessfulTurn(
  label: string,
  receipt: SubmissionReceipt,
  events: readonly NormalizedProviderEvent[],
): void {
  if (receipt.outcome !== "accepted" || receipt.turnId === null) {
    throw new Error(
      `${label} was ${receipt.outcome}: ${receipt.detail ?? "no detail"}`,
    );
  }
  const terminal = events.find(
    (event) =>
      "turnId" in event &&
      event.turnId === receipt.turnId &&
      (event.kind === "turn-idle" ||
        event.kind === "turn-failed" ||
        event.kind === "interrupted"),
  );
  if (terminal === undefined) {
    throw new Error(`${label} produced no terminal event`);
  }
  if (terminal.kind === "turn-failed") {
    throw new Error(`${label} failed: ${terminal.reason}`);
  }
  if (terminal.kind === "interrupted") {
    throw new Error(`${label} was interrupted`);
  }
}
