//! THROWAWAY PROBE (lucas, 2026-07-27): measures the sessiond broker's spawn
//! concurrency ceiling against the REAL serve loop, real sockets, real fork/exec
//! hosts — the same components the 20:35 sixteen-spawn collapse went through.
//!
//! Not a regression test: it boots a fresh broker per tier on a private short
//! HIVE_HOME, drives N concurrent daemon-role connections (HELLO [+ CREATE]),
//! and prints per-connection latencies as CSV. The client read timeout is the
//! daemon's own 10 s (`control_rpc_timeout_ms`), so a "timeout" row is exactly
//! what the daemon recorded as "sessiond HELLO request timed out".
//!
//! Modes:
//!   seq-create N   — N creates one at a time (baseline service time)
//!   burst-create N — N creates admitted simultaneously
//!   hello-storm N  — N simultaneous HELLO-only connections (per-RPC overhead)
//!   mix C H        — C creates + H HELLO-only connections simultaneously
const std = @import("std");
const broker = @import("broker");
const generated = @import("session_protocol_generated");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const session_host = @import("session_host");

const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

const instance_id = "instance-a";
const daemon_hello_json =
    \\{"schemaVersion":1,"buildId":"daemon-build","instanceId":"instance-a","protocol":{"major":1,"minMinor":0,"maxMinor":0},"clientRole":"daemon","daemonControl":{"productVersion":"0.0.0-dev","buildHash":"daemon-build","wireProtocol":{"min":1,"max":1},"schemaEpoch":1,"instanceId":"instance-a","hiveUuid":"hive-a","identityKey":"project-a","repoFamilyKey":"family-a"}}
;
const daemon_handshake_json =
    \\{"productVersion":"0.0.0-dev","buildHash":"daemon-build","wireProtocol":{"min":1,"max":1},"schemaEpoch":1,"capabilities":["daemon-handshake-v1"],"instanceId":"instance-a","hiveUuid":"hive-a","identityKey":"project-a","repoFamilyKey":"family-a","generation":1}
;
const create_commit_json =
    \\{"schemaVersion":1,"totalLength":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
;

const EmptyEnvironment = struct {};

const Outcome = enum { ok, timeout, wire_error, failure };

const Result = struct {
    index: usize = 0,
    is_create: bool = false,
    connect_ms: f64 = -1,
    welcome_ms: f64 = -1,
    op_ms: f64 = -1,
    outcome: Outcome = .failure,
    detail: [48]u8 = @splat(0),
    host_pid: i32 = 0,
    shell_pid: i32 = 0,
};

const HandshakeServer = struct {
    listener: std.net.Server,
    // Emulates the daemon's stalled HTTP surface: the broker fetches
    // GET /handshake on EVERY accepted connection, so this delay lands on
    // the serialized accept loop per connection.
    delay_ms: u64,

    fn run(self: *HandshakeServer) void {
        while (true) {
            var connection = self.listener.accept() catch return;
            defer connection.stream.close();
            var request_storage: [1024]u8 = undefined;
            _ = connection.stream.read(&request_storage) catch continue;
            if (self.delay_ms > 0) std.Thread.sleep(self.delay_ms * std.time.ns_per_ms);
            const response = std.fmt.allocPrint(
                std.heap.page_allocator,
                "HTTP/1.1 200 OK\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n{s}",
                .{ daemon_handshake_json.len, daemon_handshake_json },
            ) catch continue;
            defer std.heap.page_allocator.free(response);
            connection.stream.writeAll(response) catch continue;
        }
    }
};

fn nowMs(timer: *std.time.Timer) f64 {
    return @as(f64, @floatFromInt(timer.read())) / @as(f64, std.time.ns_per_ms);
}

fn setClientTimeout(fd: std.posix.fd_t) void {
    const millis = generated.limits.control_rpc_timeout_ms;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(millis / std.time.ms_per_s),
        .tv_usec = @intCast((millis % std.time.ms_per_s) * std.time.us_per_ms),
    };
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval));
}

fn writeFrame(stream: std.net.Stream, type_code: u16, request_id: u64, payload: []const u8) !void {
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = type_code,
        .flags = 0,
        .payload_length = @intCast(payload.len),
        .request_id = request_id,
        .stream_seq = 0,
    }, payload);
}

const ReadOutcome = union(enum) {
    frame: protocol.Frame,
    timeout,
    failed: []const u8,
};

