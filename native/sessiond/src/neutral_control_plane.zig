//! Frozen A0 LIST/INSPECT/TERMINATE projection for the neutral host seam.
//!
//! Hive locator and visibility policy never crosses this module. Controller
//! operations address only an exact neutral SessionRef and preserve measured
//! partial/unavailable evidence when a live host cannot be reached.

const std = @import("std");
const generated = @import("session_protocol_generated");
const neutral_host = @import("neutral_host");
const process_inspector = @import("process_inspector");
const wall_clock = @import("wall_clock");
const neutral_evidence = @import("neutral_evidence");
const neutral_ops = @import("neutral_operations");

pub const Completeness = neutral_evidence.Completeness;
pub const WireProcessIdentity = neutral_evidence.WireProcessIdentity;
pub const WireWindowSize = neutral_evidence.WireWindowSize;
pub const WireJobControlEvidence = neutral_evidence.WireJobControlEvidence;
pub const WireExitStatus = neutral_evidence.WireExitStatus;
pub const WireReapEvidence = neutral_evidence.WireReapEvidence;
pub const WireCheckpoint = neutral_evidence.WireCheckpoint;
pub const WireInputClaim = neutral_evidence.WireInputClaim;
pub const WireSurvivor = neutral_evidence.WireSurvivor;
pub const WireInspection = neutral_evidence.WireInspection;
pub const WireInspectionPayload = neutral_evidence.WireInspectionPayload;
const InspectRequest = neutral_evidence.InspectRequest;
const TerminateRequest = neutral_evidence.TerminateRequest;
pub const WireAppliedResizePayload = neutral_evidence.WireAppliedResizePayload;
pub const WireStaleResizePayload = neutral_evidence.WireStaleResizePayload;
pub const WireUnknownResizePayload = neutral_evidence.WireUnknownResizePayload;
pub const AppliedResize = neutral_evidence.AppliedResize;
pub const TerminalResize = neutral_evidence.TerminalResize;
pub const TerminalProvider = neutral_evidence.TerminalProvider;
pub const WireTerminationResult = neutral_evidence.WireTerminationResult;
pub const WireTerminationPayload = neutral_evidence.WireTerminationPayload;
pub const CheckpointSnapshot = neutral_evidence.CheckpointSnapshot;
pub const LiveEvidence = neutral_evidence.LiveEvidence;
pub const EvidenceProvider = neutral_evidence.EvidenceProvider;
pub const EvidenceClock = neutral_evidence.EvidenceClock;
const makeCheckpoint = neutral_evidence.makeCheckpoint;
const buildInspection = neutral_evidence.buildInspection;
const canonicalTermination = neutral_evidence.canonicalTermination;
pub const HostOperations = neutral_ops.HostOperations;
pub const Controller = neutral_ops.Controller;

const c = @cImport({
    @cInclude("sys/wait.h");
    @cInclude("errno.h");
    @cInclude("signal.h");
    @cInclude("unistd.h");
});

test "RFC3339 system clock emits the frozen millisecond UTC shape" {
    var storage: [24]u8 = undefined;
    const value = try EvidenceClock.system().now(&storage);
    try std.testing.expectEqual(@as(usize, 24), value.len);
    try std.testing.expectEqual(@as(u8, 'T'), value[10]);
    try std.testing.expectEqual(@as(u8, '.'), value[19]);
    try std.testing.expectEqual(@as(u8, 'Z'), value[23]);
}

test "checkpoint projection preserves independent cursors and opaque bytes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const record: neutral_host.Record = .{
        .session = .{ .key = "checkpoint-proof", .incarnation = "one" },
        .createIdempotencyKey = "create-checkpoint-proof",
        .requestSha256 = @splat(0),
        .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
        .eventSequenceHighWater = 7,
        .output = .{ .retainedStart = 0, .retainedEndExclusive = 19, .closed = false },
        .checkpoints = .{
            .retained = 1,
            .newestThroughEventSequence = 7,
            .newestThroughOutputOffset = 19,
        },
    };
    const live: LiveEvidence = .{ .newestCheckpoint = .{
        .contentType = "application/vnd.hive.terminal-checkpoint",
        .schemaVersion = "proof-v1",
        .throughEventSequence = 7,
        .throughOutputOffset = 19,
        .opaqueBytes = "opaque-checkpoint",
    } };
    var diagnostics: std.ArrayList([]const u8) = .{};
    const checkpoint = (try makeCheckpoint(
        allocator,
        record,
        live,
        true,
        &diagnostics,
    )) orelse return error.CheckpointProjectionMissing;
    try std.testing.expectEqualStrings("7", checkpoint.throughEventSequence);
    try std.testing.expectEqualStrings("19", checkpoint.throughOutputOffset);
    const decoded_size = try std.base64.standard.Decoder.calcSizeForSlice(checkpoint.opaqueBytes);
    const decoded = try allocator.alloc(u8, decoded_size);
    try std.base64.standard.Decoder.decode(decoded, checkpoint.opaqueBytes);
    try std.testing.expectEqualStrings("opaque-checkpoint", decoded);
    try std.testing.expectEqual(@as(usize, 0), diagnostics.items.len);
}

