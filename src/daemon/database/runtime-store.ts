import { z } from "zod";
import type { DatabaseHost } from "../../shared/database-host";
import {
  type HandoffBundle,
  HandoffBundleSchema,
  type HandoffPickup,
  HandoffPickupSchema,
} from "../../schemas/handoff-schema";
import {
  type ProviderEvent,
  ProviderEventSchema,
} from "../../schemas/provider-communication";
import {
  type IncidentExposure,
  IncidentExposureSchema,
} from "../../schemas/incident-exposure";
import { type RunOutcome, RunOutcomeSchema } from "../../schemas/run-outcome";
import {
  type AdapterChildIdentity,
  migrateStoredProviderRun,
  type ProviderProtocolReceipt,
  type ProviderRun,
  ProviderRunBindingSchema,
  ProviderRunSchema,
} from "../../schemas/provider-run";
import { VisibilityLeaseSchema } from "../../schemas/session-protocol";
import {
  type HiveTerminalBinding,
  HiveTerminalBindingSchema,
  type HiveTerminalCreateEvidence,
  HiveTerminalCreateEvidenceSchema,
  type HiveTerminalTerminationAudit,
  HiveTerminalTerminationAuditSchema,
  type HiveTerminalTerminationEvidence,
  HiveTerminalTerminationEvidenceSchema,
  TerminalHostBindingConflictError,
} from "../session-host/terminal-host-binding";

const StoredTerminalHostBindingRowSchema = z.object({
  locatorJson: z.string().min(1),
  visibilityJson: z.string().min(1),
  createEvidenceJson: z.string().nullable(),
  terminationAuditJson: z.string().nullable(),
  terminationEvidenceJson: z.string().nullable(),
});

const StoredProviderRunRowSchema = z.object({
  recordJson: z.string().min(1),
});

const StoredProviderEventRowSchema = z.object({
  recordJson: z.string().min(1),
});

const StoredRunOutcomeRowSchema = z.object({
  recordJson: z.string().min(1),
});

const StoredIncidentExposureRowSchema = z.object({
  recordJson: z.string().min(1),
});

const StoredHandoffRowSchema = z.object({
  recordJson: z.string().min(1),
  replacementAgentId: z.string().nullable(),
  pickedUpAt: z.string().nullable(),
});

function parseProviderRunRow(row: unknown): ProviderRun {
  return ProviderRunSchema.parse(
    migrateStoredProviderRun(
      JSON.parse(StoredProviderRunRowSchema.parse(row).recordJson),
    ),
  );
}

function parseProviderEventRow(row: unknown): ProviderEvent {
  return ProviderEventSchema.parse(
    JSON.parse(StoredProviderEventRowSchema.parse(row).recordJson),
  );
}

function parseRunOutcomeRow(row: unknown): RunOutcome {
  return RunOutcomeSchema.parse(
    JSON.parse(StoredRunOutcomeRowSchema.parse(row).recordJson),
  );
}

function parseIncidentExposureRow(row: unknown): IncidentExposure {
  return IncidentExposureSchema.parse(
    JSON.parse(StoredIncidentExposureRowSchema.parse(row).recordJson),
  );
}

function parseHandoffRow(row: unknown): {
  bundle: HandoffBundle;
  pickup: HandoffPickup | null;
} {
  const stored = StoredHandoffRowSchema.parse(row);
  const bundle = HandoffBundleSchema.parse(JSON.parse(stored.recordJson));
  return {
    bundle,
    pickup:
      stored.replacementAgentId === null || stored.pickedUpAt === null
        ? null
        : HandoffPickupSchema.parse({
            handoffId: bundle.handoffId,
            replacementAgentId: stored.replacementAgentId,
            pickedUpAt: stored.pickedUpAt,
          }),
  };
}

