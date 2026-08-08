import type {
  MemoryFact,
  MemoryScope,
  MemoryVerificationStatus,
  MemoryWriteInput,
} from "../schemas/memory";
export type MemoryWriteFileInput = MemoryWriteInput;

export type MemoryWriteFileResult = MemoryFact & {
  rawPath: string;
  supersededIds: string[];
};

export interface MemoryMigrationReport {
  scanned: number;
  migrated: number;
  flagged: Array<{
    scope: MemoryScope;
    id: string;
    status: MemoryVerificationStatus;
  }>;
  backups: Array<{ scope: MemoryScope; path: string }>;
  alreadyMigrated: MemoryScope[];
}

export interface BuildMemoryIndexOptions {
  brief?: string;
}
