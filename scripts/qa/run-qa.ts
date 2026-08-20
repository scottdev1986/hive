// The Hive QA runner: drives the installed QA Workspace app through the
// qa-control gate and verifies on the daemon's own MCP and HTTP clients. Run
// it against a live rig with `make qa-run` after `make qa`; it refuses any
// environment whose fences do not hold. Exit 0 = every row passed, 1 = a row
// measured a product failure, 2 = something could not be measured.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HiveMcpSession } from "../../src/cli/mcp";
import { UserDaemonClient } from "../../src/cli/user-daemon-client";
import { readDaemonPort } from "../../src/daemon/lifecycle/daemon-lifecycle";
import { repoInstanceName } from "../../src/daemon/lifecycle/instances";
import { projectKey } from "../../src/daemon/project-identity-core/state";
import { hiveInstanceSuffix, instancesRoot } from "../../src/hive-home/home";
import {
  type Exec,
  type ExecResult,
  type ObserveClients,
  parseCredentialHeaders,
  runQA,
} from "./qa-runner";

const exec: Exec = async (argv, options): Promise<ExecResult> => {
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.env === undefined ? {} : { env: options.env }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function authedFetch(
  headers: Record<string, string>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) {
      if (!merged.has(name)) merged.set(name, value);
    }
    return fetch(input, { ...init, headers: merged });
  };
}

// The rig's daemon serves the QA project's per-repo instance, so its port and
// identity live under the instance home, not the machine home the pins name.
// Resolve the instance the same way the product resolves it for any repo:
// project key from the registry, then the repo-<key> instance.
async function buildObserve(
  qaBin: string,
  project: string,
): Promise<{ observe: ObserveClients; instanceHome: string } | null> {
  const instanceHome = join(
    instancesRoot(),
    repoInstanceName(projectKey(realpathSync(project))),
  );
  const port = readDaemonPort(instanceHome);
  if (port === null) return null;
  // The instance daemon mints its own user credential into the instance home;
  // the machine-home one is a different token and earns a 401.
  const credential = await exec([qaBin, "credential", "--agent", "user"], {
    env: { ...process.env, HIVE_HOME: instanceHome },
  });
  if (credential.exitCode !== 0) return null;
  let headers: Record<string, string>;
  try {
    headers = parseCredentialHeaders(credential.stdout);
  } catch {
    return null;
  }
  const fetcher = authedFetch(headers);
  const mcp = new HiveMcpSession(port, fetcher);
  const http = new UserDaemonClient({
    port,
    fetch: fetcher,
    instanceId: hiveInstanceSuffix(instanceHome),
  });
  return {
    instanceHome,
    observe: {
      httpStatus: async (path) => (await http.request(path)).status,
      httpJson: async (path) => {
        const response = await http.request(path);
        return { status: response.status, body: await response.json() };
      },
      mcpCall: async (name, args, key) => await mcp.call(name, args, key),
      close: async () => await mcp.close(),
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    process.stderr.write(
      `NO MEASUREMENT preflight fence runner-wiring: ${name} is not set; run via 'make qa-run'\n`,
    );
    process.exit(2);
  }
  return value;
}

const exitCode = await runQA({
  env: process.env,
  exec,
  rig: {
    repoRoot: required("HIVE_QA_RUNNER_REPO_ROOT"),
    stagingRoot: required("HIVE_QA_RUNNER_STAGING_ROOT"),
    devHome: required("HIVE_QA_RUNNER_DEV_HOME"),
    userHive: required("HIVE_QA_RUNNER_USER_HIVE"),
    project: required("HIVE_QA_RUNNER_PROJECT"),
  },
  validateIsolation: fileURLToPath(
    new URL("./validate-isolation.sh", import.meta.url),
  ),
  buildObserve,
  sleep: Bun.sleep,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exit(exitCode);