function parseTerminalHostBindingRow(row: unknown): HiveTerminalBinding {
  const stored = StoredTerminalHostBindingRowSchema.parse(row);
  return HiveTerminalBindingSchema.parse({
    locator: JSON.parse(stored.locatorJson),
    visibility: JSON.parse(stored.visibilityJson),
    ...(stored.createEvidenceJson === null
      ? {}
      : { createEvidence: JSON.parse(stored.createEvidenceJson) }),
    ...(stored.terminationAuditJson === null
      ? {}
      : { terminationAudit: JSON.parse(stored.terminationAuditJson) }),
    ...(stored.terminationEvidenceJson === null
      ? {}
      : { terminationEvidence: JSON.parse(stored.terminationEvidenceJson) }),
  });
}

export class RuntimeStore {
  constructor(private readonly host: DatabaseHost) {}

  private get database() {
    return this.host.database;
  }

  private transaction<T>(operation: () => T): T {
    return this.host.transaction(operation);
  }

  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding {
    const value = HiveTerminalBindingSchema.parse(binding);
    const locatorJson = JSON.stringify(value.locator);
    const visibilityJson = JSON.stringify(value.visibility);
    return this.transaction(() => {
      const byLocator = this.getTerminalHostBindingByLocator(value.locator);
      if (byLocator !== null) {
        if (
          JSON.stringify(byLocator.locator) === JSON.stringify(value.locator) &&
          JSON.stringify(byLocator.visibility) ===
            JSON.stringify(value.visibility)
        )
          return byLocator;
        throw new TerminalHostBindingConflictError();
      }
      this.database
        .query(`
        INSERT INTO terminal_host_bindings (
          locatorInstanceId, locatorSessionId, locatorGeneration,
          locatorJson, visibilityJson
        ) VALUES (?, ?, ?, ?, ?)
      `)
        .run(
          value.locator.instanceId,
          value.locator.sessionId,
          value.locator.generation,
          locatorJson,
          visibilityJson,
        );
      return value;
    });
  }

  releaseUncreatedTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
  ): boolean {
    const value =
      HiveTerminalBindingSchema.unwrap().shape.locator.parse(locator);
    return (
      this.database
        .query(`
      DELETE FROM terminal_host_bindings
      WHERE locatorInstanceId = ? AND locatorSessionId = ? AND locatorGeneration = ?
        AND createEvidenceJson IS NULL AND terminationAuditJson IS NULL
        AND terminationEvidenceJson IS NULL
    `)
        .run(value.instanceId, value.sessionId, value.generation).changes > 0
    );
  }

  completeTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
    evidence: HiveTerminalCreateEvidence,
  ): HiveTerminalBinding {
    const value = HiveTerminalCreateEvidenceSchema.parse(evidence);
    return this.transaction(() => {
      const binding = this.getTerminalHostBindingByLocator(locator);
      if (binding === null) {
        throw new Error("terminal host locator binding does not exist");
      }
      if (binding.createEvidence !== undefined) {
        if (JSON.stringify(binding.createEvidence) === JSON.stringify(value)) {
          return binding;
        }
        throw new TerminalHostBindingConflictError();
      }
      this.database
        .query(`
        UPDATE terminal_host_bindings
        SET createEvidenceJson = ?
        WHERE locatorInstanceId = ? AND locatorSessionId = ? AND locatorGeneration = ?
      `)
        .run(
          JSON.stringify(value),
          binding.locator.instanceId,
          binding.locator.sessionId,
          binding.locator.generation,
        );
      return { ...binding, createEvidence: value };
    });
  }

  renewTerminalHostVisibility(
    locator: HiveTerminalBinding["locator"],
    request: HiveTerminalBinding["visibility"],
    lease: z.infer<typeof VisibilityLeaseSchema>,
  ): HiveTerminalBinding {
    const nextVisibility =
      HiveTerminalBindingSchema.unwrap().shape.visibility.parse(request);
    const parsedLease = VisibilityLeaseSchema.parse(lease);
    const nextLease =
      HiveTerminalCreateEvidenceSchema.unwrap().shape.visibility.parse({
        state: "visible",
        workspaceSessionId: nextVisibility.workspaceSessionId,
        openTerminalRevision: parsedLease.openTerminalRevision,
        expiresAt: parsedLease.expiresAt,
      });
    const expectedLocator =
      HiveTerminalBindingSchema.unwrap().shape.locator.parse(
        parsedLease.locator,
      );
    return this.transaction(() => {
      const binding = this.getTerminalHostBindingByLocator(locator);
      if (binding === null) {
        throw new Error("terminal host locator binding does not exist");
      }
      if (
        binding.createEvidence === undefined ||
        JSON.stringify(expectedLocator) !== JSON.stringify(binding.locator) ||
        nextLease.workspaceSessionId !== nextVisibility.workspaceSessionId ||
        nextLease.openTerminalRevision !== nextVisibility.openTerminalRevision
      ) {
        throw new TerminalHostBindingConflictError();
      }
      const createEvidence = {
        ...binding.createEvidence,
        visibility: nextLease,
      };
      this.database
        .query(`
        UPDATE terminal_host_bindings
        SET visibilityJson = ?, createEvidenceJson = ?
        WHERE locatorInstanceId = ? AND locatorSessionId = ? AND locatorGeneration = ?
      `)
        .run(
          JSON.stringify(nextVisibility),
          JSON.stringify(createEvidence),
          binding.locator.instanceId,
          binding.locator.sessionId,
          binding.locator.generation,
        );
      return { ...binding, visibility: nextVisibility, createEvidence };
    });
  }

  recordTerminalHostTermination(
    locator: HiveTerminalBinding["locator"],
    audit: HiveTerminalTerminationAudit,
  ): HiveTerminalBinding {
    const value = HiveTerminalTerminationAuditSchema.parse(audit);
    return this.transaction(() => {
      const binding = this.getTerminalHostBindingByLocator(locator);
      if (binding === null) {
        throw new Error("terminal host locator binding does not exist");
      }
      this.database
        .query(`
        UPDATE terminal_host_bindings
        SET terminationAuditJson = ?
        WHERE locatorInstanceId = ? AND locatorSessionId = ? AND locatorGeneration = ?
      `)
        .run(
          JSON.stringify(value),
          binding.locator.instanceId,
          binding.locator.sessionId,
          binding.locator.generation,
        );
      return { ...binding, terminationAudit: value };
    });
  }

  recordTerminalHostTerminationEvidence(
    locator: HiveTerminalBinding["locator"],
    evidence: HiveTerminalTerminationEvidence,
  ): HiveTerminalBinding {
    const value = HiveTerminalTerminationEvidenceSchema.parse(evidence);
    return this.transaction(() => {
      const binding = this.getTerminalHostBindingByLocator(locator);
      if (binding === null) {
        throw new Error("terminal host locator binding does not exist");
      }
      this.database
        .query(`
        UPDATE terminal_host_bindings
        SET terminationEvidenceJson = ?
        WHERE locatorInstanceId = ? AND locatorSessionId = ? AND locatorGeneration = ?
      `)
        .run(
          JSON.stringify(value),
          binding.locator.instanceId,
          binding.locator.sessionId,
          binding.locator.generation,
        );
      return { ...binding, terminationEvidence: value };
    });
  }

  getTerminalHostBindingByLocator(
    locator: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding | null {
    const value =
      HiveTerminalBindingSchema.unwrap().shape.locator.parse(locator);
    const row = this.database
      .query(`
      SELECT locatorJson, visibilityJson, createEvidenceJson, terminationAuditJson,
             terminationEvidenceJson
      FROM terminal_host_bindings
      WHERE locatorInstanceId = ? AND locatorSessionId = ? AND locatorGeneration = ?
    `)
      .get(value.instanceId, value.sessionId, value.generation);
    return row === null ? null : parseTerminalHostBindingRow(row);
  }

  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[] {
    const value = z.string().min(1).parse(instanceId);
    return this.database
      .query(`
      SELECT locatorJson, visibilityJson, createEvidenceJson, terminationAuditJson,
             terminationEvidenceJson
      FROM terminal_host_bindings
      WHERE locatorInstanceId = ?
      ORDER BY locatorSessionId, locatorGeneration
    `)
      .all(value)
      .map(parseTerminalHostBindingRow);
  }

  insertProviderRun(run: ProviderRun): ProviderRun {
    const value = ProviderRunSchema.parse(run);
    this.database
      .query(`
      INSERT INTO provider_runs (
        runId, agentId, terminalInstanceId, terminalSessionId,
        terminalGeneration, state, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        value.runId,
        value.agentId,
        value.terminal.instanceId,
        value.terminal.sessionId,
        value.terminal.generation,
        value.state,
        JSON.stringify(value),
      );
    return value;
  }

  getProviderRun(runId: string): ProviderRun | null {
    const row = this.database
      .query("SELECT recordJson FROM provider_runs WHERE runId = ?")
      .get(z.string().uuid().parse(runId));
    return row === null ? null : parseProviderRunRow(row);
  }

  getActiveProviderRunByTerminal(
    terminal: ProviderRun["terminal"],
  ): ProviderRun | null {
    const locator =
      ProviderRunBindingSchema.unwrap().shape.terminal.parse(terminal);
    const row = this.database
      .query(`
      SELECT recordJson FROM provider_runs
      WHERE terminalInstanceId = ?
        AND terminalSessionId = ?
        AND terminalGeneration = ?
        AND state = 'running'
    `)
      .get(locator.instanceId, locator.sessionId, locator.generation);
    return row === null ? null : parseProviderRunRow(row);
  }

  listProviderRunsForAgent(agentId: string): readonly ProviderRun[] {
    return this.database
      .query(`
      SELECT recordJson FROM provider_runs
      WHERE agentId = ?
      ORDER BY rowid
    `)
      .all(z.string().min(1).parse(agentId))
      .map(parseProviderRunRow);
  }

  getActiveProviderRunForAgent(agentId: string): ProviderRun | null {
    const row = this.database
      .query(`
      SELECT recordJson FROM provider_runs
      WHERE agentId = ? AND state = 'running'
      ORDER BY rowid DESC LIMIT 1
    `)
      .get(z.string().min(1).parse(agentId));
    return row === null ? null : parseProviderRunRow(row);
  }

  getActiveRootProviderRun(instanceId: string): ProviderRun | null {
    const locator = this.listTerminalHostBindings(instanceId).reduce<
      ProviderRun["terminal"] | null
    >(
      (latest, binding) =>
        binding.locator.subject.kind === "root" &&
        (latest === null || binding.locator.generation > latest.generation)
          ? binding.locator
          : latest,
      null,
    );
    if (locator === null) return null;
    const run = this.getActiveProviderRunByTerminal(locator);
    return run === null || run.agentId !== null ? null : run;
  }

  bindProviderRunConversation(
    runId: string,
    conversationId: string,
  ): ProviderRun | null {
    return this.transaction(() => {
      const current = this.getProviderRun(runId);
      if (
        current === null ||
        current.state !== "running" ||
        (current.conversationId !== null &&
          current.conversationId !== conversationId)
      ) {
        return null;
      }
      if (current.conversationId === conversationId) return current;
      const bound = ProviderRunSchema.parse({ ...current, conversationId });
      this.database
        .query(`
        UPDATE provider_runs SET recordJson = ?
        WHERE runId = ? AND state = 'running'
      `)
        .run(JSON.stringify(bound), runId);
      return bound;
    });
  }

  bindProviderRunAdapterChild(
    runId: string,
    agentId: string | null,
    capabilityEpoch: number,
    identity: AdapterChildIdentity,
  ): ProviderRun | null {
    return this.transaction(() => {
      const current = this.getProviderRun(runId);
      if (
        current === null ||
        current.state !== "running" ||
        current.agentId !== agentId ||
        current.capabilityEpoch !== capabilityEpoch
      ) {
        return null;
      }
      if (current.adapterChild !== null) {
        return JSON.stringify(current.adapterChild) === JSON.stringify(identity)
          ? current
          : null;
      }
      const bound = ProviderRunSchema.parse({
        ...current,
        adapterChild: identity,
      });
      this.database
        .query(`
        UPDATE provider_runs SET recordJson = ?
        WHERE runId = ? AND state = 'running'
      `)
        .run(JSON.stringify(bound), runId);
      return bound;
    });
  }

  recordProviderRunProtocolReceipt(
    runId: string,
    agentId: string | null,
    capabilityEpoch: number,
    receipt: ProviderProtocolReceipt,
  ): ProviderRun | null {
    return this.transaction(() => {
      const current = this.getProviderRun(runId);
      if (
        current === null ||
        current.state !== "running" ||
        current.agentId !== agentId ||
        current.capabilityEpoch !== capabilityEpoch ||
        current.adapterChild === null
      ) {
        return null;
      }
      if (
        current.protocolReceipt !== null &&
        current.protocolReceipt.clientInputId === receipt.clientInputId
      ) {
        const { reportedAt: _currentAt, ...currentReceipt } =
          current.protocolReceipt;
        const { reportedAt: _reportedAt, ...reportedReceipt } = receipt;
        return JSON.stringify(currentReceipt) ===
          JSON.stringify(reportedReceipt)
          ? current
          : null;
      }
      const updated = ProviderRunSchema.parse({
        ...current,
        protocolReceipt: receipt,
      });
      this.database
        .query(`
        UPDATE provider_runs SET recordJson = ?
        WHERE runId = ? AND state = 'running'
      `)
        .run(JSON.stringify(updated), runId);
      return updated;
    });
  }

  insertProviderEvent(event: ProviderEvent): boolean {
    const value = ProviderEventSchema.parse(event);
    return (
      this.database
        .query(`
        INSERT OR IGNORE INTO provider_events (
          eventId, providerRunId, occurredAt, recordJson
        ) VALUES (?, ?, ?, ?)
      `)
        .run(
          value.eventId,
          value.providerRunId,
          value.occurredAt,
          JSON.stringify(value),
        ).changes === 1
    );
  }

  listProviderEvents(providerRunId: string): readonly ProviderEvent[] {
    return this.database
      .query(`
      SELECT recordJson FROM provider_events
      WHERE providerRunId = ?
      ORDER BY occurredAt, rowid
    `)
      .all(z.string().uuid().parse(providerRunId))
      .map(parseProviderEventRow);
  }

  recordRunOutcome(outcome: RunOutcome): RunOutcome {
    const value = RunOutcomeSchema.parse(outcome);
    this.database
      .query(`
        INSERT OR IGNORE INTO run_outcomes (
          providerRunId, outcome, endedAt, recordJson
        ) VALUES (?, ?, ?, ?)
      `)
      .run(
        value.providerRunId,
        value.outcome,
        value.endedAt,
        JSON.stringify(value),
      );
    return this.getRunOutcome(value.providerRunId) ?? value;
  }

  getRunOutcome(providerRunId: string): RunOutcome | null {
    const row = this.database
      .query("SELECT recordJson FROM run_outcomes WHERE providerRunId = ?")
      .get(z.string().uuid().parse(providerRunId));
    return row === null ? null : parseRunOutcomeRow(row);
  }

  listRunOutcomes(): readonly RunOutcome[] {
    return this.database
      .query("SELECT recordJson FROM run_outcomes ORDER BY endedAt, rowid")
      .all()
      .map(parseRunOutcomeRow);
  }

  recordIncidentExposure(exposure: IncidentExposure): IncidentExposure {
    const value = IncidentExposureSchema.parse(exposure);
    this.database
      .query(`
        INSERT OR IGNORE INTO incident_exposures (
          exposureId, signature, observedAt, outcome, recordJson
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        value.exposureId,
        value.signature,
        value.observedAt,
        value.outcome,
        JSON.stringify(value),
      );
    return value;
  }

  listIncidentExposures(): readonly IncidentExposure[] {
    return this.database
      .query(
        "SELECT recordJson FROM incident_exposures ORDER BY observedAt, rowid",
      )
      .all()
      .map(parseIncidentExposureRow);
  }

  insertHandoff(bundle: HandoffBundle): HandoffBundle {
    const value = HandoffBundleSchema.parse(bundle);
    return this.transaction(() => {
      this.database
        .query(`
          INSERT INTO handoffs (handoffId, sourceRunId, recordJson)
          VALUES (?, ?, ?)
        `)
        .run(value.handoffId, value.sourceRunId, JSON.stringify(value));
      this.recordRunOutcome(value.runOutcome);
      return this.getHandoff(value.handoffId)?.bundle ?? value;
    });
  }

  getHandoff(
    handoffId: string,
  ): { bundle: HandoffBundle; pickup: HandoffPickup | null } | null {
    const row = this.database
      .query(`
        SELECT recordJson, replacementAgentId, pickedUpAt
        FROM handoffs WHERE handoffId = ?
      `)
      .get(z.string().uuid().parse(handoffId));
    return row === null ? null : parseHandoffRow(row);
  }

  getHandoffForSourceRun(
    sourceRunId: string,
  ): { bundle: HandoffBundle; pickup: HandoffPickup | null } | null {
    const row = this.database
      .query(`
        SELECT recordJson, replacementAgentId, pickedUpAt
        FROM handoffs WHERE sourceRunId = ?
      `)
      .get(z.string().uuid().parse(sourceRunId));
    return row === null ? null : parseHandoffRow(row);
  }

  acknowledgeHandoffPickup(
    handoffId: string,
    replacementAgentId: string,
    pickedUpAt: string,
  ): HandoffPickup | null {
    const id = z.string().uuid().parse(handoffId);
    const agentId = z.string().min(1).parse(replacementAgentId);
    const timestamp = z.iso.datetime({ offset: true }).parse(pickedUpAt);
    this.database
      .query(`
        UPDATE handoffs
        SET replacementAgentId = ?, pickedUpAt = ?
        WHERE handoffId = ? AND replacementAgentId IS NULL
      `)
      .run(agentId, timestamp, id);
    const stored = this.getHandoff(id);
    if (
      stored?.pickup === null ||
      stored?.pickup.replacementAgentId !== agentId
    ) {
      return null;
    }
    return stored.pickup;
  }

  endProviderRun(
    runId: string,
    endedAt: string,
    exitReason: string,
  ): ProviderRun | null {
    return this.transaction(() => {
      const current = this.getProviderRun(runId);
      if (current === null) return null;
      if (current.state === "exited") return current;
      const exited = ProviderRunSchema.parse({
        ...current,
        state: "exited",
        endedAt,
        exitReason,
      });
      this.database
        .query(`
        UPDATE provider_runs
        SET state = 'exited', recordJson = ?
        WHERE runId = ? AND state = 'running'
      `)
        .run(JSON.stringify(exited), exited.runId);
      if (exited.agentId !== null && exited.model !== null) {
        const agent = this.database
          .query("SELECT category, status FROM agents WHERE id = ?")
          .get(exited.agentId) as {
          category: RunOutcome["taskCategory"];
          status: string;
        } | null;
        if (agent !== null) {
          this.recordRunOutcome({
            decisionId: exited.launchGrantId,
            providerRunId: exited.runId,
            provider: exited.provider,
            model: exited.model,
            taskCategory: agent.category,
            outcome:
              exitReason === "provider-process-exited"
                ? agent.status === "done"
                  ? "completed"
                  : "crashed"
                : "stopped",
            handoffId: null,
            startedAt: exited.startedAt,
            endedAt,
          });
        }
      }
      return exited;
    });
  }
}
