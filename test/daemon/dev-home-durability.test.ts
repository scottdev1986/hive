// The dev daemon's state must outlive /tmp, and sessiond's sockets must still fit in a sun_path.
//
// These two requirements used to be one path, and the shorter one won: HIVE_HOME sat in /tmp so
// that host sockets named inside it stayed under macOS's 103-byte AF_UNIX limit, which put hive.db
// — the board's only store — on a filesystem the OS reclaims at boot and sweeps daily. The tests
// here hold the two apart: the home is proved persistent, the socket is proved short by
// measurement rather than estimate, and the database is proved to survive losing the whole socket
// tree. Nothing Hive resolves lands in /tmp any more, sockets included, which is why the byte
// measurement is now split — the part after the root is Hive's and fixed at eleven bytes, and the
// root itself is the operator's home and its length is theirs.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { runCommand } from "../../src/adapters/graphify";
import {
  runUninstallMachine,
  type UninstallDeps,
} from "../../src/cli/uninstall";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { namedInstanceHome } from "../../src/daemon/lifecycle/instances";
import {
  hostDirectory,
  hostSocketPath,
  neutralSocketPath,
} from "../../src/daemon/session-host/host-operations";
import {
  databaseIdentityPath,
  defaultHiveHome,
  getDatabasePath,
  getHiveHome,
  hiveInstanceSuffix,
  sessiondRuntimeRoot,
} from "../../src/hive-home/home";
import { resolveVariant } from "../../src/hive-home/variant";
import { tempRoot } from "../temp-root";

/** macOS `sun_path` is 104 bytes including the terminator, so a bindable path is at most 103. */
const SUN_PATH_LIMIT = 103;

/** The longest name a session directory can take: `ses_` and a 36-character uuid. */
const LONGEST_SESSION_ID = `ses_${"0".repeat(36)}`;

/** The longest name a neutral directory can take: `nh-` and a base64url-encoded sha-256 digest. */
const LONGEST_NEUTRAL_SESSION = {
  key: "0".repeat(64),
  incarnation: "0".repeat(64),
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Splits `$(...)` out of a make value, respecting nesting so a `$(shell ...)` containing its own references comes back whole. Returns the text before the reference, the reference body, and the text after. */
function nextReference(
  value: string,
): { before: string; body: string; after: string } | null {
  const start = value.indexOf("$(");
  if (start < 0) return null;
  let depth = 0;
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          before: value.slice(0, start),
          body: value.slice(start + 2, index),
          after: value.slice(index + 1),
        };
      }
    }
  }
  return null;
}

/** The dev daemon's home is decided in the Makefile, so that is what these tests read rather than a copy of its spelling. `expanded` resolves values the way make does — `$(shell ...)` really runs, because the paths under test are built from shasum output and asserting on unevaluated text would prove nothing about where the daemon lands. `literal` keeps the unexpanded right-hand side, which is the only place a claim about the *spelling* can be made: the test sandbox moves `$HOME`, so an expanded value says nothing about whether the author wrote a tmp path or a home-relative one. */
function makefileVariables(): {
  expanded: Record<string, string>;
  literal: Record<string, string>;
} {
  const source = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
  const literals: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const assignment = /^([A-Z_]+) :?\??= (.+)$/.exec(line);
    if (assignment === null) continue;
    literals[assignment[1] as string] = assignment[2] as string;
  }
  const expand = (value: string): string => {
    const reference = nextReference(value);
    if (reference === null) return value;
    const body = expand(reference.body);
    let replacement: string;
    if (body.startsWith("shell ")) {
      replacement = Bun.spawnSync(
        ["/bin/sh", "-c", body.slice("shell ".length)],
        {
          cwd: REPO_ROOT,
        },
      )
        .stdout.toString()
        .trim();
    } else if (body === "HOME") replacement = homedir();
    else if (body === "CURDIR" || body === "ROOT") replacement = REPO_ROOT;
    else replacement = expand(literals[body] ?? `$(${body})`);
    return `${reference.before}${replacement}${expand(reference.after)}`;
  };
  return {
    expanded: Object.fromEntries(
      Object.entries(literals).map(([name, value]) => [name, expand(value)]),
    ),
    literal: literals,
  };
}

/** The Makefile spells the machine home as `$(HOME)/.hive`, so a comparison against `defaultHiveHome` only means anything while HIVE_DEFAULT_HOME is unset — with it set, the two sides answer about different installs and the assertion turns into noise about whichever test file ran before this one. */
function machineHomeFromEnvironmentHome(): Disposable {
  const previous = process.env.HIVE_DEFAULT_HOME;
  delete process.env.HIVE_DEFAULT_HOME;
  return {
    [Symbol.dispose]() {
      if (previous !== undefined) process.env.HIVE_DEFAULT_HOME = previous;
    },
  };
}

