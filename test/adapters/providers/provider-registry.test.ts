import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentAdapter } from "../../../src/adapters/providers/provider-registry";
import { CAPABILITY_PROVIDERS } from "../../../src/schemas/capability";
import { ProviderCommunicationCapabilitiesSchema } from "../../../src/schemas/provider-communication";

const roots: string[] = [];
async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-adapter-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent adapter factory", () => {
  test("every capability provider resolves to an adapter with a matching id", () => {
    for (const provider of CAPABILITY_PROVIDERS) {
      expect(getAgentAdapter(provider).id).toBe(provider);
    }
  });

  test("every provider has one honest communication descriptor", () => {
    const descriptors = Object.fromEntries(
      CAPABILITY_PROVIDERS.map((provider) => [
        provider,
        ProviderCommunicationCapabilitiesSchema.parse(
          getAgentAdapter(provider).communication,
        ),
      ]),
    );
    expect(descriptors).toEqual({
      claude: {
        provider: "claude",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: true,
        turnBoundaryEvents: true,
        transcriptReader: true,
        nativeCancel: false,
        conversationResume: true,
      },
      codex: {
        provider: "codex",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: true,
        turnBoundaryEvents: true,
        transcriptReader: true,
        nativeCancel: false,
        conversationResume: true,
      },
      grok: {
        provider: "grok",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: true,
        turnBoundaryEvents: true,
        transcriptReader: true,
        nativeCancel: false,
        conversationResume: true,
      },
      kimi: {
        provider: "kimi",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: false,
        turnBoundaryEvents: false,
        transcriptReader: false,
        nativeCancel: false,
        conversationResume: true,
      },
      opencode: {
        provider: "opencode",
        eventSource: "hooks",
        nativeDelivery: false,
        toolBoundaryEvents: false,
        turnBoundaryEvents: false,
        transcriptReader: false,
        nativeCancel: false,
        conversationResume: true,
      },
    });
  });

  test("claude prepares config, argv, and a kickoff-bearing command", async () => {
    const path = await worktree();
    const prepared = await getAgentAdapter("claude").prepareSpawn({
      name: "maya",
      model: "claude-opus-4-8",
      worktreePath: path,
      daemonPort: 41000,
      readOnly: true,
      dangerous: false,
      instructionPath: "/tmp/prompt.txt",
      kickoff: "Begin the assigned task.",
    });
    expect(prepared.argv).toEqual([
      "claude",
      "--model",
      "claude-opus-4-8",
      "--permission-mode",
      "default",
      "--mcp-config",
      join(path, ".mcp.json"),
      "--strict-mcp-config",
      "--append-system-prompt-file",
      "/tmp/prompt.txt",
    ]);
    expect(prepared.command).toBe(
      `${prepared.argv.map((token) => `'${token}'`).join(" ")} 'Begin the assigned task.'`,
    );
  });

  test("codex wraps the token through the shell and installs its profile", async () => {
    const path = await worktree();
    const prepared = await getAgentAdapter("codex").prepareSpawn({
      name: "maya",
      model: "gpt-5.3-codex",
      worktreePath: path,
      daemonPort: 41000,
      readOnly: false,
      dangerous: false,
      withCapability: true,
      instructionPath: "/tmp/prompt.txt",
      sessionId: "session-1",
      kickoff: "Begin the assigned task.",
    });
    expect(prepared.argv[0]).toBe("codex");
    expect(prepared.argv.slice(1, 3)).toEqual(["--profile", "hive-session-1"]);
    // The token value never enters argv or the command: only the 0600 file
    // read does.
    expect(prepared.command).toContain('HIVE_CAPABILITY_TOKEN="$(cat ');
    expect(prepared.command).not.toContain("secret-token");
    expect(prepared.command).toContain("install -m 600 ");
  });

  test("codex resume carries no profile or token wrap without instructions", async () => {
    const path = await worktree();
    const prepared = await getAgentAdapter("codex").prepareSpawn({
      name: "maya",
      model: "gpt-5.3-codex",
      worktreePath: path,
      daemonPort: 41000,
      readOnly: true,
      dangerous: false,
      resumeSessionId: "rollout-1",
    });
    expect(prepared.argv[1]).toBe("resume");
    expect(prepared.argv).not.toContain("--profile");
    expect(prepared.command).not.toContain("install -m 600");
  });

  test("grok takes no positional kickoff; instructions ride the rules wrap", async () => {
    const path = await worktree();
    const prepared = await getAgentAdapter("grok").prepareSpawn({
      name: "maya",
      model: "grok-4",
      worktreePath: path,
      daemonPort: 41000,
      readOnly: false,
      dangerous: false,
      instructionPath: "/tmp/prompt.txt",
      newVendorSessionId: "3f8b2c1a-9d4e-4f6b-8a2c-1e5d7b9c3a0f",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000223",
      kickoff: "Begin the assigned task.",
    });
    expect(prepared.argv).toEqual([
      "grok",
      "--no-auto-update",
      "-m",
      "grok-4",
      "--always-approve",
      "--session-id",
      "3f8b2c1a-9d4e-4f6b-8a2c-1e5d7b9c3a0f",
    ]);
    expect(prepared.command).toContain("GROK_CLAUDE_SKILLS_ENABLED=false");
    expect(prepared.command).toContain("--rules \"$(cat '/tmp/prompt.txt')\"");
    expect(prepared.command).toContain("'Begin the assigned task.'");
  });
});
