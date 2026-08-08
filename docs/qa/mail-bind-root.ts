import { pathToFileURL } from "node:url";

const qaHome = process.env.HIVE_QA_HOME;
const src = process.env.HIVE_QA_SRC_ROOT;
const port = process.env.HIVE_QA_PORT;
const vendor = process.env.QA_VENDOR;
if (!qaHome || !src || !port || !vendor || process.env.HIVE_HOME !== qaHome) {
  throw new Error("the isolated rig environment is incomplete");
}

const credentialModule = await import(
  pathToFileURL(`${src}/src/cli/credential.ts`).href
);
const authorization = credentialModule.authorizationHeaders("queen");
if (!authorization) throw new Error("the QA queen credential is missing");
const response = await fetch(`http://127.0.0.1:${port}/orchestrator-session`, {
  method: "POST",
  headers: { ...authorization, "content-type": "application/json" },
  body: JSON.stringify({
    requestId: `req_${Bun.randomUUIDv7()}`,
    provider: vendor,
    cwd: process.env.HIVE_QA_PROJECT,
    argv: ["/bin/sleep", "600"],
    environment: {},
    expectedExecutable: "/bin/sleep",
  }),
});
const body = await response.json();
if (!response.ok || body.state !== "running") {
  throw new Error(`root binding failed (${response.status}): ${JSON.stringify(body)}`);
}
await Bun.write(`${qaHome}/artifacts/root-session.json`, `${JSON.stringify(body, null, 2)}\n`);
