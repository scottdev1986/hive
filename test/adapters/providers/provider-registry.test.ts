import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAgentAdapter,
  getProviderRuntimeAdapter,
} from "../../../src/adapters/providers/provider-registry";
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

  test("the same provider set resolves through the runtime probe registry", () => {
    for (const provider of CAPABILITY_PROVIDERS) {
      expect(getProviderRuntimeAdapter(provider).id).toBe(provider);
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

  test("claude prepares protocol config and argv", async () => {
    const path = await worktree();
    const prepared = await getAgentAdapter("claude").prepareRuntime({
      name: "maya",
      model: "claude-opus-4-8",
      worktreePath: path,
      daemonPort: 41000,
      readOnly: true,
      dangerous: false,
      instructionPath: "/tmp/prompt.txt",
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
  });

  test("codex prepares app-server config without a TUI profile", async () => {
    const path = await worktree();
    const prepared = await getAgentAdapter("codex").prepareRuntime({
      name: "maya",
      model: "gpt-5.3-codex",
      worktreePath: path,
      daemonPort: 41000,
      readOnly: false,
      dangerous: false,
      withCapability: true,
      instructionPath: "/tmp/prompt.txt",
    });
    expect(prepared.argv[0]).toBe("codex");
    expect(prepared.argv).not.toContain("--profile");
    expect(prepared.argv).toContain(
      'mcp_servers.hive.bearer_token_env_var="HIVE_CAPABILITY_TOKEN"',
    );
  });

  test("grok prepares project config without native TUI argv", async () => {
    const path = await worktree();
    const prepared = await getAgentAdapter("grok").prepareRuntime({
      name: "maya",
      model: "grok-4",
      worktreePath: path,
      daemonPort: 41000,
      readOnly: false,
      dangerous: false,
      instructionPath: "/tmp/prompt.txt",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000223",
    });
    expect(prepared.argv).toEqual([]);
  });
});
