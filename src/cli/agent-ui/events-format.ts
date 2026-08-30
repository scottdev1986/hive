export const TOOL_LABELS = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
  other: "Tool",
} satisfies Record<string, string>;

export function displayToolName(name: string): string {
  const leaf = name.split("__").at(-1) ?? name;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (words === "") return "Tool";
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

export function compactElapsedLabel(
  startedAt: string,
  completedAt: string,
): string {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 1_000) return "<1s";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s`;
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.round((elapsed % 60_000) / 1_000);
  return `${minutes}m${seconds === 0 ? "" : ` ${seconds}s`}`;
}

/** Wall-clock time of day, local, for a row that already sits in a dated transcript. An unparseable timestamp shows as a dash rather than a made-up time. */
export function clockLabel(at: string): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "--:--:--";
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
