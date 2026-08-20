import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { databaseIdentityPath } from "../../hive-home/home";

const DATABASE_IDENTITY_META_KEY = "databaseIdentity";

export class HiveDatabaseIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HiveDatabaseIdentityError";
  }
}

export function readDatabaseIdentityMarker(): string | null {
  const markerPath = databaseIdentityPath();
  if (!existsSync(markerPath)) return null;
  let value: string;
  try {
    value = readFileSync(markerPath, "utf8").trim();
  } catch (error) {
    throw new HiveDatabaseIdentityError(
      `Hive cannot read its database identity marker at ${markerPath}: ${String(error)}. ` +
        "Refusing to open or recreate the database until the marker is readable.",
    );
  }
  if (!z.string().uuid().safeParse(value).success) {
    throw new HiveDatabaseIdentityError(
      `Hive's database identity marker at ${markerPath} is invalid. ` +
        "Refusing to open or recreate the database because its persisted state cannot be identified.",
    );
  }
  return value;
}

export function verifyDatabaseIdentity(
  database: Database,
  path: string,
  expectedIdentity: string,
): void {
  const metaExists =
    database
      .query(
        `
        SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'meta'
      `,
      )
      .get() !== null;
  const storedIdentity = metaExists
    ? (z
        .object({ value: z.string() })
        .nullable()
        .parse(
          database
            .query("SELECT value FROM meta WHERE key = ?")
            .get(DATABASE_IDENTITY_META_KEY),
        )?.value ?? null)
    : null;
  if (storedIdentity !== expectedIdentity) {
    throw new HiveDatabaseIdentityError(
      `Hive's database at ${path} does not match its persisted identity marker. ` +
        "Refusing to use a replaced or reset database as fresh state. Restore the matching " +
        "hive.db from backup or explicitly uninstall/reset Hive.",
    );
  }
}

export function establishDatabaseIdentity(database: Database): void {
  const proposed = crypto.randomUUID();
  database
    .query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
    .run(DATABASE_IDENTITY_META_KEY, proposed);
  const identity = z
    .object({ value: z.string().uuid() })
    .parse(
      database
        .query("SELECT value FROM meta WHERE key = ?")
        .get(DATABASE_IDENTITY_META_KEY),
    ).value;
  const markerPath = databaseIdentityPath();
  try {
    mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath, `${identity}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw error;
    }
    if (readDatabaseIdentityMarker() !== identity) {
      throw new HiveDatabaseIdentityError(
        "Hive's database identity changed during startup; refusing to continue.",
      );
    }
  }
}