test "inspection projects durable measured survivors from termination replay" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var real_platform = process_inspector.RealPlatform.init();
    const record: neutral_host.Record = .{
        .session = .{ .key = "survivor-proof", .incarnation = "one" },
        .createIdempotencyKey = "survivor-proof-create",
        .requestSha256 = @splat(0),
        .terminationIdempotencyKey = "survivor-proof-terminate",
        .terminationRequestSha256 = @splat(1),
        .terminationResultJson =
        \\{"schemaVersion":1,"state":"survivors","exit":null,"reap":{"authority":"unavailable","reaped":false,"status":null,"completeness":"unknown"},"survivors":[{"process":{"processId":42,"startToken":"1:2"},"reason":"still-running"}],"completeness":"partial","diagnostics":[]}
        ,
        .lifecycle = .unknown,
        .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    };
    const inspection = try buildInspection(
        arena.allocator(),
        record,
        real_platform.platform(),
        null,
        "2026-07-18T00:00:00.000Z",
        false,
        null,
        null,
    );
    try std.testing.expectEqual(@as(usize, 1), inspection.survivors.len);
    try std.testing.expectEqual(@as(i32, 42), inspection.survivors[0].process.processId);
    try std.testing.expectEqualStrings("still-running", inspection.survivors[0].reason);
}

test "create failure projects as lost unknown evidence" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var real_platform = process_inspector.RealPlatform.init();
    const record: neutral_host.Record = .{
        .session = .{ .key = "failed-create", .incarnation = "one" },
        .createIdempotencyKey = "failed-create-key",
        .requestSha256 = @splat(0),
        .lifecycle = .create_failed,
        .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    };
    const inspection = try buildInspection(
        arena.allocator(),
        record,
        real_platform.platform(),
        null,
        "2026-07-18T00:00:00.000Z",
        false,
        null,
        null,
    );
    try std.testing.expectEqual(
        @as(@FieldType(WireInspection, "lifecycle"), .lost),
        inspection.lifecycle,
    );
    try std.testing.expectEqual(Completeness.unknown, inspection.completeness);
    try std.testing.expect(inspection.diagnostics.len >= 1);
}

const ProofEvidence = struct {
    foregroundProcessGroupId: i32,
    oversizeCheckpoint: bool = false,

    fn measure(context: *anyopaque, allocator: std.mem.Allocator) !LiveEvidence {
        const self: *ProofEvidence = @ptrCast(@alignCast(context));
        const checkpoint = if (self.oversizeCheckpoint) blk: {
            const bytes = try allocator.alloc(u8, generated.limits.control_json_bytes);
            @memset(bytes, 'x');
            break :blk bytes;
        } else "real-proof-checkpoint";
        return .{
            .foregroundProcessGroupId = self.foregroundProcessGroupId,
            .newestCheckpoint = .{
                .contentType = "application/vnd.hive.terminal-checkpoint",
                .schemaVersion = "proof-v1",
                .throughEventSequence = 2,
                .throughOutputOffset = 9,
                .opaqueBytes = checkpoint,
            },
        };
    }

    fn provider(self: *ProofEvidence) EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }
};

fn spawnProofProcessTree() !i32 {
    const ready = try std.posix.pipe();
    const root = try std.posix.fork();
    if (root == 0) {
        std.posix.close(ready[0]);
        _ = c.setsid();
        const descendant = std.posix.fork() catch std.posix.exit(126);
        if (descendant == 0) {
            std.posix.close(ready[1]);
            const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
            const envp = [_:null]?[*:0]const u8{};
            _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
            std.posix.exit(127);
        }
        _ = std.posix.write(ready[1], "r") catch {};
        std.posix.close(ready[1]);
        const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
        const envp = [_:null]?[*:0]const u8{};
        _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(&envp));
        std.posix.exit(127);
    }
    std.posix.close(ready[1]);
    var byte: [1]u8 = undefined;
    const count = try std.posix.read(ready[0], &byte);
    std.posix.close(ready[0]);
    if (count != 1 or byte[0] != 'r') return error.ProofProcessNotReady;
    return root;
}

