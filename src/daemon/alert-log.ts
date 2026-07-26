/**
 * Resource and control alerts are the only way daemon degradation reaches the
 * orchestrator; a failed alert send must not crash the sweep, but it must not
 * vanish either.
 *
 * Lifted out of server.ts by the decomposition (audit §11) once a second module
 * needed it — shared by the hook-event ingress and the resource sweep.
 */
export function logAlertDeliveryFailure(error: unknown): undefined {
  console.error(
    `Hive failed to deliver a daemon alert to the orchestrator: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  return undefined;
}
