import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ProviderCapabilitySnapshot } from "../adapters/providers/protocol/types";
import {
  CapabilityAbsencesSchema,
  CapabilityDiscoveryResultSchema,
  CapabilityMeasurementsSchema,
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "../schemas/capability";

const CommandSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().nullable(),
  argumentHint: z.string().optional(),
});

export const ProviderCapabilitySnapshotSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  source: z.enum(["probe", "session"]),
  observedAt: z.iso.datetime({ offset: true }),
  catalog: CapabilityDiscoveryResultSchema,
  measurements: CapabilityMeasurementsSchema,
  absences: CapabilityAbsencesSchema.optional(),
  commands: z.array(CommandSchema),
});

export function snapshotValue(
  snapshot: ProviderCapabilitySnapshot,
): ProviderCapabilitySnapshot {
  return ProviderCapabilitySnapshotSchema.parse({
    provider: snapshot.provider,
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    catalog: snapshot.catalog,
    measurements: snapshot.measurements,
    ...(snapshot.absences === undefined ? {} : { absences: snapshot.absences }),
    commands: snapshot.commands,
  });
}

export class CapabilitySnapshotStore {
  constructor(private readonly database: Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS provider_capability_snapshots (
        provider TEXT PRIMARY KEY,
        observedAt TEXT NOT NULL,
        snapshot TEXT NOT NULL
      )
    `);
  }

  read(provider: CapabilityProvider): ProviderCapabilitySnapshot | null {
    const row = this.database
      .query(
        "SELECT snapshot FROM provider_capability_snapshots WHERE provider = ?",
      )
      .get(provider) as { snapshot: string } | null;
    if (row === null) return null;
    return ProviderCapabilitySnapshotSchema.parse(JSON.parse(row.snapshot));
  }

  write(snapshot: ProviderCapabilitySnapshot): void {
    const value = snapshotValue(snapshot);
    if (value.source !== "probe") {
      throw new Error("only runtime probe snapshots are durable");
    }
    this.database
      .query(`
        INSERT INTO provider_capability_snapshots (provider, observedAt, snapshot)
        VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          observedAt = excluded.observedAt,
          snapshot = excluded.snapshot
      `)
      .run(value.provider, value.observedAt, JSON.stringify(value));
  }
}