fn cleanupProofProcessTree(root: i32) void {
    if (root <= 1) return;
    _ = c.kill(-root, c.SIGKILL);
    _ = c.kill(root, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(root, &status, c.WNOHANG);
}

fn runProofHost(root: []const u8, session: neutral_host.SessionRef, ready_fd: std.posix.fd_t) !void {
    const allocator = std.heap.page_allocator;
    var runtime = try neutral_host.Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(allocator, &runtime);
    defer registry.deinit();

    const child_pid = try spawnProofProcessTree();
    defer cleanupProofProcessTree(child_pid);
    var child_identity: ?process_inspector.ProcessIdentity = null;
    var attempts: usize = 0;
    while (attempts < 100) : (attempts += 1) {
        child_identity = process_inspector.observeProcessPresent(child_pid);
        if (child_identity != null) break;
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    const child = child_identity orelse return error.ProofChildUnobservable;
    const host = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.ProofHostUnobservable;
    var host_token_storage: [64]u8 = undefined;
    const host_token = try host.start_token.format(&host_token_storage);
    var child_token_storage: [64]u8 = undefined;
    const child_token = try child.start_token.format(&child_token_storage);
    _ = try registry.register(session, .{
        .host = .{ .processId = host.pid, .startToken = host_token },
        .child = .{ .processId = child.pid, .startToken = child_token },
        .childSessionId = child.session,
        .childProcessGroupId = child.pgid,
        .foregroundProcessGroupId = child.pgid,
        .terminalIdentity = "proof-session-without-controlling-terminal",
        .sessionLeader = child.session == child.pid,
        .controllingTerminal = false,
        .standardStreamsShareTerminal = false,
        .initialProfileAppliedBeforeExec = false,
        .initialWindowAppliedBeforeExec = false,
        .window = .{ .columns = 100, .rows = 30, .widthPixels = 1000, .heightPixels = 600 },
    });
    _ = try registry.update(session, .{
        .eventSequenceHighWater = 2,
        .output = .{ .retainedStart = 0, .retainedEndExclusive = 9, .closed = false },
        .checkpoints = .{
            .retained = 1,
            .newestThroughEventSequence = 2,
            .newestThroughOutputOffset = 9,
        },
    });

    var endpoint = try neutral_host.HostEndpoint.open(allocator, &runtime, session);
    defer endpoint.deinit();
    var real_platform = process_inspector.RealPlatform.init();
    var evidence: ProofEvidence = .{
        .foregroundProcessGroupId = child.pgid,
        .oversizeCheckpoint = true,
    };
    var operations = try HostOperations.init(
        allocator,
        &registry,
        endpoint.session,
        real_platform.platform(),
        evidence.provider(),
        EvidenceClock.system(),
        null,
    );
    defer operations.deinit();

    var ready_storage: [32]u8 = undefined;
    const ready_message = try std.fmt.bufPrint(&ready_storage, "{d}\n", .{child_pid});
    if (try std.posix.write(ready_fd, ready_message) != ready_message.len)
        return error.ProofReadyWriteFailed;
    std.posix.close(ready_fd);
    try endpoint.serveOne(operations.handler());
    try endpoint.serveOne(operations.handler());
    try endpoint.serveOne(operations.handler());
}

test "live neutral session lists inspects and terminates with direct wait replay evidence" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const testing = std.testing;
    const allocator = testing.allocator;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/ncp-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try neutral_host.Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(allocator, &runtime);
    defer registry.deinit();
    var create_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("control-plane-live-proof", &create_digest, .{});
    const reserved = switch (try registry.reserve(
        "foreign://neutral/control-proof",
        "create-proof-1",
        create_digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedCreateReplay,
    };
    const session_key = try allocator.dupe(u8, reserved.session.key);
    defer allocator.free(session_key);
    const session_incarnation = try allocator.dupe(u8, reserved.session.incarnation);
    defer allocator.free(session_incarnation);
    const session: neutral_host.SessionRef = .{
        .key = session_key,
        .incarnation = session_incarnation,
    };

    const ready = try std.posix.pipe();
    const host_pid = try std.posix.fork();
    if (host_pid == 0) {
        std.posix.close(ready[0]);
        runProofHost(root, session, ready[1]) catch std.posix.exit(70);
        std.posix.exit(0);
    }
    std.posix.close(ready[1]);
    var host_owned = true;
    var proof_child: i32 = -1;
    defer if (host_owned) {
        if (proof_child > 1) {
            _ = c.kill(-proof_child, c.SIGKILL);
            _ = c.kill(proof_child, c.SIGKILL);
        }
        _ = c.kill(host_pid, c.SIGKILL);
        var status: c_int = 0;
        _ = c.waitpid(host_pid, &status, 0);
    };
    var ready_bytes: [32]u8 = undefined;
    var ready_length: usize = 0;
    while (ready_length < ready_bytes.len) {
        const count = try std.posix.read(ready[0], ready_bytes[ready_length..]);
        if (count == 0) break;
        ready_length += count;
        if (std.mem.indexOfScalar(u8, ready_bytes[0..ready_length], '\n') != null) break;
    }
    std.posix.close(ready[0]);
    proof_child = try std.fmt.parseInt(
        i32,
        std.mem.trim(u8, ready_bytes[0..ready_length], " \r\n\t"),
        10,
    );
    try registry.recover();
    var controller_platform = process_inspector.RealPlatform.init();
    var controller: Controller = .{
        .allocator = allocator,
        .registry = &registry,
        .platform = controller_platform.platform(),
        .clock = EvidenceClock.system(),
    };

    const inspect_request = try std.json.Stringify.valueAlloc(
        allocator,
        InspectRequest{ .schemaVersion = 1, .session = session },
        .{},
    );
    defer allocator.free(inspect_request);
    const inspected_bytes = try controller.inspect(inspect_request);
    defer allocator.free(inspected_bytes);
    var inspected = try std.json.parseFromSlice(WireInspectionPayload, allocator, inspected_bytes, .{});
    defer inspected.deinit();
    try testing.expectEqual(@as(u8, 1), inspected.value.schemaVersion);
    try testing.expectEqual(@as(@FieldType(WireInspection, "lifecycle"), .running), inspected.value.lifecycle);
    try testing.expect(inspected.value.jobControl != null);
    try testing.expect(inspected.value.descendants.len >= 1);
    try testing.expectEqual(@as(u32, 1), inspected.value.checkpoints.retained);
    try testing.expect(inspected.value.checkpoints.newest == null);
    try testing.expectEqual(Completeness.partial, inspected.value.completeness);
    var found_size_diagnostic = false;
    for (inspected.value.diagnostics) |diagnostic| {
        if (std.mem.eql(u8, diagnostic, "checkpoint-body-exceeds-control-frame"))
            found_size_diagnostic = true;
    }
    try testing.expect(found_size_diagnostic);
    try testing.expectEqual(@as(@FieldType(WireReapEvidence, "authority"), .@"direct-parent"), inspected.value.reap.authority);
    try testing.expect(!inspected.value.reap.reaped);

    const listed_bytes = try controller.list("{\"schemaVersion\":1}");
    defer allocator.free(listed_bytes);
    const Listed = struct { schemaVersion: u8, entries: []WireInspection };
    var listed = try std.json.parseFromSlice(Listed, allocator, listed_bytes, .{});
    defer listed.deinit();
    try testing.expectEqual(@as(u8, 1), listed.value.schemaVersion);
    try testing.expectEqual(@as(usize, 1), listed.value.entries.len);
    try testing.expect(listed.value.entries[0].session.eql(session));
    try testing.expectEqual(@as(u32, 1), listed.value.entries[0].checkpoints.retained);
    try testing.expect(listed.value.entries[0].checkpoints.newest == null);
    var listed_size_diagnostic = false;
    for (listed.value.entries[0].diagnostics) |diagnostic| {
        if (std.mem.eql(u8, diagnostic, "checkpoint-body-exceeds-control-frame"))
            listed_size_diagnostic = true;
    }
    try testing.expect(listed_size_diagnostic);

    const terminate_request: TerminateRequest = .{
        .schemaVersion = 1,
        .session = session,
        .mode = .immediate,
        .target = .@"process-tree",
        .deadline = "2099-01-01T00:00:00.000Z",
        .idempotencyKey = "terminate-proof-1",
    };
    const terminate_bytes = try std.json.Stringify.valueAlloc(allocator, terminate_request, .{});
    defer allocator.free(terminate_bytes);
    const terminated_bytes = try controller.terminate(terminate_bytes);
    defer allocator.free(terminated_bytes);
    var terminated = try std.json.parseFromSlice(
        WireTerminationPayload,
        allocator,
        terminated_bytes,
        .{},
    );
    defer terminated.deinit();
    try testing.expectEqual(@as(@FieldType(WireTerminationResult, "state"), .terminated), terminated.value.state);
    try testing.expectEqual(@as(@FieldType(WireReapEvidence, "authority"), .@"direct-parent"), terminated.value.reap.authority);
    try testing.expect(terminated.value.reap.reaped);
    try testing.expect(terminated.value.reap.status != null);
    try testing.expectEqual(@as(?i32, c.SIGKILL), terminated.value.reap.status.?.signal);
    try testing.expectEqual(Completeness.complete, terminated.value.completeness);
    try testing.expectEqual(@as(usize, 0), terminated.value.survivors.len);

    const replayed = try controller.terminate(terminate_bytes);
    defer allocator.free(replayed);
    try testing.expectEqualStrings(terminated_bytes, replayed);
    var conflict_request = terminate_request;
    conflict_request.target = .@"session-members";
    const conflict_bytes = try std.json.Stringify.valueAlloc(allocator, conflict_request, .{});
    defer allocator.free(conflict_bytes);
    try testing.expectError(error.TerminationConflict, controller.terminate(conflict_bytes));

    var host_status: c_int = 0;
    try testing.expectEqual(host_pid, c.waitpid(host_pid, &host_status, 0));
    host_owned = false;
    const host_status_bits: u32 = @bitCast(host_status);
    try testing.expect(std.posix.W.IFEXITED(host_status_bits));
    try testing.expectEqual(@as(u8, 0), std.posix.W.EXITSTATUS(host_status_bits));
    try registry.recover();
    const final = registry.get(session) orelse return error.FinalRecordMissing;
    try testing.expectEqual(neutral_host.Lifecycle.reaped, final.lifecycle);
    try testing.expect(final.reap != null and final.reap.?.reaped);
    try testing.expectEqual(
        @as(@FieldType(neutral_host.ReapEvidence, "authority"), .@"direct-parent"),
        final.reap.?.authority,
    );
    try testing.expect(final.terminationResultJson != null);
    try testing.expectEqualStrings(terminated_bytes, final.terminationResultJson.?);
    try testing.expect(switch (process_inspector.observeProcess(proof_child)) {
        .absent => true,
        .present, .unobservable => false,
    });
}

test "pending termination re-execution never signals a start-token-mismatched pid" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const testing = std.testing;
    const allocator = testing.allocator;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/npg-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try neutral_host.Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(allocator, &runtime);
    defer registry.deinit();
    var create_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("pending-guard-proof", &create_digest, .{});
    const window: neutral_host.WindowSize = .{
        .columns = 80,
        .rows = 24,
        .widthPixels = 800,
        .heightPixels = 480,
    };
    var real_platform = process_inspector.RealPlatform.init();

    // Session A: the recorded child identity is STALE — the recorded pid now
    // hosts an unrelated live process whose start token does not match the
    // record (PID reuse after the original child died mid-termination).
    const reserved_a = switch (try registry.reserve(
        "foreign://neutral/pending-guard-a",
        "create-pending-a",
        create_digest,
        window,
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedCreateReplay,
    };
    const session_a = reserved_a.session;
    // A Record borrows registry storage that register recycles, so the
    // session identity used across that mutation must be copied out first.
    const session_a_key = try allocator.dupe(u8, session_a.key);
    defer allocator.free(session_a_key);
    const session_a_incarnation = try allocator.dupe(u8, session_a.incarnation);
    defer allocator.free(session_a_incarnation);
    const stable_a: neutral_host.SessionRef = .{
        .key = session_a_key,
        .incarnation = session_a_incarnation,
    };
    const root_a = try spawnProofProcessTree();
    defer cleanupProofProcessTree(root_a);
    _ = try registry.register(session_a, .{
        .host = .{ .processId = c.getpid(), .startToken = "host-token" },
        // Fabricated but syntactically valid: parseStartToken accepts it and
        // the live process at root_a can never match it.
        .child = .{ .processId = root_a, .startToken = "1:1" },
        .childSessionId = root_a,
        .childProcessGroupId = root_a,
        .foregroundProcessGroupId = root_a,
        .terminalIdentity = "pending-guard-without-terminal",
        .sessionLeader = true,
        .controllingTerminal = false,
        .standardStreamsShareTerminal = false,
        .initialProfileAppliedBeforeExec = false,
        .initialWindowAppliedBeforeExec = false,
        .window = window,
    });
    const request_a: TerminateRequest = .{
        .schemaVersion = 1,
        .session = stable_a,
        .mode = .immediate,
        .target = .@"process-tree",
        .deadline = "2099-01-01T00:00:00.000Z",
        .idempotencyKey = "terminate-pending-a",
    };
    const canonical_a = try canonicalTermination(allocator, request_a);
    defer allocator.free(canonical_a.bytes);
    // Simulate the interrupted first attempt: the key is reserved but never
    // committed, so the retry below takes the .pending branch and re-executes
    // the full kill sequence against the recorded identity.
    switch (try registry.reserveTermination(
        stable_a,
        request_a.idempotencyKey,
        canonical_a.digest,
    )) {
        .reserved => {},
        .pending, .replay => return error.UnexpectedTerminationReservation,
    }
    var evidence_a: ProofEvidence = .{ .foregroundProcessGroupId = root_a };
    var operations_a = try HostOperations.init(
        allocator,
        &registry,
        stable_a,
        real_platform.platform(),
        evidence_a.provider(),
        EvidenceClock.system(),
        null,
    );
    defer operations_a.deinit();
    const response_a = try operations_a.handler().call(.{
        .session = stable_a,
        .operation = .terminate,
        .idempotencyKey = request_a.idempotencyKey,
        .payload = canonical_a.bytes,
    });
    try testing.expect(response_a.accepted);
    // The recorded identity is treated as gone (terminated from the ledger's
    // perspective)...
    var parsed_a = try std.json.parseFromSlice(
        WireTerminationPayload,
        allocator,
        response_a.payload,
        .{},
    );
    defer parsed_a.deinit();
    try testing.expectEqual(
        @as(@FieldType(WireTerminationResult, "state"), .terminated),
        parsed_a.value.state,
    );
    // ...but the token guard is the whole safety story for that re-execution:
    // the unrelated process now hosting the recorded pid received no signal.
    try testing.expect(process_inspector.observeProcessPresent(root_a) != null);

    // Positive control: with a matching start token the SAME pending
    // re-execution does signal the tree — the guard is selective, not a
    // blanket refusal to terminate on retry.
    const reserved_b = switch (try registry.reserve(
        "foreign://neutral/pending-guard-b",
        "create-pending-b",
        create_digest,
        window,
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedCreateReplay,
    };
    const session_b = reserved_b.session;
    const session_b_key = try allocator.dupe(u8, session_b.key);
    defer allocator.free(session_b_key);
    const session_b_incarnation = try allocator.dupe(u8, session_b.incarnation);
    defer allocator.free(session_b_incarnation);
    const stable_b: neutral_host.SessionRef = .{
        .key = session_b_key,
        .incarnation = session_b_incarnation,
    };
    const root_b = try spawnProofProcessTree();
    defer cleanupProofProcessTree(root_b);
    const identity_b = process_inspector.observeProcessPresent(root_b) orelse
        return error.ProofChildUnobservable;
    var token_b_storage: [64]u8 = undefined;
    const token_b = try identity_b.start_token.format(&token_b_storage);
    _ = try registry.register(session_b, .{
        .host = .{ .processId = c.getpid(), .startToken = "host-token" },
        .child = .{ .processId = root_b, .startToken = token_b },
        .childSessionId = root_b,
        .childProcessGroupId = root_b,
        .foregroundProcessGroupId = root_b,
        .terminalIdentity = "pending-guard-without-terminal",
        .sessionLeader = true,
        .controllingTerminal = false,
        .standardStreamsShareTerminal = false,
        .initialProfileAppliedBeforeExec = false,
        .initialWindowAppliedBeforeExec = false,
        .window = window,
    });
    const request_b: TerminateRequest = .{
        .schemaVersion = 1,
        .session = stable_b,
        .mode = .immediate,
        .target = .@"process-tree",
        .deadline = "2099-01-01T00:00:00.000Z",
        .idempotencyKey = "terminate-pending-b",
    };
    const canonical_b = try canonicalTermination(allocator, request_b);
    defer allocator.free(canonical_b.bytes);
    switch (try registry.reserveTermination(
        stable_b,
        request_b.idempotencyKey,
        canonical_b.digest,
    )) {
        .reserved => {},
        .pending, .replay => return error.UnexpectedTerminationReservation,
    }
    var evidence_b: ProofEvidence = .{ .foregroundProcessGroupId = root_b };
    var operations_b = try HostOperations.init(
        allocator,
        &registry,
        stable_b,
        real_platform.platform(),
        evidence_b.provider(),
        EvidenceClock.system(),
        null,
    );
    defer operations_b.deinit();
    const response_b = try operations_b.handler().call(.{
        .session = stable_b,
        .operation = .terminate,
        .idempotencyKey = request_b.idempotencyKey,
        .payload = canonical_b.bytes,
    });
    try testing.expect(response_b.accepted);
    try testing.expect(process_inspector.observeProcessPresent(root_b) == null);
}

test "controller inspect degrades when the host is unreachable but propagates allocation failure" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const testing = std.testing;
    const allocator = testing.allocator;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/noom-{x}", .{
        std.crypto.random.int(u64),
    });
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try neutral_host.Runtime.open(allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(allocator, &runtime);
    defer registry.deinit();
    var create_digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("inspect-oom-proof", &create_digest, .{});
    const reserved = switch (try registry.reserve(
        "foreign://neutral/inspect-oom",
        "create-inspect-oom",
        create_digest,
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    )) {
        .reserved => |record| record,
        .existing => return error.UnexpectedCreateReplay,
    };
    const session = reserved.session;
    // A Record borrows registry storage that register recycles, so the
    // session identity used across that mutation must be copied out first.
    const session_key = try allocator.dupe(u8, session.key);
    defer allocator.free(session_key);
    const session_incarnation = try allocator.dupe(u8, session.incarnation);
    defer allocator.free(session_incarnation);
    const stable_session: neutral_host.SessionRef = .{
        .key = session_key,
        .incarnation = session_incarnation,
    };
    // A host is registered but no endpoint is listening, so the live host
    // call fails with genuine host-unavailability evidence.
    _ = try registry.register(session, .{
        .host = .{ .processId = 11, .startToken = "host-start" },
        .child = .{ .processId = 12, .startToken = "child-start" },
        .childSessionId = 12,
        .childProcessGroupId = 12,
        .foregroundProcessGroupId = 12,
        .terminalIdentity = "/dev/ttys001",
        .sessionLeader = true,
        .controllingTerminal = true,
        .standardStreamsShareTerminal = true,
        .initialProfileAppliedBeforeExec = true,
        .initialWindowAppliedBeforeExec = true,
        .window = reserved.window,
    });
    const request_json = try std.json.Stringify.valueAlloc(
        allocator,
        InspectRequest{ .schemaVersion = 1, .session = stable_session },
        .{},
    );
    defer allocator.free(request_json);
    var real_platform = process_inspector.RealPlatform.init();

    // Host unreachable: the controller degrades to durable record evidence
    // carrying the unavailability diagnostic.
    var controller: Controller = .{
        .allocator = allocator,
        .registry = &registry,
        .platform = real_platform.platform(),
        .clock = EvidenceClock.system(),
    };
    const degraded = try controller.inspect(request_json);
    defer allocator.free(degraded);
    try testing.expect(
        std.mem.indexOf(u8, degraded, "neutral-host-control-unavailable") != null,
    );

    // Local allocation failure is not host unavailability: it must surface as
    // OutOfMemory instead of degrading into the fallback above. The failed
    // allocation is the session-identity copy the connection attempt makes
    // (registry.connect allocates from the registry's allocator) before any
    // socket I/O, while the controller's own allocator — the one the fallback
    // would use — stays healthy. Before the fix this same call returned the
    // degraded response.
    var failing: FailOnceAllocator = .{ .backing = allocator, .countdown = 0 };
    registry.allocator = failing.allocator();
    var failing_controller: Controller = .{
        .allocator = allocator,
        .registry = &registry,
        .platform = real_platform.platform(),
        .clock = EvidenceClock.system(),
    };
    try testing.expectError(error.OutOfMemory, failing_controller.inspect(request_json));
}

/// Fails exactly ONE allocation: the first `succeed` allocations succeed, the
/// next one returns null, and every allocation after that succeeds again.
/// std.testing.FailingAllocator fails every allocation from its index onward,
/// which cannot express "the host call fails but the fallback has memory".
/// A terminal that ACCEPTS every revision and reports a readback deliberately
/// unequal to the request. Both properties are load-bearing: a permissive
/// terminal is the only way to prove the control plane enforces the revision
/// order itself rather than inheriting pty_host's check, and a divergent
/// readback is the only way to tell a projection that reports what the terminal
/// said from one that echoes what it was asked for. A real terminal returns the
/// geometry it was given, so it cannot distinguish those two.
const DivergentTerminal = struct {
    ordered_at: u64 = 40,
    fail_with: ?anyerror = null,
    calls: usize = 0,
    /// When set, the terminal reports itself already at this revision instead
    /// of applying, exactly as a terminal does after a set whose commit failed.
    holds_revision: ?u64 = null,
    held_readback: ?neutral_host.WindowSize = null,
    applied_revision: ?u64 = null,

    fn resize(
        context: *anyopaque,
        window: neutral_host.WindowSize,
        revision: u64,
    ) anyerror!TerminalResize {
        const self: *DivergentTerminal = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (self.fail_with) |err| return err;
        const readback: neutral_host.WindowSize = .{
            .columns = window.columns - 1,
            .rows = window.rows - 1,
            .widthPixels = window.widthPixels,
            .heightPixels = window.heightPixels,
        };
        // Standing in for a terminal whose own order has already passed this
        // revision, which is what a set that outlived its failed commit leaves
        // behind. It answers with the order IT is in.
        if (self.holds_revision) |held| return .{ .superseded = .{
            .revision = held,
            .orderedAt = self.ordered_at,
            .readback = self.held_readback orelse readback,
        } };
        self.ordered_at += 1;
        self.applied_revision = revision;
        return .{ .applied = .{
            .revision = revision,
            .orderedAt = self.ordered_at,
            .readback = readback,
        } };
    }

    fn provider(self: *DivergentTerminal) TerminalProvider {
        return .{ .context = self, .resizeFn = resize };
    }
};

const SilentEvidence = struct {
    fn measure(_: *anyopaque, _: std.mem.Allocator) !LiveEvidence {
        return .{};
    }

    fn provider(self: *SilentEvidence) EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }
};

