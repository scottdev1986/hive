import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { getDatabasePath } from "../../hive-home/home";
import {
  ensureMailSchema,
  type LegacyMailMigration,
  migrateLegacyMessagesToMail,
} from "../../mail-service/store";
import type { DatabaseHost } from "../../shared/database-host";
import { AccessStore } from "./access-store";
import { AgentStore } from "./agent-store";
import { EventStore } from "./event-store";
import { HistoryStore } from "./history-store";
import {
  establishDatabaseIdentity,
  HiveDatabaseIdentityError,
  readDatabaseIdentityMarker,
  verifyDatabaseIdentity,
} from "./identity";
import { RuntimeStore } from "./runtime-store";
import { installHiveSchema } from "./schema";

export class HiveDatabase implements DatabaseHost {
  readonly path: string;
  readonly database: Database;
  readonly runtime: RuntimeStore;
  readonly agents: AgentStore;
  readonly events: EventStore;
  readonly access: AccessStore;
  readonly history: HistoryStore;
  readonly legacyMailMigration: LegacyMailMigration | null;

  bindTerminalHostSession!: RuntimeStore["bindTerminalHostSession"];
  releaseUncreatedTerminalHostSession!: RuntimeStore["releaseUncreatedTerminalHostSession"];
  completeTerminalHostSession!: RuntimeStore["completeTerminalHostSession"];
  renewTerminalHostVisibility!: RuntimeStore["renewTerminalHostVisibility"];
  recordTerminalHostTermination!: RuntimeStore["recordTerminalHostTermination"];
  recordTerminalHostTerminationEvidence!: RuntimeStore["recordTerminalHostTerminationEvidence"];
  getTerminalHostBindingByLocator!: RuntimeStore["getTerminalHostBindingByLocator"];
  listTerminalHostBindings!: RuntimeStore["listTerminalHostBindings"];
  insertProviderRun!: RuntimeStore["insertProviderRun"];
  getProviderRun!: RuntimeStore["getProviderRun"];
  getActiveProviderRunByTerminal!: RuntimeStore["getActiveProviderRunByTerminal"];
  listProviderRunsForAgent!: RuntimeStore["listProviderRunsForAgent"];
  getActiveProviderRunForAgent!: RuntimeStore["getActiveProviderRunForAgent"];
  getActiveRootProviderRun!: RuntimeStore["getActiveRootProviderRun"];
  bindProviderRunConversation!: RuntimeStore["bindProviderRunConversation"];
  bindProviderRunAdapterChild!: RuntimeStore["bindProviderRunAdapterChild"];
  recordProviderRunProtocolReceipt!: RuntimeStore["recordProviderRunProtocolReceipt"];
  insertProviderEvent!: RuntimeStore["insertProviderEvent"];
  listProviderEvents!: RuntimeStore["listProviderEvents"];
  recordRunOutcome!: RuntimeStore["recordRunOutcome"];
  getRunOutcome!: RuntimeStore["getRunOutcome"];
  listRunOutcomes!: RuntimeStore["listRunOutcomes"];
  recordIncidentExposure!: RuntimeStore["recordIncidentExposure"];
  listIncidentExposures!: RuntimeStore["listIncidentExposures"];
  insertHandoff!: RuntimeStore["insertHandoff"];
  getHandoff!: RuntimeStore["getHandoff"];
  getHandoffForSourceRun!: RuntimeStore["getHandoffForSourceRun"];
  acknowledgeHandoffPickup!: RuntimeStore["acknowledgeHandoffPickup"];
  endProviderRun!: RuntimeStore["endProviderRun"];

  upsertAgent!: AgentStore["upsertAgent"];
  insertAgent!: AgentStore["insertAgent"];
  discardSpawn!: AgentStore["discardSpawn"];
  markAgentDead!: AgentStore["markAgentDead"];
  getAgentById!: AgentStore["getAgentById"];
  getAgentByName!: AgentStore["getAgentByName"];
  getLiveAgentByName!: AgentStore["getLiveAgentByName"];
  listAgents!: AgentStore["listAgents"];
  reserveAgentName!: AgentStore["reserveAgentName"];
  isAgentNameReserved!: AgentStore["isAgentNameReserved"];
  releaseAgentName!: AgentStore["releaseAgentName"];
  clearAgentNameReservations!: AgentStore["clearAgentNameReservations"];
  revokeAgentCapabilities!: AgentStore["revokeAgentCapabilities"];

  latestSafePointAt!: EventStore["latestSafePointAt"];
  latestTurnBoundaryAt!: EventStore["latestTurnBoundaryAt"];
  latestTurnBoundary!: EventStore["latestTurnBoundary"];
  recentOrchestratorSignals!: EventStore["recentOrchestratorSignals"];
  latestEventAt!: EventStore["latestEventAt"];
  insertEvent!: EventStore["insertEvent"];
  listEvents!: EventStore["listEvents"];

