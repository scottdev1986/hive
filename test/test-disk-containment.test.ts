import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  hostDirectory,
  hostSocketPath,
  neutralDirectory,
  neutralSocketPath,
} from "../src/daemon/session-host/host-operations";
import { sessiondRuntimeRoot } from "../src/hive-home/instance-identity";

test("the ordinary suite runs inside its hard byte ceiling", () => {
  const root = process.env.HIVE_TEST_ROOT;
  const maxBytes = BigInt(process.env.HIVE_TEST_ROOT_MAX_BYTES ?? "0");
  expect(root).toBeString();
  expect(maxBytes).toBeGreaterThan(0n);

  const stats = statfsSync(root as string, { bigint: true });
  expect(stats.bsize * stats.blocks).toBeLessThanOrEqual(maxBytes);

  const positiveControl = join(root as string, "write-positive-control");
  writeFileSync(positiveControl, "ok");
  expect(existsSync(positiveControl)).toBe(true);
  rmSync(positiveControl);
});

test("ambient credentials do not cross the test-process boundary", () => {
  expect(process.env.HIVE_TEST_ROOT).toBeString();
  expect(process.env.HIVE_CAPABILITY_TOKEN).toBeUndefined();
});

test("an out-of-root write is refused by the host sandbox", () => {
  const outside = process.env.HIVE_TEST_OUTSIDE_PATH;
  expect(outside).toBeString();
  const escapedFile = join(outside as string, "escape");
  try {
    writeFileSync(escapedFile, "escape");
    throw new Error("out-of-root write unexpectedly succeeded");
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
  }
  expect(existsSync(escapedFile)).toBe(false);
});

/** macOS `sun_path` is 104 bytes including the terminator, so a bindable path is at most 103. */
const SUN_PATH_LIMIT = 103;

/** Two session identities chosen to be as unlike each other as the callers can make them: the longest session id the locator mints, and a neutral reference whose key and incarnation are long. A socket name that varied with either would make "the longest path" a moving target. */
const LONGEST_SESSION_ID = `ses_${"0".repeat(36)}`;
const LONGEST_NEUTRAL_SESSION = {
  key: "0".repeat(4096),
  incarnation: "0".repeat(4096),
};

/** Runs `read` with the socket root pinned, so the measurement is about the layout rather than about whichever test ran before this one. */
function withSocketRoot<T>(root: string, read: () => T): T {
  const previous = process.env.HIVE_SESSIOND_ROOT;
  process.env.HIVE_SESSIOND_ROOT = root;
  try {
    return read();
  } finally {
    if (previous === undefined) delete process.env.HIVE_SESSIOND_ROOT;
    else process.env.HIVE_SESSIOND_ROOT = previous;
  }
}

test("both socket kinds fit sun_path at their longest, measured from the builders that bind them", () => {
  // Every figure below comes from the functions the launcher and the host actually call. Nothing
  // here restates a path shape: a test that spells the layout out again passes happily while the
  // code that binds the socket has moved on, which is the failure this file exists to catch.
  const canonicalProductionRoot = withSocketRoot(
    sessiondRuntimeRoot("/some/persistent/home"),
    () => process.env.HIVE_SESSIOND_ROOT as string,
  );
  // This root used to be a 27-byte constant under /private/tmp — /tmp being a symlink was worth
  // eight bytes nobody had counted. It is under the machine home now, so its length belongs to the
  // operator and there is no constant to assert; what is measured below is the part Hive owns.
  expect(canonicalProductionRoot).toStartWith("/");

  const [hostSocket, neutralSocket] = withSocketRoot(
    canonicalProductionRoot,
    () =>
      [
        hostSocketPath("", LONGEST_SESSION_ID),
        neutralSocketPath("", LONGEST_NEUTRAL_SESSION),
      ] as const,
  );

  // The root, then `/` and a fixed ten-byte name: eleven bytes for both kinds. The name is a
  // digest, so these are not "a long example" — no session of either kind can be longer, and the
  // eleven is Hive's whole share of the budget.
  const rootBytes = Buffer.byteLength(canonicalProductionRoot);
  expect(Buffer.byteLength(hostSocket) - rootBytes).toBe(11);
  expect(Buffer.byteLength(neutralSocket) - rootBytes).toBe(11);
  expect(Buffer.byteLength(hostSocket)).toBeLessThanOrEqual(SUN_PATH_LIMIT);
  expect(Buffer.byteLength(neutralSocket)).toBeLessThanOrEqual(SUN_PATH_LIMIT);

  // The claim that a digest bounds the name, tested rather than asserted: identities of wildly
  // different lengths still name sockets of one length.
  const shortest = withSocketRoot(canonicalProductionRoot, () => [
    hostSocketPath("", "ses_00000000-0000-7000-8000-000000000001"),
    neutralSocketPath("", { key: "k", incarnation: "i" }),
  ]);
  for (const path of shortest) {
    expect(Buffer.byteLength(path)).toBe(Buffer.byteLength(hostSocket));
  }
});