const ResizeProofFixture = struct {
    root_storage: [64]u8 = undefined,
    root: []const u8 = &.{},
    runtime: neutral_host.Runtime = undefined,
    registry: neutral_host.Registry = undefined,
    evidence: SilentEvidence = .{},
    operations: HostOperations = undefined,
    session: neutral_host.SessionRef = undefined,

    fn open(self: *ResizeProofFixture, allocator: std.mem.Allocator) !void {
        self.root = try std.fmt.bufPrint(&self.root_storage, "/tmp/ncpr-{x}", .{
            std.crypto.random.int(u64),
        });
        try std.fs.makeDirAbsolute(self.root);
        var directory = try std.fs.openDirAbsolute(self.root, .{ .no_follow = true });
        try directory.chmod(0o700);
        directory.close();
        self.runtime = try neutral_host.Runtime.open(allocator, self.root);
        self.registry = try neutral_host.Registry.open(allocator, &self.runtime);
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash("resize-proof", &digest, .{});
        const reserved = switch (try self.registry.reserve(
            "foreign://neutral/resize-proof",
            "create-resize-proof",
            digest,
            .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
        )) {
            .reserved => |record| record,
            .existing => return error.UnexpectedCreateReplay,
        };
        self.session = reserved.session;
        var platform = process_inspector.RealPlatform.init();
        self.operations = try HostOperations.init(
            allocator,
            &self.registry,
            self.session,
            platform.platform(),
            self.evidence.provider(),
            EvidenceClock.system(),
            null,
        );
        // The registry recycles record storage, so bind to the copy the
        // operations made rather than to the reserved record's slices.
        self.session = self.operations.session;
    }

    fn close(self: *ResizeProofFixture) void {
        self.operations.deinit();
        self.registry.deinit();
        self.runtime.deinit();
        std.fs.deleteTreeAbsolute(self.root) catch {};
    }

    fn request(
        self: *ResizeProofFixture,
        allocator: std.mem.Allocator,
        columns: u32,
        revision: []const u8,
    ) ![]u8 {
        return std.json.Stringify.valueAlloc(allocator, .{
            .schemaVersion = @as(u8, 1),
            .session = self.session,
            .window = .{
                .columns = columns,
                .rows = @as(u32, 24),
                .widthPixels = @as(u32, 800),
                .heightPixels = @as(u32, 480),
            },
            .revision = revision,
            .idempotencyKey = "resize-proof-key",
        }, .{});
    }

    fn call(self: *ResizeProofFixture, payload: []const u8) !neutral_host.OperationResponse {
        return self.operations.handler().call(.{
            .session = self.session,
            .operation = .resize,
            .idempotencyKey = "resize-proof-key",
            .payload = payload,
        });
    }
};

