import type { CostClass, Provider, Scenario } from "./types";

export interface ScenarioPrompt {
  purpose: string;
  text: (markerPath: string) => string;
  realTask: boolean;
}

export const PROMPTS: Record<Scenario, ScenarioPrompt> = {
  lifecycle: {
    purpose: "Produce one minimal successful turn so lifecycle boundaries and the effective model are observable.",
    text: () => "Reply with exactly HIVE_LIFECYCLE_OK. Do not use tools.",
    realTask: true,
  },
  approve: {
    purpose: "Force one correlated write approval, approve it, and verify the approved side effect.",
    text: (markerPath) =>
      `Use the Write or file-change tool exactly once to create ${markerPath} with the exact contents HIVE_APPROVED. Do not use Bash or another tool to create the file. After the attempt, report whether it succeeded.`,
    realTask: true,
  },
  deny: {
    purpose: "Force one correlated write approval, deny it, and verify that the side effect did not occur.",
    text: (markerPath) =>
      `Use the Write or file-change tool exactly once to create ${markerPath} with the exact contents HIVE_DENIED_SHOULD_NOT_EXIST. Do not use Bash or another tool to create the file. After the attempt, report whether it succeeded.`,
    realTask: true,
  },
  "needs-user": {
    purpose: "Force one native clarification request and answer it through the provider control protocol.",
    text: () =>
      "Use the native AskUserQuestion or request_user_input tool exactly once. Ask 'Choose alpha or beta' with Alpha and Beta as the two options. Do not choose for the user. After the answer arrives, reply with exactly HIVE_USER_CHOICE:Alpha.",
    realTask: true,
  },
  steer: {
    purpose: "Keep a turn active long enough to inject a direction change and verify the accepted steer affects the final response.",
    text: () =>
      "Use the shell tool to run /bin/sleep 8. After it finishes, reply with exactly HIVE_ORIGINAL_DIRECTION.",
    realTask: true,
  },
  cancel: {
    purpose: "Keep a turn active long enough to cancel it and require both command acknowledgement and a terminal interrupted state.",
    text: () =>
      "Use the shell tool to run /bin/sleep 30. After it finishes, reply with exactly HIVE_CANCEL_FAILED.",
    realTask: true,
  },
  resume: {
    purpose: "Create durable conversation state, restart the provider process, resume by the recorded session id, and verify prior context.",
    text: () => "Remember the token HIVE_RESUME_ANCHOR and reply with exactly HIVE_RESUME_STORED.",
    realTask: true,
  },
  "invalid-model": {
    purpose: "Validation-only sentinel. It is not a user task and must be rejected before any real task is accepted.",
    text: () => "Reply with exactly HIVE_PROVIDER_VALIDATION_OK. Do not use tools.",
    realTask: false,
  },
  "read-only": {
    purpose: "Attempt one write under a non-interactive read-only policy and verify policy denial plus absence of the marker.",
    text: (markerPath) =>
      `Use the Write or file-change tool exactly once to create ${markerPath} with the exact contents HIVE_READ_ONLY_VIOLATION. Do not use Bash or another tool to create the file. Report the denial.`,
    realTask: true,
  },
  "dual-client": {
    purpose: "Attach the Codex TUI and a second protocol client to one durable thread, accept a steer, inject model-visible history, and verify the TUI receives the shared result.",
    text: () =>
      "Use the shell tool to run /bin/sleep 8. After it finishes, reply with exactly HIVE_ORIGINAL_DIRECTION.",
    realTask: true,
  },
};

const COMMON_BILLABLE: Record<Exclude<Scenario, "invalid-model">, CostClass> = {
  lifecycle: "billable",
  approve: "billable",
  deny: "billable",
  "needs-user": "billable",
  steer: "billable",
  cancel: "billable",
  resume: "billable",
  "read-only": "billable",
  "dual-client": "billable",
};

export function expectedCost(provider: Provider, scenario: Scenario): CostClass {
  if (scenario === "dual-client" && provider !== "codex") {
    throw new Error("dual-client applies only to Codex app-server");
  }
  if (scenario !== "invalid-model") return COMMON_BILLABLE[scenario];
  return provider === "claude" ? "non-billable" : "unknown";
}

export const STEER_TEXT =
  "Change direction now. Your final reply must be exactly HIVE_STEERED_OK and must not contain HIVE_ORIGINAL_DIRECTION.";

export const DUAL_CLIENT_STEER_TEXT =
  "Change direction now. In the final reply, concatenate HIVE_STEERED_ with OK, with no spaces or other text. Do not include HIVE_ORIGINAL_DIRECTION.";

export const DUAL_CLIENT_INJECT_TEXT = "Remember the exact token HIVE_INJECT_SEEN.";

export const DUAL_CLIENT_VERIFY_TEXT =
  "What exact token did the injected instruction tell you to remember? Reply only with it.";

export const RESUME_CHECK_TEXT =
  "If this is the same durable conversation and you remember the prior token, reply with exactly HIVE_RESUME_OK:HIVE_RESUME_ANCHOR. Do not use tools.";

export const INVALID_MODEL = "hive-conformance-invalid-model-00000000";
