import { expect, test } from "bun:test";
import { relative } from "node:path";

test("production status callers use the public service boundary", async () => {
  const directInternalImport =
    /from\s+["'][^"']*\/status-service\/(?:activity-snapshot|events|fusion|generation|orchestrator|provider-client|service)["']|from\s+["'][^"']*\/status\/store["']/;
  const offenders: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.ts").scan({
    absolute: true,
  })) {
    if (path.includes("/src/daemon/status/")) continue;
    if (path.includes("/src/daemon/status-service/")) continue;
    if (directInternalImport.test(await Bun.file(path).text())) {
      offenders.push(relative(process.cwd(), path));
    }
  }
  expect(offenders).toEqual([]);
});

test("the legacy Agent UI hook bridge is deleted", async () => {
  expect(
    await Bun.file("src/cli/agent-ui/provider-event-report.ts").exists(),
  ).toBe(false);
});
