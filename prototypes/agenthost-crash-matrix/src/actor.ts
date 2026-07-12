const role = process.argv[2] ?? "unknown";
process.title = `agenthost-matrix-${role}`;
process.stdout.write(`${JSON.stringify({ role, pid: process.pid, ready: true })}\n`);
setInterval(() => undefined, 60_000);