fn resizeState(allocator: std.mem.Allocator, payload: []const u8) ![]const u8 {
    const Projection = struct { state: []const u8 };
    const parsed = try std.json.parseFromSliceLeaky(Projection, allocator, payload, .{
        .ignore_unknown_fields = true,
    });
    return parsed.state;
}

test "neutral resize commits the terminal readback rather than the requested geometry" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var fixture: ResizeProofFixture = .{};
    try fixture.open(std.testing.allocator);
    defer fixture.close();
    var terminal: DivergentTerminal = .{};
    fixture.operations.terminal = terminal.provider();

    const response = try fixture.call(try fixture.request(allocator, 120, "3"));
    try std.testing.expect(response.accepted);
    const Applied = struct {
        state: []const u8,
        revision: []const u8,
        orderedAt: []const u8,
        readback: WireWindowSize,
        foregroundProcessObservation: []const u8,
    };
    const applied = try std.json.parseFromSliceLeaky(Applied, allocator, response.payload, .{
        .ignore_unknown_fields = true,
    });
    try std.testing.expectEqualStrings("applied", applied.state);
    try std.testing.expectEqualStrings("3", applied.revision);
    try std.testing.expectEqualStrings("41", applied.orderedAt);
    // The terminal reported 119x23 for a request of 120x24. The projection must
    // report what the terminal said.
    try std.testing.expectEqual(@as(u32, 119), applied.readback.columns);
    try std.testing.expectEqual(@as(u32, 23), applied.readback.rows);
    // And it must never claim the foreground application handled the change.
    try std.testing.expectEqualStrings("not-claimed", applied.foregroundProcessObservation);

    // A later inspection answers from the record, so the record must hold the
    // readback too, not the request.
    const record = fixture.registry.get(fixture.session) orelse return error.SessionMissing;
    try std.testing.expectEqual(@as(u64, 3), record.windowRevision);
    try std.testing.expectEqual(@as(u32, 119), record.window.columns);
    try std.testing.expectEqual(@as(u32, 23), record.window.rows);
}