fn readResponseFrame(allocator: std.mem.Allocator, stream: std.net.Stream) ReadOutcome {
    const file: std.fs.File = .{ .handle = stream.handle };
    const result = protocol.readFrame(allocator, file.deprecatedReader()) catch |err| {
        if (err == error.WouldBlock or err == error.Timeout) return .timeout;
        return .{ .failed = @errorName(err) };
    };
    return switch (result) {
        .frame => |frame| .{ .frame = frame },
        .failure => blk: {
            // Diagnose the bare close: is there anything readable at all?
            var probe: [1]u8 = undefined;
            const n = std.posix.read(stream.handle, &probe) catch |err|
                break :blk .{ .failed = @errorName(err) };
            if (n == 0) break :blk .{ .failed = "eof" };
            break :blk .{ .failed = "wire-failure-frame" };
        },
        .ignored_optional => .{ .failed = "ignored-optional" },
    };
}

fn noteDetail(result: *Result, text: []const u8) void {
    const count = @min(text.len, result.detail.len);
    @memcpy(result.detail[0..count], text[0..count]);
}

const ClientJob = struct {
    sock_path: []const u8,
    spec_json: []const u8, // empty for HELLO-only
    gate: *std.atomic.Value(u32),
    timer: *std.time.Timer,
    result: *Result,
};

fn runClient(job: *const ClientJob) void {
    const allocator = std.heap.page_allocator;
    var result = job.result;
    while (job.gate.load(.acquire) == 0) std.Thread.yield() catch {};

    const stream = std.net.connectUnixSocket(job.sock_path) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    defer stream.close();
    result.connect_ms = nowMs(job.timer);
    setClientTimeout(stream.handle);

    writeFrame(stream, generated.frame_type.hello, 1, daemon_hello_json) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    switch (readResponseFrame(allocator, stream)) {
        .timeout => {
            result.welcome_ms = generated.limits.control_rpc_timeout_ms;
            result.outcome = .timeout;
            noteDetail(result, "HELLO timeout");
            return;
        },
        .failed => |why| {
            noteDetail(result, why);
            return;
        },
        .frame => |frame| {
            var owned = frame;
            defer owned.deinit(allocator);
            result.welcome_ms = nowMs(job.timer);
            if (owned.header.type_code == generated.frame_type.@"error") {
                result.outcome = .wire_error;
                noteDetail(result, owned.payload);
                return;
            }
            if (owned.header.type_code != generated.frame_type.welcome) {
                noteDetail(result, "unexpected frame after HELLO");
                return;
            }
        },
    }

    if (job.spec_json.len == 0) {
        // HELLO-only probe: the WELCOME round trip IS the operation.
        result.op_ms = result.welcome_ms;
        result.outcome = .ok;
        return;
    }

    writeFrame(stream, generated.frame_type.create_begin, 2, job.spec_json) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    writeFrame(stream, generated.frame_type.create_commit, 3, create_commit_json) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    switch (readResponseFrame(allocator, stream)) {
        .timeout => {
            result.op_ms = generated.limits.control_rpc_timeout_ms;
            result.outcome = .timeout;
            noteDetail(result, "CREATE_COMMIT timeout");
            return;
        },
        .failed => |why| {
            noteDetail(result, why);
            return;
        },
        .frame => |frame| {
            var owned = frame;
            defer owned.deinit(allocator);
            result.op_ms = nowMs(job.timer);
            if (owned.header.type_code == generated.frame_type.@"error") {
                result.outcome = .wire_error;
                noteDetail(result, owned.payload);
                return;
            }
            if (owned.header.type_code != generated.frame_type.created) {
                noteDetail(result, "unexpected frame after CREATE_COMMIT");
                return;
            }
            const Projection = struct {
                inspection: struct {
                    hostPid: i32,
                    shellRoot: struct { pid: i32 },
                },
            };
            var parsed = std.json.parseFromSlice(Projection, allocator, owned.payload, .{
                .ignore_unknown_fields = true,
            }) catch {
                noteDetail(result, "created payload unparsable");
                return;
            };
            defer parsed.deinit();
            result.host_pid = parsed.value.inspection.hostPid;
            result.shell_pid = parsed.value.inspection.shellRoot.pid;
            result.outcome = .ok;
        },
    }
}

