import { describe, expect, test } from "bun:test";
import { renderQueenBoardSnapshot } from "../../src/daemon/queen-provider-service/queen-boot-capsule-service";
import {
  composeQueenCompactReload,
  ensureQueenPin,
  QUEEN_PIN,
  QUEEN_PIN_MAX_ESTIMATED_TOKENS,
  queenPinPresent,
} from "../../src/daemon/queen-provider-service/queen-pin";
import { estimateTokensForText } from "../../src/usage-service/token-estimate";

const board = {
  schemaVersion: 2 as const,
  instanceId: "instance",
  seq: "9",
  entities: [
    {
      kind: "hierarchy-task" as const,
      id: "run_1:tasks",
      entityRevision: "3",
      projection: {
        tasks: {
          availability: "present" as const,
          value: [
            {
              taskId: "task_1",
              revision: "3",
              state: "blocked",
              blockers: ["owner ruling"],
            },
          ],
        },
      },
    },
  ],
  createdAt: "2026-08-10T00:00:00.000Z",
  contentSha256: "b".repeat(64),
};

describe("queen pin", () => {
  test("stays within its ratcheted token budget", () => {
    expect(estimateTokensForText(QUEEN_PIN)).toBeLessThanOrEqual(
      QUEEN_PIN_MAX_ESTIMATED_TOKENS,
    );
  });

  test("names the role, the board, and the spawn gate", () => {
    expect(QUEEN_PIN).toContain("project manager");
    expect(QUEEN_PIN).toContain("tech lead");
    expect(QUEEN_PIN).toContain("architect");
    expect(QUEEN_PIN).toContain("do not implement");
    expect(QUEEN_PIN).toContain("hierarchy board");
    expect(QUEEN_PIN).toContain("hive_task_list");
    expect(QUEEN_PIN).toContain("No spawn without a current taskId");
  });

  test("compact reload carries the exact pin bytes plus the live board", () => {
    const reload = composeQueenCompactReload({
      boardText: renderQueenBoardSnapshot(board),
    });
    expect(reload.pin).toBe(QUEEN_PIN);
    expect(queenPinPresent(reload.text)).toBe(true);
    expect(reload.text).toContain("Hive compact:");
    expect(reload.text).toContain("internal operations");
    expect(reload.text).toContain('"kind":"active-task"');
    expect(reload.text).toContain("task_1");
    expect(reload.text).toContain("Transcript plan is stale");
    expect(reload.estimatedTokens).toBe(estimateTokensForText(reload.text));
  });

  test("an unavailable board still delivers the pin and names the gap", () => {
    const reload = composeQueenCompactReload({
      boardText: null,
      unavailable: "hierarchy snapshot failed",
    });
    expect(queenPinPresent(reload.text)).toBe(true);
    expect(reload.text).toContain("hierarchy snapshot failed");
    expect(reload.text).toContain("use hive_task_list");
    expect(reload.text).not.toContain('"kind":"active-task"');
  });

  test("ensureQueenPin restores omitted pin bytes and leaves them intact", () => {
    expect(ensureQueenPin("Hive compact: rewritten")).toContain(QUEEN_PIN);
    expect(ensureQueenPin(`${QUEEN_PIN}\n\nboard`)).toBe(
      `${QUEEN_PIN}\n\nboard`,
    );
  });
});
