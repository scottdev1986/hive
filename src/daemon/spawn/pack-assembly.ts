import type { HiveDatabase } from "../database/hive-database";
import type { EpisodicStore } from "../../memory-service/episodic";
import { loadHandoffText } from "./handoff-loader";
import { SpawnFailedError } from "./spawn-failed-error";

/**
 * P0: Wake pack floor assembly result.
 * This is the validated pack that spawn passes to buildAgentPrompt.
 */
export interface WakePackFloor {
  constitution: string;
  profile: string;
  projectDoc: string;
  handoffText: string;
  recentMistakes: readonly string[];
}

/**
 * P0: Load and validate wake pack floor for specialist spawn.
 *
 * This is the production pack assembly logic that HiveSpawner.spawn uses.
 * It loads all pack floor slots and validates handoff (fail-closed).
 *
 * @throws SpawnFailedError if handoff cannot be loaded/synthesized (fail-closed)
 */
export async function loadAndValidateWakePack(options: {
  db: HiveDatabase;
  episodic: EpisodicStore | undefined;
  repoRoot: string;
  handoffId: string | undefined;
  agentName: string;
  task: string | undefined;
}): Promise<WakePackFloor> {
  const { loadConstitution, loadProfile, loadProjectDoc, loadRecentMistakes } =
    await import("../../memory-service/pack-floor");

  // P0: Load pack floor slots using shared loaders
  const [constitution, profile, projectDoc, recentMistakes] = await Promise.all(
    [
      Promise.resolve(loadConstitution()),
      loadProfile(),
      loadProjectDoc(options.repoRoot),
      loadRecentMistakes(options.episodic, options.repoRoot),
    ],
  );

  // P0: Load or synthesize handoff (fail-closed if unsynthable)
  const handoffText = loadHandoffText(
    options.db,
    options.handoffId,
    options.agentName,
    options.task,
  );

  // P0: Fail-closed if handoff cannot be synthesized
  if (handoffText === null) {
    throw new SpawnFailedError(
      options.agentName,
      "transport",
      "failed",
      "Cannot spawn specialist without handoff: no durable handoff provided and task description insufficient for synthesis",
    );
  }

  return {
    constitution,
    profile,
    projectDoc,
    handoffText,
    recentMistakes,
  };
}
