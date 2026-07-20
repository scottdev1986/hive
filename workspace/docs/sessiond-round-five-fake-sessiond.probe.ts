#!/usr/bin/env bun
/**
 * Fake hive-sessiond for henrietta's failure-route probe.
 *
 * Binds the REAL broker.sock (so the daemon's connect succeeds and the kernel
 * peer pid legitimately equals this child's pid — the peer gate PASSES), then
 * never speaks HELLO and never exits. This drives the ready-proof down the
 * HELLO-failure / ready-timeout route with the child still ALIVE at failure,
 * which is the route the orphan probe cannot reach.
 */
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const home = process.env.HIVE_HOME;
if (!home) {
  console.error("fake-sessiond: HIVE_HOME required");
  process.exit(2);
}
const dir = join(home, "runtime", "sessiond");
mkdirSync(dir, { recursive: true });
const sock = join(dir, "broker.sock");

const server = createServer(() => {
  // Accept the connection and hold it open. Never answer HELLO.
});
server.listen(sock, () => {
  console.error(`fake-sessiond: bound ${sock} as pid ${process.pid}, mute`);
});
// Stay alive indefinitely so the failure is a ready-timeout, not a child exit.
setInterval(() => {}, 1 << 30);
