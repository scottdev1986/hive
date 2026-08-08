import { describe, expect, test } from "bun:test";
import {
  elicitationOptions,
  normalizeSessionUpdate,
  permissionDetail,
} from "../src/adapters/providers/protocol/acp-normalize";
import { unifiedDiff } from "../src/cli/agent-ui/unified-diff";

describe("ACP tool calls keep what they say about files", () => {
  test("a diff content block survives normalization", () => {
    const [event] = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Edit src/app.ts",
          kind: "edit",
          locations: [{ path: "/repo/src/app.ts" }],
          content: [
            {
              type: "diff",
              path: "/repo/src/app.ts",
              oldText: "const a = 1;\n",
              newText: "const a = 2;\n",
            },
          ],
        },
      },
      "t1",
    );

    expect(event).toMatchObject({
      kind: "tool-started",
      toolKind: "edit",
      locations: ["/repo/src/app.ts"],
      changes: [
        {
          path: "/repo/src/app.ts",
          oldText: "const a = 1;\n",
          newText: "const a = 2;\n",
        },
      ],
    });
  });

  test("a completing update carries its diff before the call stops running", () => {
    const events = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [
            { type: "diff", path: "/repo/a.ts", oldText: null, newText: "x\n" },
          ],
        },
      },
      "t1",
    );

    expect(events.map((event) => event.kind)).toEqual([
      "tool-updated",
      "tool-finished",
    ]);
    expect(events[0]).toMatchObject({
      changes: [{ path: "/repo/a.ts", oldText: null, newText: "x\n" }],
    });
  });

  test("a failed update carries its final output as the failure reason", () => {
    const events = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "failed",
          content: [
            { type: "content", content: { text: "permission denied" } },
          ],
        },
      },
      "t1",
    );

    expect(events.at(-1)).toMatchObject({
      kind: "tool-finished",
      status: "error",
      reason: "permission denied",
    });
  });

  test("an update that says nothing about content leaves it alone", () => {
    const [event] = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "still working",
        },
      },
      "t1",
    );

    // Absent, not empty: an empty array would wipe a diff already on screen.
    expect(event).not.toHaveProperty("changes");
  });
});

describe("a permission says what it is asking", () => {
  const question = {
    options: [
      { optionId: "q0_opt_0", name: "alpha", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ],
    toolCall: {
      title: "AskUserQuestion",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Pick one: alpha or beta?" },
        },
      ],
    },
  };

  test("the question text is read out of the tool call's content", () => {
    expect(permissionDetail(question)).toBe("Pick one: alpha or beta?");
  });

  test("options keep the vendor's ids and are classified by kind", () => {
    expect(elicitationOptions(question)).toEqual([
      { optionId: "q0_opt_0", name: "alpha", kind: "allow" },
      { optionId: "q0_skip", name: "Skip", kind: "reject" },
    ]);
  });

  test("no options is empty rather than an invented allow/deny pair", () => {
    expect(elicitationOptions({ toolCall: { title: "Bash" } })).toEqual([]);
  });
});

describe("unified diffs are generated rather than hand-counted", () => {
  test("a replacement produces hunk counts matching its body", () => {
    const patch = unifiedDiff({
      path: "src/app.ts",
      oldText: "a\nb\nc\n",
      newText: "a\nB\nc\n",
    });

    expect(patch).toContain("@@ -1,3 +1,3 @@");
    expect(patch).toContain("-b");
    expect(patch).toContain("+B");
  });

  test("a created file diffs against /dev/null", () => {
    const patch = unifiedDiff({
      path: "src/new.ts",
      oldText: null,
      newText: "hello\n",
    });

    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+hello");
  });
});

describe("vendor shapes observed on the wire", () => {
  test("Grok's tool kind is read from its _meta when ACP's field is absent", () => {
    // Captured from grok: no top-level `kind`, classification under _meta.
    const [event] = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "search_replace",
          _meta: { "x.ai/tool": { name: "search_replace", kind: "edit" } },
        },
      },
      "t1",
    );

    expect(event).toMatchObject({ toolKind: "edit" });
  });

  test("a kind Grok has but ACP does not stays unclassified", () => {
    const [event] = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "list_dir",
          _meta: { "x.ai/tool": { name: "list_dir", kind: "list" } },
        },
      },
      "t1",
    );

    expect(event).toMatchObject({ toolKind: null });
  });

  test("an update that names no kind leaves the one already shown", () => {
    // Grok sends _meta on every update but names the kind on only some.
    const [event] = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          _meta: { totalTokens: 10 },
        },
      },
      "t1",
    );

    expect(event).not.toHaveProperty("toolKind");
  });

  test("a file is named from its diff when the vendor sends no locations", () => {
    // Kimi and OpenCode both send locations: [] and the path inside the diff.
    const [event] = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Edit",
          kind: "edit",
          locations: [],
          content: [
            {
              type: "diff",
              path: "/repo/app.ts",
              oldText: "3000",
              newText: "8080",
            },
          ],
        },
      },
      "t1",
    );

    expect(event).toMatchObject({ locations: ["/repo/app.ts"] });
  });

  test("Grok's ask_user_question is readable even though it cannot be answered", () => {
    const [event] = normalizeSessionUpdate(
      {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "ask_user_question",
          rawInput: {
            questions: [
              {
                question: "Pick one: alpha or beta?",
                options: [
                  { label: "alpha", description: "Choose alpha" },
                  { label: "beta", description: "Choose beta" },
                ],
              },
            ],
          },
          _meta: {
            "x.ai/tool": { name: "ask_user_question", kind: "ask_user" },
          },
        },
      },
      "t1",
    );

    expect(event).toMatchObject({ kind: "tool-started" });
    const detail = (event as { detail: string }).detail;
    expect(detail).toContain("Pick one: alpha or beta?");
    expect(detail).toContain("alpha — Choose alpha");
    expect(detail).toContain("beta — Choose beta");
  });
});
