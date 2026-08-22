export function toolResult<T>(value: T, key: string, note?: string | null) {
  const payload = { type: "text" as const, text: JSON.stringify(value) };
  return {
    content:
      note === undefined || note === null
        ? [payload]
        : [payload, { type: "text" as const, text: note }],
    structuredContent: { [key]: value },
  };
}

export function toolError(reason: string) {
  const error = { reason };
  return {
    ...toolResult(error, "error"),
    isError: true as const,
  };
}