fn buildSpec(allocator: std.mem.Allocator, root: []const u8, engine_build_id: []const u8, index: usize, workspace_token: []const u8) ![]u8 {
    var session_storage: [41]u8 = undefined;
    const session = try std.fmt.bufPrint(&session_storage, "ses_00000000-7000-7000-8000-{d:0>12}", .{index});
    var agent_storage: [16]u8 = undefined;
    const agent = try std.fmt.bufPrint(&agent_storage, "probe{d:0>4}", .{index});
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = .{
            .schemaVersion = @as(u8, 1),
            .instanceId = instance_id,
            .subject = .{ .kind = "agent", .agentId = agent },
            .generation = @as(u64, 1),
            .sessionId = session,
            .hostKind = "sessiond",
            .engineBuildId = engine_build_id,
        },
        .provider = "codex",
        .toolSessionId = @as(?[]const u8, null),
        .cwd = root,
        .argv = [_][]const u8{ "/bin/sh", "-c", "sleep 30" },
        .environment = EmptyEnvironment{},
        .expectedExecutable = "/bin/sh",
        .readOnly = false,
        .capabilityEpoch = @as(u64, 0),
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
        .launchGrantId = "probe-launch-grant",
        .launchGrantRevision = @as(u64, 1),
        .visibility = .{
            .workspaceSessionId = "probe-workspace",
            .workspacePid = c.getpid(),
            .workspaceStartToken = workspace_token,
            .openTerminalRevision = "1",
        },
    }, .{});
}

/// Boots one real broker child on a fresh short home. Returns the child pid;
/// `sock_storage` receives broker.sock's path.
fn bootBroker(allocator: std.mem.Allocator, root: []const u8, sock_storage: []u8, delay_ms: u64) !struct { pid: i32, sock: []const u8 } {
    try std.fs.makeDirAbsolute(root);
    var home = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try home.chmod(0o700);
    home.close();
    const root_z = try allocator.dupeZ(u8, root);
    defer allocator.free(root_z);
    if (c.setenv("HIVE_HOME", root_z.ptr, 1) != 0) return error.SetEnvironmentFailed;

    // daemon.lock must describe THIS process: the broker authenticates every
    // connection's kernel peer (pid + start token + executable) against it.
    const observed = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.OwnIdentityUnavailable;
    var token_storage: [64]u8 = undefined;
    const token = try observed.start_token.format(&token_storage);
    var exe_storage: [std.fs.max_path_bytes]u8 = undefined;
    const exe = try std.fs.selfExePath(&exe_storage);
    const lock_json = try std.fmt.allocPrint(allocator,
        \\{{"pid":{d},"instanceId":"{s}","startedAt":"2026-07-27T00:00:00Z","startToken":"{s}","executablePath":"{s}"}}
    , .{ c.getpid(), instance_id, token, exe });
    defer allocator.free(lock_json);
    var home_dir = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    defer home_dir.close();
    try home_dir.writeFile(.{ .sub_path = "daemon.lock", .data = lock_json });

    const address = try std.net.Address.parseIp("127.0.0.1", 0);
    // Heap, never stack: the detached thread outlives this stack frame, and a
    // frame-local server gets silently overwritten by later calls (measured:
    // a few spec builds reused the frame and the accept loop read garbage).
    const handshake_server = try allocator.create(HandshakeServer);
    handshake_server.* = .{ .listener = try address.listen(.{}), .delay_ms = delay_ms };
    const port = handshake_server.listener.listen_address.in.getPort();
    const port_text = try std.fmt.allocPrint(allocator, "{d}", .{port});
    defer allocator.free(port_text);
    try home_dir.writeFile(.{ .sub_path = "daemon.port", .data = port_text });
    const handshake_thread = try std.Thread.spawn(.{}, HandshakeServer.run, .{handshake_server});
    handshake_thread.detach();

    const child_pid = try std.posix.fork();
    if (child_pid == 0) {
        var launcher = session_host.ProductionHostLauncher.init(allocator, root) catch
            c._exit(90);
        broker.serve(allocator, root, launcher.launcher()) catch |err| {
            std.debug.print("broker child failed: {s}\n", .{@errorName(err)});
            c._exit(91);
        };
        c._exit(0);
    }

    const sock = try std.fmt.bufPrint(sock_storage, "{s}/runtime/sessiond/broker.sock", .{root});
    var waited_ms: usize = 0;
    while (waited_ms < 10_000) : (waited_ms += 5) {
        std.fs.accessAbsolute(sock, .{}) catch {
            std.Thread.sleep(5 * std.time.ns_per_ms);
            continue;
        };
        break;
    }
    if (waited_ms >= 10_000) return error.BrokerSocketNeverAppeared;
    return .{ .pid = child_pid, .sock = sock };
}

