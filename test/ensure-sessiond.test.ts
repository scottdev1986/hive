// Proves scripts/native/ensure-sessiond.sh can tell its outcomes apart. Three
// of them — missing, stale, and a build that failed — mean the caller did not
// run against sessiond at all, and until this gate existed all three reached
// the log as an ordinary sub-20ms test failure.
//
// The states are driven against a throwaway root with a Makefile of the same
// shape as the real one, because producing a genuinely stale binary in the
// checkout means either a 38s rebuild or writing to a build output the sandbox
// has no business touching. The real Makefile gets its own read-only case
// below, so a rename of the `sessiond` target still lands here.

import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GATE = join(REPO_ROOT, "scripts", "native", "ensure-sessiond.sh");

const SOURCE = "native/sessiond/src/session_host.zig";
const BINARY = "native/sessiond/zig-out/bin/hive-sessiond";

/** A root whose `sessiond` recipe does what the caller asked for: succeed by writing the binary, or fail. */
function fakeCheckout(recipe: "succeeds" | "fails"): string {
  // SAFETY: The test owns this value and its fields.
  const root = mkdtempSync(join(process.env.HIVE_TEST_ROOT as string, "sd-"));
  mkdirSync(join(root, "native/sessiond/src"), { recursive: true });
  writeFileSync(join(root, SOURCE), "// stand-in for the sessiond sources\n");
  const build =
    recipe === "succeeds"
      ? [
          "\t@mkdir -p $(@D)",
          "\t@printf '#!/bin/sh\\n' > $@",
          "\t@chmod 755 $@",
        ]
      : ["\t@echo 'zig build failed' >&2", "\t@exit 1"];
  writeFileSync(
    join(root, "Makefile"),
    [
      `BIN := $(CURDIR)/${BINARY}`,
      `$(BIN): $(CURDIR)/${SOURCE}`,
      ...build,
      ".PHONY: sessiond",
      "sessiond: $(BIN)",
      "",
    ].join("\n"),
  );
  return root;
}

function plantBinary(root: string, mtimeSeconds: number): void {
  const binary = join(root, BINARY);
  mkdirSync(join(root, "native/sessiond/zig-out/bin"), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\n");
  chmodSync(binary, 0o755);
  utimesSync(binary, mtimeSeconds, mtimeSeconds);
}

function runGate(...args: string[]) {
  const gate = Bun.spawnSync([GATE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: gate.exitCode,
    log: `${gate.stdout.toString()}${gate.stderr.toString()}`,
  };
}

test("a checkout with no binary is reported missing, distinctly", () => {
  const root = fakeCheckout("succeeds");
  const missing = runGate("--check", root);
  expect(missing.code).toBe(3);
  expect(missing.log).toContain("MISSING");
  expect(missing.log).toContain(join(root, BINARY));

  // Positive control: the same call on the same root says something else once
  // the binary is there, so exit 3 is a reading and not a constant.
  plantBinary(root, Date.now() / 1000);
  const present = runGate("--check", root);
  expect(present.code).toBe(0);
  expect(present.log).toContain("current");
});

test("a binary older than its sources is reported stale, and names one", () => {
  const root = fakeCheckout("succeeds");
  plantBinary(root, Date.now() / 1000 - 3600);
  const stale = runGate("--check", root);
  expect(stale.code).toBe(4);
  expect(stale.log).toContain("STALE");
  expect(stale.log).toContain(join(root, SOURCE));

  // The stale and missing exits are different numbers, and neither is the
  // exit a present, current binary produces.
  plantBinary(root, Date.now() / 1000);
  expect(runGate("--check", root).code).toBe(0);
});

test("--check never builds; the default mode does", () => {
  const root = fakeCheckout("succeeds");
  expect(runGate("--check", root).code).toBe(3);
  expect(runGate("--check", root).code).toBe(3);

  const built = runGate(root);
  expect(built.code).toBe(0);
  expect(built.log).toContain("building it with 'make sessiond'");
  expect(built.log).toContain("built");
  expect(runGate("--check", root).code).toBe(0);
});

test("a failed build is its own outcome, not a missing binary", () => {
  const root = fakeCheckout("fails");
  const failed = runGate(root);
  expect(failed.code).toBe(5);
  expect(failed.log).toContain("BUILD FAILED");
  expect(failed.log).toContain("did not run against sessiond at all");
});

// Whether this checkout is current is deliberately not asserted from in here.
// The suite runs with HOME remapped into the bounded test root and the
// Makefile keeps the Ghostty artifact stamp under $(HOME)/.cache, so make sees
// a missing prerequisite and reports stale for a checkout that is not.
// Measured: the same --check on the same tree at the same moment answers
// "current" with the real HOME and "STALE -- a build input outside
// native/sessiond/src" with HOME=/tmp/no-such-home. It is also why the gate
// runs in the parent process, before the mount exists.
test("the real Makefile still has the target the gate builds with", () => {
  // The gate's build is `make sessiond`, so that name is an interface. -n runs
  // nothing; make exits 2 for a target it has no rule for, which is what a
  // rename looks like from here.
  const dryRun = (target: string) =>
    Bun.spawnSync(["make", "-C", REPO_ROOT, "-n", target], {
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode;
  expect(dryRun("sessiond")).toBe(0);
  // Positive control for the reading above: a name the Makefile does not have
  // has to come back differently, or exit 0 means nothing.
  expect(dryRun("sessiond-no-such-target")).toBe(2);
});

test("the Bun suite cannot start without passing through the gate", async () => {
  const runner = join(REPO_ROOT, "scripts", "test-sandbox.ts");
  const source = await Bun.file(runner).text();
  expect(source).toContain(
    'join(REPO_ROOT, "scripts", "native", "ensure-sessiond.sh")',
  );
  expect(source).toContain("if (!selfTestOnly) ensureSessiond();");
});
