export type ProjectGate = (repoRoot: string) => Promise<void>;

/** Landing does not compile in a repository's verification. What "green" means is learned from the repo and run by the agent before hive_land. Tests may inject a gate. */
export const runProjectGate: ProjectGate = async () => {};