test "neutral resize enforces the record's revision order against a permissive terminal" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var fixture: ResizeProofFixture = .{};
    try fixture.open(std.testing.allocator);
    defer fixture.close();
    var terminal: DivergentTerminal = .{};
    fixture.operations.terminal = terminal.provider();

    try std.testing.expectEqualStrings("applied", try resizeState(
        allocator,
        (try fixture.call(try fixture.request(allocator, 120, "5"))).payload,
    ));
    try std.testing.expectEqual(@as(usize, 1), terminal.calls);

    // This terminal would accept every one of these. Only the control plane's
    // own check can refuse them, and it must name the revision in force.
    for ([_][]const u8{ "5", "4", "0" }) |revision| {
        const response = try fixture.call(try fixture.request(allocator, 120, revision));
        const Stale = struct { state: []const u8, currentRevision: []const u8 };
        const stale = try std.json.parseFromSliceLeaky(Stale, allocator, response.payload, .{
            .ignore_unknown_fields = true,
        });
        try std.testing.expectEqualStrings("stale", stale.state);
        try std.testing.expectEqualStrings("5", stale.currentRevision);
    }
    // A superseded revision never reaches the terminal at all.
    try std.testing.expectEqual(@as(usize, 1), terminal.calls);
}

test "neutral resize reports an unusable terminal as unknown and mutates nothing" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var fixture: ResizeProofFixture = .{};
    try fixture.open(std.testing.allocator);
    defer fixture.close();

    // No terminal at all: the control plane does not own one, and must say so
    // rather than report a resize it cannot have applied.
    const absent = try fixture.call(try fixture.request(allocator, 120, "2"));
    try std.testing.expectEqualStrings("unknown", try resizeState(allocator, absent.payload));

    var terminal: DivergentTerminal = .{ .fail_with = error.IoFailed };
    fixture.operations.terminal = terminal.provider();
    const failed = try fixture.call(try fixture.request(allocator, 120, "2"));
    try std.testing.expectEqualStrings("unknown", try resizeState(allocator, failed.payload));

    // Neither outcome may leave the record claiming a revision was applied.
    const record = fixture.registry.get(fixture.session) orelse return error.SessionMissing;
    try std.testing.expectEqual(@as(u64, 0), record.windowRevision);

    // A terminal that reports its own supersession is a revision fact, not an
    // opaque failure, and the record is repaired to the order the terminal is
    // actually in rather than left behind admitting revisions it refuses.
    terminal.fail_with = null;
    terminal.holds_revision = 9;
    const superseded = try fixture.call(try fixture.request(allocator, 120, "2"));
    const Stale = struct { state: []const u8, currentRevision: []const u8 };
    const stale = try std.json.parseFromSliceLeaky(Stale, allocator, superseded.payload, .{
        .ignore_unknown_fields = true,
    });
    try std.testing.expectEqualStrings("stale", stale.state);
    try std.testing.expectEqualStrings("9", stale.currentRevision);
    const repaired = fixture.registry.get(fixture.session) orelse return error.SessionMissing;
    try std.testing.expectEqual(@as(u64, 9), repaired.windowRevision);
}