fn reapTier(broker_pid: i32, results: []const Result) void {
    _ = c.kill(broker_pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(broker_pid, &status, 0);
    for (results) |result| {
        if (result.host_pid > 0) _ = c.kill(result.host_pid, c.SIGKILL);
        if (result.shell_pid > 0) _ = c.kill(result.shell_pid, c.SIGKILL);
    }
}

fn runTier(
    allocator: std.mem.Allocator,
    mode: []const u8,
    create_count: usize,
    hello_count: usize,
    engine_build_id: []const u8,
    workspace_token: []const u8,
    delay_ms: u64,
) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/c{x}", .{std.crypto.random.int(u32)});
    defer std.fs.deleteTreeAbsolute(root) catch {};

    var sock_storage: [256]u8 = undefined;
    const booted = try bootBroker(allocator, root, &sock_storage, delay_ms);
    const total = create_count + hello_count;
    const results = try allocator.alloc(Result, total);
    defer allocator.free(results);
    for (results, 0..) |*result, i| result.* = .{ .index = i, .is_create = i < create_count };
    defer reapTier(booted.pid, results);

    // Diagnostic seam: emulate the delay spec-building introduces between
    // broker boot and the first client connection.
    if (std.posix.getenv("CEILING_PRE_SLEEP_MS")) |text| {
        const ms = std.fmt.parseInt(u64, text, 10) catch 0;
        if (ms > 0) std.Thread.sleep(ms * std.time.ns_per_ms);
    }
    var timer = try std.time.Timer.start();
    var gate: std.atomic.Value(u32) = .init(0);
    const threads = try allocator.alloc(std.Thread, total);
    defer allocator.free(threads);
    const jobs = try allocator.alloc(ClientJob, total);
    defer allocator.free(jobs);
    const specs = try allocator.alloc(?[]u8, total);
    defer {
        for (specs) |maybe_spec| {
            if (maybe_spec) |spec| allocator.free(spec);
        }
        allocator.free(specs);
    }
    for (jobs, 0..) |*job, i| {
        specs[i] = if (i < create_count and std.posix.getenv("CEILING_SKIP_SPEC") == null)
            try buildSpec(allocator, root, engine_build_id, i, workspace_token)
        else
            null;
        job.* = .{
            .sock_path = booted.sock,
            .spec_json = specs[i] orelse "",
            .gate = &gate,
            .timer = &timer,
            .result = &results[i],
        };
    }

    if (std.mem.startsWith(u8, mode, "seq")) {
        // Baseline: one connection in flight at a time, no gate release race.
        for (jobs) |*job| {
            gate.store(0, .release);
            const thread = try std.Thread.spawn(.{}, runClient, .{job});
            gate.store(1, .release);
            thread.join();
        }
    } else {
        for (jobs, 0..) |*job, i| threads[i] = try std.Thread.spawn(.{}, runClient, .{job});
        gate.store(1, .release);
        for (threads) |thread| thread.join();
    }

    for (results) |result| {
        std.debug.print(
            "{s},creates={d},hellos={d},delay_ms={d},i={d},create={d},connect_ms={d:.1},welcome_ms={d:.1},op_ms={d:.1},outcome={s},host_pid={d},detail={s}\n",
            .{
                mode,
                create_count,
                hello_count,
                delay_ms,
                result.index,
                @intFromBool(result.is_create),
                result.connect_ms,
                result.welcome_ms,
                result.op_ms,
                @tagName(result.outcome),
                result.host_pid,
                std.mem.sliceTo(&result.detail, 0),
            },
        );
    }
}

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();

    var args = std.process.args();
    _ = args.next();
    const first = args.next() orelse return error.MissingMode;
    if (std.mem.eql(u8, first, "host")) {
        if (args.next() != null) return error.UnexpectedArgument;
        const hive_home = try std.process.getEnvVarOwned(allocator, "HIVE_HOME");
        defer allocator.free(hive_home);
        return session_host.runHostRole(allocator, hive_home);
    }

    // CLI: sessiond-spawn-ceiling <mode> <creates> <hellos> <delay_ms>
    // mode: burst-create | hello-storm | mix | seq-create | seq-hello
    const mode = first;
    const creates = try std.fmt.parseInt(usize, args.next() orelse "0", 10);
    const hellos = try std.fmt.parseInt(usize, args.next() orelse "0", 10);
    const delay_ms = try std.fmt.parseInt(u64, args.next() orelse "0", 10);
    if (args.next() != null) return error.UnexpectedArgument;

    const engine_digest = try session_host.RealVtEngine.engineBuildId();
    const engine_build_id = std.fmt.bytesToHex(engine_digest, .lower);
    const observed = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.OwnIdentityUnavailable;
    var token_storage: [64]u8 = undefined;
    const workspace_token = try observed.start_token.format(&token_storage);

    std.debug.print("mode,creates,hellos,delay_ms,i,is_create,connect_ms,welcome_ms,op_ms,outcome,host_pid,detail\n", .{});
    try runTier(allocator, mode, creates, hellos, &engine_build_id, workspace_token, delay_ms);
}
