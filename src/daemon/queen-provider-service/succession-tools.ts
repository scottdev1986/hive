import type { HiveToolServer } from "../authorization/mcp-tool-policy";
import {
  HiveRunCheckpointGetRequestSchema,
  HiveRunCheckpointRequestSchema,
  SuccessionAttestRequestSchema,
} from "../../schemas/run-checkpoint";
import type {
  Action,
  Capability,
} from "../authorization/authorization-service";
import type { SuccessionService } from "./succession";
import { successionRequiredReadInstruction } from "./succession-recovery";
import { toolResult } from "../../shared/mcp-tool-result";

export interface SuccessionToolDeps {
  succession: SuccessionService;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
}

export function registerSuccessionTools(
  server: HiveToolServer,
  capability: Capability,
  deps: SuccessionToolDeps,
): void {
  server.registerTool(
    "hive_run_checkpoint_get",
    {
      title: "Read a RunCheckpoint",
      description:
        "Read and digest-verify this instance's latest RunCheckpoint, or one exact revision. Absence and digest mismatch are explicit states.",
      inputSchema: HiveRunCheckpointGetRequestSchema,
    },
    async (request) => {
      deps.authorizeTool(capability, "hive_run_checkpoint_get", "status:read");
      return toolResult(
        deps.succession.readCheckpoint(request.revision),
        "checkpoint",
      );
    },
  );

  server.registerTool(
    "hive_run_checkpoint",
    {
      title: "Write a RunCheckpoint",
      description:
        "Capture the current run state as a verified RunCheckpoint. Which boundaries are required versus merely requested is covered in hive_knowledge topic=succession. You supply the event, your measured context usage (or an explicit unknown), your compact-versus-replace decision, and the short written layer; the daemon fills the snapshot, pending messages, and hierarchy refs, and assigns the revision, creation time, and digest.",
      inputSchema: HiveRunCheckpointRequestSchema,
    },
    async (request) => {
      deps.authorizeTool(capability, "hive_run_checkpoint", "succession:write");
      const checkpoint = deps.succession.writeRootCheckpoint(request);
      return toolResult(checkpoint, "checkpoint");
    },
  );

  server.registerTool(
    "hive_succession_attest",
    {
      title: "Attest a queen succession",
      description: `Complete your own succession. Re-read ${successionRequiredReadInstruction()} first — the daemon measures all four — then attest the exact succession id, your generation, and the checkpoint digest from your boot capsule (or null when the capsule declares no checkpoint existed). Your other tools stay gated until this attestation lands.`,
      inputSchema: SuccessionAttestRequestSchema,
    },
    async (request) => {
      deps.authorizeTool(
        capability,
        "hive_succession_attest",
        "succession:write",
      );
      const succession = deps.succession.attest(request, capability.id);
      return toolResult(succession, "succession");
    },
  );
}
