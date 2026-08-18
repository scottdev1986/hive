import { z } from "zod";
import {
  DecimalUint64Schema,
  domainUuidV7Schema,
  Rfc3339UtcMillisecondsSchema,
  SafeUintSchema,
  TaggedSha256Schema,
} from "./primitives";

export { domainUuidV7Schema, SafeUintSchema };

export const RunIdSchema = domainUuidV7Schema("run");
export type RunId = z.infer<typeof RunIdSchema>;

export const TaskIdSchema = domainUuidV7Schema("task");
export type TaskId = z.infer<typeof TaskIdSchema>;

export const ArtifactRefIdSchema = domainUuidV7Schema("art");

export const RevisionSchema = DecimalUint64Schema;
export type Revision = z.infer<typeof RevisionSchema>;

// Every revisioned record binds a content digest so later records name exact bytes, never a floating "latest" pointer.
export const DigestSchema = TaggedSha256Schema;
export type Digest = z.infer<typeof DigestSchema>;

export const CreatedAtSchema = Rfc3339UtcMillisecondsSchema;

export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export type GitSha = z.infer<typeof GitShaSchema>;

// The revision-binding primitive: names one exact revision by its digest so what a Run points at can never be re-described in free-form prose.
export const RevisionRefSchema = z.strictObject({
  revision: RevisionSchema,
  digest: DigestSchema,
});
export type RevisionRef = z.infer<typeof RevisionRefSchema>;