  insertCapability!: AccessStore["insertCapability"];
  getCapability!: AccessStore["getCapability"];
  consumeOneShot!: AccessStore["consumeOneShot"];
  releaseOneShot!: AccessStore["releaseOneShot"];
  releaseOneShotForSubject!: AccessStore["releaseOneShotForSubject"];
  isOneShotConsumed!: AccessStore["isOneShotConsumed"];
  revokeCapabilitiesForSubject!: AccessStore["revokeCapabilitiesForSubject"];
  insertAuditEntry!: AccessStore["insertAuditEntry"];
  countAuditEntries!: AccessStore["countAuditEntries"];
  insertApproval!: AccessStore["insertApproval"];
  getApproval!: AccessStore["getApproval"];
  listApprovals!: AccessStore["listApprovals"];
  insertEscalation!: AccessStore["insertEscalation"];
  listEscalations!: AccessStore["listEscalations"];
  countEscalationsForAgent!: AccessStore["countEscalationsForAgent"];
  resolveApproval!: AccessStore["resolveApproval"];
  staleApproval!: AccessStore["staleApproval"];
  stalePendingToolApprovals!: AccessStore["stalePendingToolApprovals"];

  pruneHistory!: HistoryStore["pruneHistory"];

  static openReadonly(path = getDatabasePath()): HiveDatabase {
    return new HiveDatabase(path, { readonly: true });
  }

