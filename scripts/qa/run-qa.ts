// The Hive QA runner: drives the installed QA Workspace app through the
// qa-control gate and verifies on the daemon's own MCP and HTTP clients. Run
// it against a live rig with `make qa-run` after `make qa`; it refuses any
// environment whose fences do not hold. Exit 0 = every row passed, 1 = a row
// measured a product failure, 2 = something could not be measured.
import { fileURLToPath } from "node:url";
import { HiveMcpSession } from "../../src/cli/mcp";
import { UserDaemonClient } from "../../src/cli/user-daemon-client";
import { readDaemonPort } from "../../src/daemon/lifecycle/daemon-lifecycle";
import {
  type Exec,
  type ExecResult,
  type ObserveClients,
  parseCredentialHeaders,
  runQA,
} from "./qa-runner";

const exec: Exec = async (argv): Promise<ExecResult> => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
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

async function buildObserve(qaBin: string): Promise<ObserveClients | null> {
  const port = readDaemonPort();
  if (port === null) return null;
  const credential = await exec([qaBin, "credential", "--agent", "user"]);
  if (credential.exitCode !== 0) return null;
  let headers: Record<string, string>;
  try {
    headers = parseCredentialHeaders(credential.stdout);
  } catch {
    return null;
  }
  const fetcher = authedFetch(headers);
  const mcp = new HiveMcpSession(port, fetcher);
  const http = new UserDaemonClient({ port, fetch: fetcher });
  return {
    httpStatus: async (path) => (await http.request(path)).status,
    httpJson: async (path) => {
      const response = await http.request(path);
      return { status: response.status, body: await response.json() };
    },
    mcpCall: async (name, args, key) => await mcp.call(name, args, key),
    close: async () => await mcp.close(),
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
