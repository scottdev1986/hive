import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getHiveHome } from "../daemon/db";
import { CapabilityProviderSchema, type CapabilityProvider } from "../schemas";

const OrchestratorRuntimeSchema = z.strictObject({
  version: z.literal(1),
  owner: z.string().uuid(),
  pid: z.number().int().positive(),
  tool: CapabilityProviderSchema,
  startedAt: z.string().datetime(),
  sessionId: z.string().min(1).optional(),
});

export type OrchestratorRuntime = z.infer<typeof OrchestratorRuntimeSchema>;

export function orchestratorRuntimePath(home = getHiveHome()): string {
  return join(home, "runtime", "orchestrator.json");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readLiveOrchestratorRuntime(
  path = orchestratorRuntimePath(),
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<OrchestratorRuntime | null> {
  try {
    const parsed = OrchestratorRuntimeSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return isAlive(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
}

/** Publish the provider-native session selected by the supervisor's bounded
 * artifact monitor. The PID guard prevents an old generation from rewriting
 * a replacement supervisor's marker. Passing null clears the previous root
 * generation before the next provider process launches. */
export async function publishOrchestratorSessionId(
  sessionId: string | null,
  path = orchestratorRuntimePath(),
  pid = process.pid,
): Promise<boolean> {
  let runtime: OrchestratorRuntime;
  try {
    runtime = OrchestratorRuntimeSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch {
    return false;
  }
  if (runtime.pid !== pid) return false;
  const next = OrchestratorRuntimeSchema.parse({
    ...runtime,
    ...(sessionId === null ? { sessionId: undefined } : { sessionId }),
  });
  const temporary = `${path}.${runtime.owner}.session.tmp`;
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return true;
}

/**
 * Publish which root owns this instance while its supervisor is alive.
 *
 * The owner UUID makes cleanup generation-safe, while the PID makes a marker
 * left by SIGKILL inert. Each named Hive instance has its own HIVE_HOME, so a
 * Grok root can never capture a report addressed to another window.
 */
export async function withOrchestratorRuntime<T>(
  tool: CapabilityProvider,
  action: () => Promise<T>,
  options: {
    path?: string;
    pid?: number;
    now?: () => Date;
  } = {},
): Promise<T> {
  const path = options.path ?? orchestratorRuntimePath();
  const runtime = OrchestratorRuntimeSchema.parse({
    version: 1,
    owner: crypto.randomUUID(),
    pid: options.pid ?? process.pid,
    tool,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
  });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${runtime.owner}.tmp`;
  await writeFile(temporary, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  try {
    return await action();
  } finally {
    const current = await readLiveOrchestratorRuntime(path, () => true);
    if (current?.owner === runtime.owner) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