  constructor(
    path = getDatabasePath(),
    options: {
      readonly?: boolean;
    } = {},
  ) {
    this.path = path;
    const persistent = path === getDatabasePath();
    const expectedIdentity = persistent ? readDatabaseIdentityMarker() : null;
    if (expectedIdentity !== null && !existsSync(path)) {
      throw new HiveDatabaseIdentityError(
        `Hive's database is missing at ${path}, but its identity marker still exists; ` +
          "refusing to create an empty replacement and silently discard policy, quota, or agent state. " +
          "Restore hive.db from backup or explicitly uninstall/reset Hive before starting again.",
      );
    }
    if (options.readonly === true && !existsSync(path)) {
      throw new HiveDatabaseIdentityError(
        `Hive's database has not been initialized at ${path}. ` +
          "A read-only command will not create or seed it; start the Hive daemon first.",
      );
    }
    if (options.readonly !== true && path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database =
      options.readonly === true
        ? new Database(path, { readonly: true })
        : new Database(path, { create: true });
    this.runtime = new RuntimeStore(this);
    this.agents = new AgentStore(this, this.runtime);
    this.events = new EventStore(this);
    this.access = new AccessStore(this);
    this.history = new HistoryStore(this);
    this.bindCompatibilityApi();

    this.database.exec("PRAGMA busy_timeout = 5000");
    if (expectedIdentity !== null) {
      try {
        verifyDatabaseIdentity(this.database, path, expectedIdentity);
      } catch (error) {
        this.database.close();
        throw error;
      }
    }
    if (options.readonly === true) {
      this.legacyMailMigration = null;
      return;
    }

    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    const recoveredAt = installHiveSchema(this);
    ensureMailSchema(this);
    this.legacyMailMigration = migrateLegacyMessagesToMail(this, recoveredAt);
    if (persistent && expectedIdentity === null) {
      try {
        establishDatabaseIdentity(this.database);
      } catch (error) {
        this.database.close();
        throw error;
      }
    }
  }

  private bindCompatibilityApi(): void {
    this.bindTerminalHostSession = this.runtime.bindTerminalHostSession.bind(
      this.runtime,
    );
    this.releaseUncreatedTerminalHostSession =
      this.runtime.releaseUncreatedTerminalHostSession.bind(this.runtime);
    this.completeTerminalHostSession =
      this.runtime.completeTerminalHostSession.bind(this.runtime);
    this.renewTerminalHostVisibility =
      this.runtime.renewTerminalHostVisibility.bind(this.runtime);
    this.recordTerminalHostTermination =
      this.runtime.recordTerminalHostTermination.bind(this.runtime);
    this.recordTerminalHostTerminationEvidence =
      this.runtime.recordTerminalHostTerminationEvidence.bind(this.runtime);
    this.getTerminalHostBindingByLocator =
      this.runtime.getTerminalHostBindingByLocator.bind(this.runtime);
    this.listTerminalHostBindings = this.runtime.listTerminalHostBindings.bind(
      this.runtime,
    );
    this.insertProviderRun = this.runtime.insertProviderRun.bind(this.runtime);
    this.getProviderRun = this.runtime.getProviderRun.bind(this.runtime);
    this.getActiveProviderRunByTerminal =
      this.runtime.getActiveProviderRunByTerminal.bind(this.runtime);
    this.listProviderRunsForAgent = this.runtime.listProviderRunsForAgent.bind(
      this.runtime,
    );
    this.getActiveProviderRunForAgent =
      this.runtime.getActiveProviderRunForAgent.bind(this.runtime);
    this.getActiveRootProviderRun = this.runtime.getActiveRootProviderRun.bind(
      this.runtime,
    );
    this.bindProviderRunConversation =
      this.runtime.bindProviderRunConversation.bind(this.runtime);
    this.bindProviderRunAdapterChild =
      this.runtime.bindProviderRunAdapterChild.bind(this.runtime);
    this.recordProviderRunProtocolReceipt =
      this.runtime.recordProviderRunProtocolReceipt.bind(this.runtime);
    this.insertProviderEvent = this.runtime.insertProviderEvent.bind(
      this.runtime,
    );
    this.listProviderEvents = this.runtime.listProviderEvents.bind(
      this.runtime,
    );
    this.recordRunOutcome = this.runtime.recordRunOutcome.bind(this.runtime);
    this.getRunOutcome = this.runtime.getRunOutcome.bind(this.runtime);
    this.listRunOutcomes = this.runtime.listRunOutcomes.bind(this.runtime);
    this.recordIncidentExposure = this.runtime.recordIncidentExposure.bind(
      this.runtime,
    );
    this.listIncidentExposures = this.runtime.listIncidentExposures.bind(
      this.runtime,
    );
    this.insertHandoff = this.runtime.insertHandoff.bind(this.runtime);
    this.getHandoff = this.runtime.getHandoff.bind(this.runtime);
    this.getHandoffForSourceRun = this.runtime.getHandoffForSourceRun.bind(
      this.runtime,
    );
    this.acknowledgeHandoffPickup = this.runtime.acknowledgeHandoffPickup.bind(
      this.runtime,
    );
    this.endProviderRun = this.runtime.endProviderRun.bind(this.runtime);

    this.upsertAgent = this.agents.upsertAgent.bind(this.agents);
    this.insertAgent = this.agents.insertAgent.bind(this.agents);
    this.discardSpawn = this.agents.discardSpawn.bind(this.agents);
    this.markAgentDead = this.agents.markAgentDead.bind(this.agents);
    this.getAgentById = this.agents.getAgentById.bind(this.agents);
    this.getAgentByName = this.agents.getAgentByName.bind(this.agents);
    this.getLiveAgentByName = this.agents.getLiveAgentByName.bind(this.agents);
    this.listAgents = this.agents.listAgents.bind(this.agents);
    this.reserveAgentName = this.agents.reserveAgentName.bind(this.agents);
    this.isAgentNameReserved = this.agents.isAgentNameReserved.bind(
      this.agents,
    );
    this.releaseAgentName = this.agents.releaseAgentName.bind(this.agents);
    this.clearAgentNameReservations =
      this.agents.clearAgentNameReservations.bind(this.agents);
    this.revokeAgentCapabilities = this.agents.revokeAgentCapabilities.bind(
      this.agents,
    );

    this.latestSafePointAt = this.events.latestSafePointAt.bind(this.events);
    this.latestTurnBoundaryAt = this.events.latestTurnBoundaryAt.bind(
      this.events,
    );
    this.latestTurnBoundary = this.events.latestTurnBoundary.bind(this.events);
    this.recentOrchestratorSignals = this.events.recentOrchestratorSignals.bind(
      this.events,
    );
    this.latestEventAt = this.events.latestEventAt.bind(this.events);
    this.insertEvent = this.events.insertEvent.bind(this.events);
    this.listEvents = this.events.listEvents.bind(this.events);

    this.insertCapability = this.access.insertCapability.bind(this.access);
    this.getCapability = this.access.getCapability.bind(this.access);
    this.consumeOneShot = this.access.consumeOneShot.bind(this.access);
    this.releaseOneShot = this.access.releaseOneShot.bind(this.access);
    this.releaseOneShotForSubject = this.access.releaseOneShotForSubject.bind(
      this.access,
    );
    this.isOneShotConsumed = this.access.isOneShotConsumed.bind(this.access);
    this.revokeCapabilitiesForSubject =
      this.access.revokeCapabilitiesForSubject.bind(this.access);
    this.insertAuditEntry = this.access.insertAuditEntry.bind(this.access);
    this.countAuditEntries = this.access.countAuditEntries.bind(this.access);
    this.insertApproval = this.access.insertApproval.bind(this.access);
    this.getApproval = this.access.getApproval.bind(this.access);
    this.listApprovals = this.access.listApprovals.bind(this.access);
    this.insertEscalation = this.access.insertEscalation.bind(this.access);
    this.listEscalations = this.access.listEscalations.bind(this.access);
    this.countEscalationsForAgent = this.access.countEscalationsForAgent.bind(
      this.access,
    );
    this.resolveApproval = this.access.resolveApproval.bind(this.access);
    this.staleApproval = this.access.staleApproval.bind(this.access);
    this.stalePendingToolApprovals = this.access.stalePendingToolApprovals.bind(
      this.access,
    );

    this.pruneHistory = this.history.pruneHistory.bind(this.history);
  }

  quickCheck(): string[] {
    return z
      .array(z.object({ quick_check: z.string() }))
      .parse(this.database.query("PRAGMA quick_check").all())
      .map((row) => row.quick_check);
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
}
