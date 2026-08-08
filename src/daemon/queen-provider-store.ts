import { z } from "zod";
import type { DatabaseHost } from "../shared/database-host";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "../schemas/capability";
import {
  QueenProviderChangeSchema,
  type QueenProviderReceipt,
} from "../schemas/queen-provider";
import { systemClock } from "../shared/clock";

const CONTROL_META_KEY = "queen-provider-control";

const ControlStateSchema = z.strictObject({
  version: z.literal(1),
  // The revision and the change state are handed to clients and compared against what they send back, so both are the wire's own: a value this store accepted but the wire rejects could never be echoed to a client.
  revision: QueenProviderChangeSchema.shape.revision,
  state: QueenProviderChangeSchema.shape.state,
  desired: CapabilityProviderSchema.nullable(),
  prior: CapabilityProviderSchema.nullable(),
  operationId: z.string().nullable(),
  failure: z.string().nullable(),
  updatedAt: z.string(),
});

export type QueenProviderControlState = z.infer<typeof ControlStateSchema>;

const INITIAL_STATE: QueenProviderControlState = {
  version: 1,
  revision: "0",
  state: "idle",
  desired: null,
  prior: null,
  operationId: null,
  failure: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export class QueenProviderConflictError extends Error {
  constructor(readonly currentRevision: string) {
    super(
      `revision conflict: queen provider control is at revision ${currentRevision}`,
    );
    this.name = "QueenProviderConflictError";
  }
}

/** Persistence for the daemon's Queen-provider compare-and-set record. */
export class QueenProviderControlStore {
  constructor(
    private readonly db: Pick<DatabaseHost, "database">,
    private readonly now: () => Date = systemClock,
  ) {}

  read(): QueenProviderControlState {
    const row = this.db.database
      .query("SELECT value FROM meta WHERE key = ?")
      .get(CONTROL_META_KEY) as { value: string } | null;
    if (row === null) return INITIAL_STATE;
    return ControlStateSchema.parse(JSON.parse(row.value));
  }

  private write(state: QueenProviderControlState): void {
    this.db.database
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(CONTROL_META_KEY, JSON.stringify(ControlStateSchema.parse(state)));
  }

  accept(
    provider: CapabilityProvider,
    expectedRevision: string,
    observedLiveProvider: CapabilityProvider | null,
  ): QueenProviderReceipt {
    const current = this.read();
    if (expectedRevision !== current.revision) {
      throw new QueenProviderConflictError(current.revision);
    }
    const operationId = `qpo_${Bun.randomUUIDv7()}`;
    const revision = String(BigInt(current.revision) + 1n);
    this.write({
      version: 1,
      revision,
      state: "pending",
      desired: provider,
      prior: observedLiveProvider ?? current.prior,
      operationId,
      failure: null,
      updatedAt: this.now().toISOString(),
    });
    return { operationId, revision };
  }

  reconcileObserved(observed: CapabilityProvider | null): void {
    const current = this.read();
    if (current.state !== "pending" || observed !== current.desired) return;
    this.write({
      ...current,
      state: "idle",
      desired: null,
      prior: observed,
      failure: null,
      updatedAt: this.now().toISOString(),
    });
  }

  reportLaunchFailure(provider: CapabilityProvider, detail: string): void {
    const current = this.read();
    if (current.state === "pending" && provider === current.desired) {
      this.write({
        ...current,
        state: "failed",
        desired: null,
        failure: detail,
        updatedAt: this.now().toISOString(),
      });
      return;
    }
    if (current.state === "failed" && provider === current.prior) {
      this.write({
        ...current,
        failure: `${current.failure ?? "change failed"}; preserving ${provider} also failed: ${detail}`,
        updatedAt: this.now().toISOString(),
      });
    }
  }

  launchTool(): CapabilityProvider | null {
    const current = this.read();
    return current.state === "pending" ? current.desired : current.prior;
  }
}