describe("the dev daemon's home survives /tmp", () => {
  test("the Makefile puts HIVE_HOME on the persistent volume, as a named instance", () => {
    using _ = machineHomeFromEnvironmentHome();
    const { expanded, literal } = makefileVariables();

    // Positive control for the reader: the same parse reads a second root and finds a real value
    // there, so DEV_HOME naming no tmp path below is a real absence rather than a parse that saw
    // nothing. This used to anchor on the sessiond root starting with /tmp/, which was the last
    // Hive path in /tmp and is not there any more — the control had to move to something that
    // still exists rather than be deleted with what it happened to be pointing at.
    expect(literal.INSTALL_ROOT).toBe("$(DEV)/root");

    expect(literal.DEV_HOME).not.toInclude("/tmp");
    expect(literal.DEV_HOME).not.toInclude("/var/folders");
    // Not a fourth home layout: exactly what `hive --instance dev-<tag>` would resolve to.
    const devHome = expanded.DEV_HOME as string;
    const tag = devHome.slice(devHome.lastIndexOf("/dev-") + 1);
    expect(devHome).toBe(namedInstanceHome(tag));
  });

  test("every socket sessiond binds fits inside sun_path, measured", () => {
    // The dev root the Makefile names, which is where dev's sockets are really bound. It no
    // longer needs the /tmp-to-/private/tmp correction that used to cost eight unbudgeted bytes
    // here: the home is not reached through a symlink the way /tmp was.
    const devHome = makefileVariables().expanded.DEV_HOME as string;
    const canonicalRoot = resolveVariant(devHome).socketRoot;
    const previous = process.env.HIVE_SESSIOND_ROOT;
    process.env.HIVE_SESSIOND_ROOT = canonicalRoot;
    try {
      // A socket is no longer named inside the session's own directory: that directory holds the
      // durable state and lives under the home, while the socket is bound under this root as
      // `<8 hex>.s`. Ask for the socket paths themselves — joining a leaf onto the state directory
      // would measure a path nothing binds.
      const hostSocket = hostSocketPath("", LONGEST_SESSION_ID);
      const neutralSocket = neutralSocketPath("", LONGEST_NEUTRAL_SESSION);
      // What is fixed is the cost AFTER the root: one separator and a ten-byte name, for both
      // kinds, because each name is a digest of fixed width. The root itself is no longer a
      // constant — it lives under the machine home now, so its length is the operator's, and this
      // sandbox deliberately runs under a different HOME than the developer does. Asserting a
      // whole-path constant here would assert the runner's home, which is why the measurement
      // below is split into the part Hive owns and the part it does not.
      const rootBytes = Buffer.byteLength(canonicalRoot);
      expect(Buffer.byteLength(hostSocket) - rootBytes).toBe(11);
      expect(Buffer.byteLength(neutralSocket) - rootBytes).toBe(11);
      expect(Buffer.byteLength(hostSocket)).toBeLessThanOrEqual(SUN_PATH_LIMIT);
      expect(Buffer.byteLength(neutralSocket)).toBeLessThanOrEqual(
        SUN_PATH_LIMIT,
      );
    } finally {
      if (previous === undefined) delete process.env.HIVE_SESSIOND_ROOT;
      else process.env.HIVE_SESSIOND_ROOT = previous;
    }
  });

  test("clean-all's purge destroys the identity marker and socket root the variant record names", async () => {
    // The Makefile derives the dev home's tag from this checkout's path. Only the tag is taken
    // from it: the expanded value points at the live dev home when this file runs outside the
    // sandbox, and a purge there would destroy the running board, so the home under test is
    // rebuilt with the same tag under a scratch machine home. What clean-all must destroy is then
    // read off the variant record, which is the one owner of where the marker and socket root live.
    const tag = basename(makefileVariables().expanded.DEV_HOME as string);
    const root = tempRoot("hive-purge-durability-");
    const machineHome = join(root, "machine");
    const devHome = join(machineHome, "instances", tag);
    const previous = {
      home: process.env.HIVE_HOME,
      defaultHome: process.env.HIVE_DEFAULT_HOME,
      variant: process.env.HIVE_BUILD_VARIANT,
      sessiondRoot: process.env.HIVE_SESSIOND_ROOT,
    };
    process.env.HIVE_HOME = devHome;
    process.env.HIVE_DEFAULT_HOME = machineHome;
    process.env.HIVE_BUILD_VARIANT = "dev";
    delete process.env.HIVE_SESSIOND_ROOT;
    try {
      const config = resolveVariant();
      expect(config.home).toBe(devHome);
      expect(config.variant).toBe("dev");
      // The marker sits outside the home precisely so it survives the home's deletion — which is
      // why clearing the home cannot reach it and the purge has to.
      expect(config.databaseIdentityPath.startsWith(`${devHome}/`)).toBe(false);

      mkdirSync(devHome, { recursive: true });
      writeFileSync(join(devHome, "hive.db"), "");
      mkdirSync(join(machineHome, "db-identity"), { recursive: true });
      writeFileSync(config.databaseIdentityPath, "identity\n");
      mkdirSync(config.socketRoot, { recursive: true });
      writeFileSync(join(config.socketRoot, "0123abcd.s"), "");

      const deps: UninstallDeps = {
        run: runCommand,
        confirm: async () => null,
        log: () => {},
        stopCurrentInstance: async () => {},
        currentInstanceOwnsProject: async () => false,
        settleCurrentProject: async () => ({}),
        liveTeams: async () => [],
        stopInstances: async () => {},
        acquireLease: async () => ({ release: () => {} }),
        cwd: tmpdir(),
      };
      expect(await runUninstallMachine({ yes: true, purge: true }, deps)).toBe(
        0,
      );

      expect(existsSync(devHome)).toBe(false);
      expect(existsSync(config.databaseIdentityPath)).toBe(false);
      expect(existsSync(config.socketRoot)).toBe(false);
      expect(existsSync(config.sessiondStateRoot)).toBe(false);
    } finally {
      for (const [name, value] of [
        ["HIVE_HOME", previous.home],
        ["HIVE_DEFAULT_HOME", previous.defaultHome],
        ["HIVE_BUILD_VARIANT", previous.variant],
        ["HIVE_SESSIOND_ROOT", previous.sessiondRoot],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("the machine home this install actually has leaves the sockets bindable", () => {
    using _ = machineHomeFromEnvironmentHome();
    const previous = process.env.HIVE_SESSIOND_ROOT;
    delete process.env.HIVE_SESSIOND_ROOT;
    try {
      // The real one, not a fixture: moving the socket root under $HOME bought a literally-true
      // "no Hive path in /tmp" and charged for it in bytes that belong to the operator, so the
      // charge is measured against the home this machine has rather than assumed affordable.
      const longest = Buffer.byteLength(
        hostSocketPath(defaultHiveHome(), LONGEST_SESSION_ID),
      );
      expect(longest).toBeLessThanOrEqual(SUN_PATH_LIMIT);

      // The ceiling, stated as the number an operator can act on. Everything after the machine
      // home is Hive's and fixed: `/.hive` + `/run` + `/<10 hex>` + `/<8 hex>.s` = 32 bytes, so a
      // home longer than 71 bytes cannot hold a bindable socket no matter what Hive does. Under
      // /tmp this case did not exist; it is the price of the move and it is worth naming, because
      // the alternative is a bind failing as NameTooLong deep inside a host boot.
      const homeBytes = Buffer.byteLength(defaultHiveHome()) - "/.hive".length;
      expect(longest - homeBytes).toBe(32);
      expect(SUN_PATH_LIMIT - 32).toBe(71);

      // One install keeps one socket tree however many instances it has: a named instance's
      // sockets are bound under the MACHINE home, not under the instance home. Spelling it the
      // other way still resolves and still avoids /tmp, so nothing above would notice — the cost
      // is that a dev instance nested three directories deeper spends those bytes on every socket
      // it binds, for a per-instance tree the ten-hex suffix already separates.
      expect(sessiondRuntimeRoot(namedInstanceHome("dev-0123456789"))).toBe(
        join(
          defaultHiveHome(),
          "run",
          hiveInstanceSuffix(namedInstanceHome("dev-0123456789")),
        ),
      );
    } finally {
      if (previous !== undefined) process.env.HIVE_SESSIOND_ROOT = previous;
    }
  });

  test("losing the whole socket root leaves the database, its marker and the durable session state intact", () => {
    const root = tempRoot("hive-tmp-wipe-");
    const machineHome = join(root, "machine");
    const instanceHome = join(machineHome, "instances", "dev-0123456789");
    const sessiondRoot = join(root, "sd");
    const previous = {
      home: process.env.HIVE_HOME,
      defaultHome: process.env.HIVE_DEFAULT_HOME,
      sessiondRoot: process.env.HIVE_SESSIOND_ROOT,
    };
    process.env.HIVE_DEFAULT_HOME = machineHome;
    process.env.HIVE_HOME = instanceHome;
    process.env.HIVE_SESSIOND_ROOT = sessiondRoot;
    try {
      const markerPath = databaseIdentityPath();
      // The marker exists to notice a database that vanished and came back empty, so it must not
      // be inside the directory whose loss it reports.
      expect(markerPath).toBe(
        join(machineHome, "db-identity", hiveInstanceSuffix(instanceHome)),
      );
      expect(resolve(markerPath).startsWith(`${resolve(instanceHome)}/`)).toBe(
        false,
      );

      const database = new HiveDatabase();
      database.insertAgent({
        id: "agent-maya",
        name: "maya",
        tool: "codex",
        model: "gpt-5-codex",
        category: "simple_coding",
        status: "working",
        taskDescription: "Build the daemon",
        worktreePath: join(root, "worktree"),
        branch: "hive/maya-daemon",
        contextPct: 12,
        createdAt: "2026-08-14T00:00:00.000Z",
        lastEventAt: "2026-08-14T00:00:00.000Z",
        capabilityEpoch: 0,
        readOnly: false,
        writeRevoked: false,
      });
      database.close();
      const identityBeforeWipe = readFileSync(markerPath, "utf8");

      // The durable half of a session, which the socket root no longer holds: a record under the
      // state root, where a wipe of the socket tree cannot reach it.
      const hostState = hostDirectory(instanceHome, LONGEST_SESSION_ID);
      mkdirSync(hostState, { recursive: true });
      writeFileSync(join(hostState, "record.json"), "{}");

      // The wipe: the whole socket root, gone, exactly as an unclean shutdown or a manual clear
      // leaves it. Only sockets are named under here, and a socket is expendable by construction —
      // it is meaningless once the process that bound it is gone. This fixture is socket-shaped for
      // that reason: `hosts/<id>/record.json` used to sit in this tree, and asserting against that
      // shape would be asserting against a layout the code stopped using.
      mkdirSync(sessiondRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(sessiondRoot, "0123abcd.s"), "");
      rmSync(sessiondRoot, { recursive: true, force: true });
      expect(existsSync(sessiondRoot)).toBe(false);
      expect(sessiondRuntimeRoot()).toBe(sessiondRoot);

      // The split's whole point, and the half this test could not have covered before it: losing
      // every socket loses no durable state.
      expect(existsSync(join(hostState, "record.json"))).toBe(true);

      // The board is still there, and it is the same board: a recreated file would carry a
      // different identity and HiveDatabase would refuse it rather than answer with clean zeros.
      expect(existsSync(getDatabasePath())).toBe(true);
      expect(readFileSync(markerPath, "utf8")).toBe(identityBeforeWipe);
      const reopened = new HiveDatabase();
      try {
        expect(reopened.getAgentById("agent-maya")?.name).toBe("maya");
      } finally {
        reopened.close();
      }
    } finally {
      for (const [name, value] of [
        ["HIVE_HOME", previous.home],
        ["HIVE_DEFAULT_HOME", previous.defaultHome],
        ["HIVE_SESSIOND_ROOT", previous.sessiondRoot],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("no path this layout resolves lands in /tmp, including the sockets", () => {
    const previous = process.env.HIVE_SESSIOND_ROOT;
    delete process.env.HIVE_SESSIOND_ROOT;
    try {
      // This assertion used to say the opposite — that the socket root defaults INTO /tmp — and it
      // was right to, because a socket is worthless once the process that bound it is gone and the
      // tree it lived in was correct to lose at reboot. What changed is not that reasoning but the
      // arithmetic underneath it: the socket root had to be short, and short enough meant /tmp
      // until the per-session name shrank to ten bytes. The rule the owner actually asked for is
      // that Hive leaves nothing in /tmp, and the socket was the last thing standing.
      expect(sessiondRuntimeRoot("/some/persistent/home")).toBe(
        `/some/persistent/home/run/${hiveInstanceSuffix("/some/persistent/home")}`,
      );
      expect(sessiondRuntimeRoot("/some/persistent/home")).not.toStartWith(
        "/tmp/",
      );
      expect(getHiveHome()).not.toStartWith("/tmp/");
    } finally {
      if (previous === undefined) delete process.env.HIVE_SESSIOND_ROOT;
      else process.env.HIVE_SESSIOND_ROOT = previous;
    }
  });
});
