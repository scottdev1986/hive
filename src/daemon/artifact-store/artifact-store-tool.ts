// The two MCP doors onto the artifact store. They authenticate, validate, call
// the store, and render what it returns; every rule about where a file lands
// and how long it lives is behind the store boundary, not here.

import { z } from "zod";
import type { Action, Capability } from "../../schemas/authority";
import {
  ArtifactRefIdSchema,
  RunIdSchema,
  TaskIdSchema,
} from "../../schemas/hierarchy-ids";
import { toolResult } from "../../shared/mcp-tool-result";
import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import {
  getArtifact,
  putArtifact,
  type StoredArtifact,
} from "./artifact-store";

/** What hive_artifact_get answers: the artifact, or a typed refusal naming what to do instead. */
export type ArtifactGetResult =
  | ({ kind: "artifact" } & StoredArtifact)
  | { kind: "refusal"; artifactId: string; fix: string };

export interface ArtifactToolDeps {
  /** Resolved lazily: project identity costs a git call, and no artifact path is needed until a call arrives. Where new artifacts are written. */
  artifactsRoot: () => string;
  /** Every root a read may find an artifact under, durable first: the write root plus the pre-move per-instance root. */
  artifactReadRoots: () => readonly string[];
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
}

export function registerArtifactTools(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: ArtifactToolDeps,
): void {
  server.registerTool(
    "hive_artifact_put",
    {
      title: "Store a work product and get its artifact id",
      description:
        "Store a finished work product — an analysis, a review, a report — as a durable file and get back the artifact id that names it. Use this instead of pasting the work into a mail body: a settled mail body cannot be read again, an artifact can. taskOrRunId is the board task (task_...) or run (run_...) the work belongs to. The returned artifactId is exactly what hive_task_update accepts in `evidence`, so store first, then cite the id on the task. Writer and orchestrator roles may store; readers may only read.",
      inputSchema: z.object({
        taskOrRunId: z
          .union([TaskIdSchema, RunIdSchema])
          .describe("The board task or run this work product belongs to."),
        body: z.string().min(1).describe("The work product itself, Markdown."),
        title: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^\r\n]+$/)
          .optional()
          .describe("One line naming the work product."),
      }),
    },
    async ({ taskOrRunId, body, title }) => {
      deps.authorizeTool(capability, "hive_artifact_put", "artifact:write");
      const stored = putArtifact({
        root: deps.artifactsRoot(),
        taskOrRunId,
        title: title ?? null,
        author: capability.subject,
        body,
        now: new Date(),
      });
      return toolResult(stored, "artifact");
    },
  );

  server.registerTool(
    "hive_artifact_get",
    {
      title: "Read a stored work product by its artifact id",
      description:
        "Read back the work product an agent stored under an artifact id, with the body exactly as it was handed in plus who wrote it, when, and which board task or run it belongs to. An id this project has no artifact for returns a typed refusal rather than an empty body. Every role may read.",
      inputSchema: z.object({
        artifactId: ArtifactRefIdSchema.describe(
          "The id hive_artifact_put returned, e.g. art_018f1e90-7b5a-7cc0-8000-000000000001.",
        ),
      }),
    },
    async ({ artifactId }) => {
      deps.authorizeTool(capability, "hive_artifact_get", "artifact:read");
      let stored: StoredArtifact | null = null;
      for (const root of deps.artifactReadRoots()) {
        stored = getArtifact(root, artifactId);
        if (stored !== null) break;
      }
      if (stored === null) {
        const refusal: ArtifactGetResult = {
          kind: "refusal",
          artifactId,
          fix: "Fix: call hive_artifact_get with an artifactId returned by hive_artifact_put on this project, or read the id off the task's evidence with hive_task_list",
        };
        return toolResult(refusal, "artifact");
      }
      const found: ArtifactGetResult = { kind: "artifact", ...stored };
      return toolResult(found, "artifact");
    },
  );
}
