import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { macProcessIdentity } from "../../../src/daemon/lifecycle";

test("TypeScript and Zig encode the same live process identity", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const probe = resolve(root, "native/sessiond/zig-out/bin/sessiond-identity-probe");
  const child = Bun.spawn([probe, String(process.pid)], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(status, stderr).toBe(0);

  const expected = macProcessIdentity(process.pid);
  expect(stdout).toBe(`${expected.startToken}\n${expected.executablePath}\n`);
});
