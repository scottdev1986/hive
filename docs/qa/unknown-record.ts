/** Narrow unknown JSON-shaped values at the point of use. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = recordField(value, key);
  return typeof field === "number" ? field : undefined;
}

export type AgentRow = {
  name: string;
  id?: string;
  status?: string;
  model?: string;
  sessionLocator?: {
    sessionId?: string;
    generation?: number;
  };
  statusDimensions?: Record<string, unknown>;
};

export function asAgentRow(value: unknown): AgentRow | null {
  const name = stringField(value, "name");
  if (name === undefined) return null;
  const locatorValue = recordField(value, "sessionLocator");
  const sessionLocator = isRecord(locatorValue)
    ? {
        sessionId: stringField(locatorValue, "sessionId"),
        generation: numberField(locatorValue, "generation"),
      }
    : undefined;
  const dimensions = recordField(value, "statusDimensions");
  return {
    name,
    id: stringField(value, "id"),
    status: stringField(value, "status"),
    model: stringField(value, "model"),
    sessionLocator,
    statusDimensions: isRecord(dimensions) ? dimensions : undefined,
  };
}

export function findAgent(
  statusResult: unknown,
  name: string,
): AgentRow | undefined {
  const agents = recordField(
    recordField(statusResult, "structuredContent"),
    "agents",
  );
  if (!Array.isArray(agents)) return undefined;
  for (const candidate of agents) {
    const row = asAgentRow(candidate);
    if (row !== null && row.name === name) return row;
  }
  return undefined;
}

export function structuredContent(result: unknown): unknown {
  return recordField(result, "structuredContent");
}

export function terminalWritesTotal(statusResult: unknown): number | undefined {
  return numberField(
    recordField(structuredContent(statusResult), "terminalWrites"),
    "total",
  );
}

export function toolMail(result: unknown): Record<string, unknown> {
  const mail = recordField(structuredContent(result), "mail");
  return isRecord(mail) ? mail : {};
}

export type TerminalCapture = {
  composer: unknown;
  text?: string;
};

export function asCapture(value: unknown): TerminalCapture | null {
  if (!isRecord(value)) return null;
  return {
    composer: value.composer,
    text: typeof value.text === "string" ? value.text : undefined,
  };
}

export function observeCapture(toolResult: unknown): unknown {
  return recordField(
    recordField(structuredContent(toolResult), "terminalObservation"),
    "capture",
  );
}

export function requireSessionLocator(row: AgentRow): {
  sessionId: string;
  generation: number;
} {
  const sessionId = row.sessionLocator?.sessionId;
  const generation = row.sessionLocator?.generation;
  if (sessionId === undefined || generation === undefined) {
    throw new Error(`agent ${row.name} has no session locator`);
  }
  return { sessionId, generation };
}
