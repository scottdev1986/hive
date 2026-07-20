#!/usr/bin/env bun
/**
 * Identify the LIVE broker by kernel evidence AT KILL TIME — never a remembered
 * pid. Connects to broker.sock and reads LOCAL_PEERPID, which is the kernel's
 * own answer to "which process is bound to this socket right now".
 *
 * Prints the pid on stdout, or exits non-zero with a reason. The caller must
 * still positive-control the identity (ps comm) before signalling anything.
 */
import { connect } from "node:net";
import { dlopen, FFIType } from "bun:ffi";

const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;

const sockPath = process.argv[2];
if (!sockPath) {
  console.error("usage: identify-broker.ts <broker.sock>");
  process.exit(2);
}

const libc = dlopen("libc.dylib", {
  getsockopt: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
});

const socket: any = await new Promise((resolve, reject) => {
  const s = connect(sockPath);
  const timer = setTimeout(() => {
    s.destroy();
    reject(new Error(`connect ${sockPath} timed out`));
  }, 2000);
  s.once("error", (e) => {
    clearTimeout(timer);
    reject(e);
  });
  s.once("connect", () => {
    clearTimeout(timer);
    resolve(s);
  });
});

const fd = socket._handle?.fd ?? socket.fd;
if (typeof fd !== "number" || fd < 0) {
  console.error("no usable fd for LOCAL_PEERPID");
  process.exit(3);
}

const peer = new Int32Array(1);
const len = new Uint32Array([4]);
const rc = libc.symbols.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, peer, len);
socket.destroy();

if (rc !== 0) {
  console.error(`getsockopt(LOCAL_PEERPID) returned ${rc}`);
  process.exit(4);
}
const pid = peer[0] ?? 0;
if (pid <= 0) {
  console.error(`invalid peer pid ${pid}`);
  process.exit(5);
}
console.log(String(pid));
