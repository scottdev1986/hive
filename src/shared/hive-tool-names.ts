const HIVE_MAIL_READ_TOOLS: ReadonlySet<string> = new Set([
  "hive_mail_claim",
  "hive_mail_poll",
]);

/** Vendors name the same MCP tool differently — Claude prefixes the server (`mcp__hive__hive_mail_claim`), ACP vendors may pass the bare name — so callers match on the trailing Hive tool name rather than the vendor's spelling. */
export function hiveToolName(toolName: string): string | null {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "") return null;
  const separator = normalized.lastIndexOf("__");
  const bare = separator === -1 ? normalized : normalized.slice(separator + 2);
  return bare.startsWith("hive_") ? bare : null;
}

/** The two tools whose successful result carries another party's message body. */
export function isHiveMailReadTool(toolName: string): boolean {
  const name = hiveToolName(toolName);
  return name !== null && HIVE_MAIL_READ_TOOLS.has(name);
}