test "neutral resize reconciles a set whose commit never landed" {
    // owen's repro: the terminal applied revision 5 and the commit that should
    // have recorded it failed, leaving the record at 0. The retry used to pass
    // the stale record floor, be refused by the terminal, and be answered
    // `stale` with currentRevision "0" -- a revision in force NOWHERE, for a
    // resize that had in fact applied.
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var fixture: ResizeProofFixture = .{};
    try fixture.open(std.testing.allocator);
    defer fixture.close();
    var terminal: DivergentTerminal = .{
        .holds_revision = 5,
        .held_readback = .{ .columns = 119, .rows = 23, .widthPixels = 800, .heightPixels = 480 },
    };
    fixture.operations.terminal = terminal.provider();
    const record_before = fixture.registry.get(fixture.session) orelse return error.SessionMissing;
    try std.testing.expectEqual(@as(u64, 0), record_before.windowRevision);

    const response = try fixture.call(try fixture.request(allocator, 120, "5"));
    const Applied = struct {
        state: []const u8,
        revision: []const u8,
        readback: WireWindowSize,
    };
    const applied = try std.json.parseFromSliceLeaky(Applied, allocator, response.payload, .{
        .ignore_unknown_fields = true,
    });
    // The caller is owed the receipt it missed, not a refusal for a resize that
    // did apply.
    try std.testing.expectEqualStrings("applied", applied.state);
    try std.testing.expectEqualStrings("5", applied.revision);
    try std.testing.expectEqual(@as(u32, 119), applied.readback.columns);

    // And the record is repaired, so the floor no longer trails the terminal.
    const repaired = fixture.registry.get(fixture.session) orelse return error.SessionMissing;
    try std.testing.expectEqual(@as(u64, 5), repaired.windowRevision);
    try std.testing.expectEqual(@as(u32, 119), repaired.window.columns);

    // A terminal genuinely AHEAD of the request is still stale, and reports its
    // own number rather than the record's.
    terminal.holds_revision = 8;
    const ahead = try fixture.call(try fixture.request(allocator, 120, "6"));
    const Stale = struct { state: []const u8, currentRevision: []const u8 };
    const stale = try std.json.parseFromSliceLeaky(Stale, allocator, ahead.payload, .{
        .ignore_unknown_fields = true,
    });
    try std.testing.expectEqualStrings("stale", stale.state);
    try std.testing.expectEqualStrings("8", stale.currentRevision);
}