test("the durable half of a session is under the home, never under the socket root", () => {
  // The socket root is swept at reboot and by tmp_cleaner, so what is named under it must be
  // expendable. Sockets are; a recovery record, a journal and a checkpoint are not.
  const home = "/some/persistent/home";
  const socketRoot = "/private/tmp/hvs-0123456789";
  const durable = withSocketRoot(socketRoot, () => [
    hostDirectory(home, LONGEST_SESSION_ID),
    neutralDirectory(home, LONGEST_NEUTRAL_SESSION),
  ]);
  for (const path of durable) {
    expect(path.startsWith(`${home}/`)).toBe(true);
    expect(path.startsWith(socketRoot)).toBe(false);
  }
  // Positive control: the same reader does find the socket under the socket root, so the absence
  // above is a real separation rather than a call that answers about nothing.
  expect(
    withSocketRoot(socketRoot, () =>
      hostSocketPath(home, LONGEST_SESSION_ID),
    ).startsWith(`${socketRoot}/`),
  ).toBe(true);
});

test("the bounded test root leaves room for production session sockets", () => {
  const root = process.env.HIVE_TEST_ROOT;
  expect(root).toBeString();
  const longest = withSocketRoot(root as string, () => [
    hostSocketPath("", LONGEST_SESSION_ID),
    neutralSocketPath("", LONGEST_NEUTRAL_SESSION),
  ]);
  for (const path of longest) {
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(SUN_PATH_LIMIT);
  }
});

test("the native gate routes its Bun tests through the bounded runner", () => {
  const script = readFileSync(
    join(import.meta.dir, "..", "native", "sessiond", "test.sh"),
    "utf8",
  );
  expect(script).toContain('bun run "$ROOT/scripts/test-sandbox.ts" --');
  expect(script).toContain(
    "bun test ./native/sessiond/test/identity-parity.ts ./native/sessiond/test/ts-live-create.ts",
  );
  expect(script).not.toMatch(/^bun test \.\/native\/sessiond\/test\//m);
});

test("the ordinary gate does not rerun the destructive sandbox self-test", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(manifest.scripts.test).not.toContain("--self-test");
  expect(manifest.scripts["test:sandbox:self-test"]).toContain("--self-test");
});

test("the ordinary gate emits that the sessiond leg did not run", () => {
  const root = process.env.HIVE_TEST_ROOT;
  expect(root).toBeString();
  const fixture = mkdtempSync(join(root as string, "test-gate-output-"));
  const fakeBin = join(fixture, "bin");
  const sessiondSentinel = join(fixture, "sessiond-ran");
  mkdirSync(fakeBin);
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  writeFileSync(
    join(fakeBin, "bun"),
    '#!/bin/sh\nif [ "$2" = "scripts/test-sandbox.ts" ]; then exit 7; fi\nif [ "$2" = "test:sessiond" ]; then : > "$HIVE_SESSIOND_SENTINEL"; exit 0; fi\nexit 99\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify({ scripts: { test: manifest.scripts.test } })}\n`,
  );

  try {
    const result = Bun.spawnSync([process.execPath, "run", "test"], {
      cwd: fixture,
      env: {
        ...process.env,
        HIVE_SESSIOND_SENTINEL: sessiondSentinel,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Buffer.concat([result.stdout, result.stderr]).toString();

    expect(result.exitCode).toBe(7);
    expect(output).toContain("sessiond leg DID NOT RUN");
    expect(existsSync(sessiondSentinel)).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
