import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeGrokAgentConfig } from "../adapters/tools/grok";
import { readDaemonPort } from "../daemon/lifecycle";
import { listInstances } from "../daemon/instances";
import {
  hiveInstanceSuffix,
  isDefaultHiveHome,
} from "../daemon/tmux-sessions";

interface RepairScope {
  readonly instanceId: string;
  readonly port: number | null;
  readonly allowLegacy: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonOrRemove(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(value).length === 0) {
    await rm(path, { force: true });
  } else {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

const localHiveUrl = (value: unknown, scope: RepairScope): boolean => {
  if (typeof value !== "string") return false;
  if (scope.port !== null && value === `http://127.0.0.1:${scope.port}/mcp`) return true;
  return scope.allowLegacy && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(value);
};

function isHiveMcpServer(value: unknown, scope: RepairScope): boolean {
  return isRecord(value) &&
    localHiveUrl(value.url, scope) &&
    typeof value.headersHelper === "string" &&
    // queen is preferred; orchestrator remains for pre-rename leaked config.
    /^hive credential --agent (?:queen|orchestrator)$/.test(value.headersHelper);
}

async function cleanClaudeMcp(root: string, scope: RepairScope): Promise<boolean> {
  const path = join(root, ".mcp.json");
  const text = await readText(path);
  if (text === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return false;
  const servers = { ...parsed.mcpServers };
  let changed = false;
  if (isHiveMcpServer(servers.hive, scope)) {
    delete servers.hive;
    changed = true;
  }
  if (!changed) return false;
  const next = { ...parsed };
  if (Object.keys(servers).length === 0) delete next.mcpServers;
  else next.mcpServers = servers;
  await writeJsonOrRemove(path, next);
  return true;
}

const hiveOrchestratorCommand = (value: unknown, scope: RepairScope): boolean => {
  if (typeof value !== "string") return false;
  // Preferred address is queen; synonym orchestrator still matches old leaks.
  if (!/^hive (?:event [a-z-]+|statusline) --agent (?:queen|orchestrator) --port \d+/.test(value)) {
    return false;
  }
  const owner = /--instance-id (\S+)/.exec(value)?.[1];
  return owner === scope.instanceId || (owner === undefined && scope.allowLegacy);
};

function knownReadOnlyPermissions(value: unknown): boolean {
  if (!isRecord(value) || value.defaultMode !== "default" ||
    !Array.isArray(value.allow) || !Array.isArray(value.deny)) return false;
  const allow = new Set(value.allow);
  const deny = new Set(value.deny);
  return [...allow].every((entry) =>
    entry === "Read" || entry === "Glob" || entry === "Grep" ||
    (typeof entry === "string" && entry.startsWith("mcp__hive__"))) &&
    ["Read", "Glob", "Grep"].every((entry) => allow.has(entry)) &&
    deny.size === 4 && ["Edit", "Write", "NotebookEdit", "Bash"]
      .every((entry) => deny.has(entry));
}

function removeHiveHooks(
  value: unknown,
  scope: RepairScope,
): { value: unknown; changed: boolean } {
  if (!isRecord(value)) return { value, changed: false };
  const hooks: Record<string, unknown> = {};
  let changed = false;
  for (const [event, groupsValue] of Object.entries(value)) {
    if (!Array.isArray(groupsValue)) {
      hooks[event] = groupsValue;
      continue;
    }
    const groups: unknown[] = [];
    for (const groupValue of groupsValue) {
      if (!isRecord(groupValue) || !Array.isArray(groupValue.hooks)) {
        groups.push(groupValue);
        continue;
      }
      const handlers = groupValue.hooks.filter((handler) =>
        !isRecord(handler) || !hiveOrchestratorCommand(handler.command, scope));
      if (handlers.length !== groupValue.hooks.length) changed = true;
      if (handlers.length > 0) groups.push({ ...groupValue, hooks: handlers });
    }
    if (groups.length > 0) hooks[event] = groups;
  }
  return { value: hooks, changed };
}

async function cleanClaudeSettings(root: string, scope: RepairScope): Promise<boolean> {
  const path = join(root, ".claude", "settings.local.json");
  const text = await readText(path);
  if (text === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const next = { ...parsed };
  let changed = false;
  if (isRecord(next.statusLine) && hiveOrchestratorCommand(next.statusLine.command, scope)) {
    delete next.statusLine;
    changed = true;
  }
  const hooks = removeHiveHooks(next.hooks, scope);
  if (hooks.changed) {
    if (isRecord(hooks.value) && Object.keys(hooks.value).length === 0) delete next.hooks;
    else next.hooks = hooks.value;
    changed = true;
  }
  if (knownReadOnlyPermissions(next.permissions)) {
    delete next.permissions;
    changed = true;
  }
  if (changed && next.enableAllProjectMcpServers === true) {
    delete next.enableAllProjectMcpServers;
  }
  if (!changed) return false;
  await writeJsonOrRemove(path, next);
  return true;
}

async function cleanCodexConfig(root: string, scope: RepairScope): Promise<boolean> {
  const path = join(root, ".codex", "config.toml");
  const text = await readText(path);
  if (text === null) return false;
  const blocks = text.split(/(?=^\s*\[)/m);
  const base = blocks.find((block) => /^\s*\[mcp_servers\.hive\]\s*$/m.test(block));
  const url = /^url\s*=\s*["'](http:\/\/127\.0\.0\.1:\d+\/mcp)["']\s*$/m.exec(base ?? "")?.[1];
  if (base === undefined || !localHiveUrl(url, scope)) {
    return false;
  }
  const next = blocks.filter((block) =>
    !/^\s*\[mcp_servers\.hive(?:\.|\])/.test(block)).join("");
  if (next.trim().length === 0) await rm(path, { force: true });
  else await writeFile(path, next.replace(/^\s+/, ""));
  return true;
}

async function cleanCodexNotify(root: string, scope: RepairScope): Promise<boolean> {
  const path = join(root, ".codex", "hive-notify.sh");
  const text = await readText(path);
  if (text === null || !text.startsWith("#!/bin/sh\nexec ") ||
    !hiveOrchestratorCommand(text.slice("#!/bin/sh\nexec ".length).replace(/ --payload "\$1"\n$/, ""), scope)) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

/** Remove only stale project runtime entries carrying Hive's exact signatures. */
export async function repairLeakedProjectConfig(
  root: string,
  providedScope?: RepairScope,
): Promise<string[]> {
  const scope = providedScope ?? {
    instanceId: hiveInstanceSuffix(),
    port: readDaemonPort(),
    allowLegacy: isDefaultHiveHome() && !(await listInstances())
      .some((instance) => instance.name !== "default" && instance.running),
  };
  const repairs = await Promise.all([
    cleanClaudeMcp(root, scope),
    cleanClaudeSettings(root, scope),
    cleanCodexConfig(root, scope),
    cleanCodexNotify(root, scope),
    scope.allowLegacy ? removeGrokAgentConfig(root) : Promise.resolve(false),
  ]);
  return [".mcp.json", ".claude/settings.local.json", ".codex/config.toml", ".codex/hive-notify.sh", ".grok/config.toml"]
    .filter((_, index) => repairs[index]);
}