test "neutral resize is fenced by the session reference it names" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var fixture: ResizeProofFixture = .{};
    try fixture.open(std.testing.allocator);
    defer fixture.close();
    var terminal: DivergentTerminal = .{};
    fixture.operations.terminal = terminal.provider();

    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{ .key = fixture.session.key, .incarnation = "successor" },
        .window = .{
            .columns = @as(u32, 120),
            .rows = @as(u32, 24),
            .widthPixels = @as(u32, 800),
            .heightPixels = @as(u32, 480),
        },
        .revision = "9",
        .idempotencyKey = "resize-proof-key",
    }, .{});
    try std.testing.expectError(error.StaleSessionRef, fixture.operations.handler().call(.{
        .session = fixture.session,
        .operation = .resize,
        .idempotencyKey = "resize-proof-key",
        .payload = payload,
    }));
    try std.testing.expectEqual(@as(usize, 0), terminal.calls);
}

const FailOnceAllocator = struct {
    backing: std.mem.Allocator,
    countdown: usize,

    fn allocator(self: *FailOnceAllocator) std.mem.Allocator {
        return .{
            .ptr = self,
            .vtable = &.{
                .alloc = alloc,
                .resize = resize,
                .remap = remap,
                .free = free,
            },
        };
    }

    fn alloc(context: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
        const self: *FailOnceAllocator = @ptrCast(@alignCast(context));
        if (self.countdown == 0) return null;
        self.countdown -= 1;
        return self.backing.rawAlloc(len, alignment, ret_addr);
    }

    fn resize(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) bool {
        const self: *FailOnceAllocator = @ptrCast(@alignCast(context));
        return self.backing.rawResize(memory, alignment, new_len, ret_addr);
    }

    fn remap(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
        const self: *FailOnceAllocator = @ptrCast(@alignCast(context));
        return self.backing.rawRemap(memory, alignment, new_len, ret_addr);
    }

    fn free(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
        const self: *FailOnceAllocator = @ptrCast(@alignCast(context));
        self.backing.rawFree(memory, alignment, ret_addr);
    }
};
