import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hive's own server. Always attached: it is how the agent reports, lands, and reads memory. Scoping never removes it. */
export const HIVE_MCP_SERVER = "hive";

export const HIVE_MCP_SERVERS: readonly string[] = [HIVE_MCP_SERVER];

/** Where Hive's own MCP server answers on this machine. Every vendor config Hive writes and every client Hive opens names this one address, so it is spelled once. It lives beside the server's name rather than beside the daemon's port helpers because the vendor adapters that write it cannot import from the daemon layer. */
export function daemonMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

// Codex `-c` cannot quote a dotted path segment. Leave unaddressable server names attached rather than generating an invalid transport entry.
const CODEX_ADDRESSABLE_NAME = /^[A-Za-z0-9_-]+$/;

export function isCodexAddressableServerName(name: string): boolean {
  return CODEX_ADDRESSABLE_NAME.test(name);
}

export function codexHome(
  env: Record<string, string | undefined> = Bun.env,
  home = homedir(),
): string {
  return env.CODEX_HOME ?? join(home, ".codex");
}

const TABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(.+?)\s*]\s*$/;
const INLINE_ASSIGNMENT = /^\s*mcp_servers\s*\.\s*([^\s=.]+)\s*[.=]/;

const firstSegment = (path: string): string => {
  if (path.startsWith('"') || path.startsWith("'")) {
    const quote = path.charAt(0);
    const end = path.indexOf(quote, 1);
    return end === -1 ? path : path.slice(1, end);
  }
  const dot = path.indexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
};

/** Names of the MCP servers a `~/.codex/config.toml` attaches to every session. Parsed with a line scanner rather than a TOML library: Hive only needs the table names, and a parse failure here must never block a spawn. */
export function parseCodexMcpServerNames(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      continue;
    }
    const header = TABLE_HEADER.exec(line);
    if (header?.[1] !== undefined) {
      names.add(firstSegment(header[1]));
      continue;
    }
    const inline = INLINE_ASSIGNMENT.exec(line);
    if (inline?.[1] !== undefined) {
      names.add(inline[1]);
    }
  }
  return [...names];
}

/** Read the user's global Codex config to learn which servers a spawn would inherit. Never writes. A missing or unreadable config means nothing is inherited, which is the safe answer. */
export async function listInheritedCodexMcpServers(
  home = codexHome(),
): Promise<string[]> {
  try {
    return parseCodexMcpServerNames(
      await readFile(join(home, "config.toml"), "utf8"),
    );
  } catch {
    return [];
  }
}

export interface CodexMcpExclusion {
  args: string[];
  excluded: string[];
  /** Servers left attached because `-c` cannot address their names. */
  unaddressable: string[];
}

export function buildCodexMcpExclusionArgs(
  inherited: readonly string[],
  keep: readonly string[] = HIVE_MCP_SERVERS,
): CodexMcpExclusion {
  const kept = new Set(keep);
  const args: string[] = [];
  const excluded: string[] = [];
  const unaddressable: string[] = [];
  for (const name of inherited) {
    if (kept.has(name)) {
      continue;
    }
    if (!isCodexAddressableServerName(name)) {
      unaddressable.push(name);
      continue;
    }
    args.push("-c", `mcp_servers.${name}.enabled=false`);
    excluded.push(name);
  }
  return { args, excluded, unaddressable };
}
