import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type QAControlRequest =
  | { requestId: string; verb: "enumerate" }
  | { requestId: string; verb: "invoke"; identifier: string; input?: string };

export async function runQAControl(
  verb: "enumerate" | "invoke",
  identifier?: string,
  input?: string,
  timeoutMs = 5_000,
): Promise<number> {
  if (process.env.HIVE_QA !== "1") {
    process.stderr.write("NO MEASUREMENT: qa-control requires HIVE_QA=1\n");
    return 2;
  }
  const home = process.env.HIVE_DEFAULT_HOME;
  if (home === undefined || home.length === 0) {
    process.stderr.write(
      "NO MEASUREMENT: qa-control requires HIVE_DEFAULT_HOME\n",
    );
    return 2;
  }
  if (verb === "invoke" && identifier === undefined) {
    process.stderr.write("NO MEASUREMENT: invoke requires an identifier\n");
    return 2;
  }

  const directory = join(home, "qa-control");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const requestId = crypto.randomUUID();
  const request: QAControlRequest =
    verb === "enumerate"
      ? { requestId, verb }
      : {
          requestId,
          verb,
          identifier: identifier as string,
          ...(input === undefined ? {} : { input }),
        };
  const requestPath = join(directory, "request.json");
  const temporaryPath = join(directory, `request.${requestId}.tmp`);
  const responsePath = join(directory, `response.${requestId}.json`);
  writeFileSync(temporaryPath, JSON.stringify(request), { mode: 0o600 });
  renameSync(temporaryPath, requestPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(readFileSync(responsePath, "utf8")) as {
        requestId?: string;
        status?: "ok" | "fail";
        root?: string;
        count?: number;
        terminator?: string;
        reason?: string;
      };
      rmSync(responsePath, { force: true });
      if (
        response.requestId !== requestId ||
        response.root !== "hive-workspace-qa-root" ||
        response.count === undefined ||
        response.terminator !==
          `qa-control-end:${requestId}:${response.count}` ||
        (response.status !== "ok" && response.status !== "fail")
      ) {
        process.stderr.write("NO MEASUREMENT: invalid qa-control response\n");
        return 2;
      }
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return response.status === "ok" ? 0 : 1;
    } catch {
      await Bun.sleep(50);
    }
  }
  process.stderr.write("NO MEASUREMENT: Workspace did not answer qa-control\n");
  return 2;
}
