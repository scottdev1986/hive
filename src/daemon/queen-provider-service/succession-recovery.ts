export const SUCCESSION_REQUIRED_READS = [
  { tool: "hive_status", proof: "status" },
  { tool: "hive_mail_poll", proof: "inbox" },
  { tool: "hive_task_list", proof: "board" },
  { tool: "hive_run_checkpoint_get", proof: "checkpoint" },
] as const;

export function successionRequiredReadInstruction(): string {
  const tools = SUCCESSION_REQUIRED_READS.map(({ tool }) => tool);
  return `${tools.slice(0, -1).join(", ")}, and ${tools.at(-1)}`;
}
