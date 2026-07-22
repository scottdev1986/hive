const std = @import("std");
const neutral_host = @import("neutral_host");
const neutral_control_plane = @import("neutral_control_plane");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const pty_host = @import("pty_host");
const generated = @import("session_protocol_generated");

const c = @cImport({
    @cInclude("signal.h");
    @cInclude("sys/wait.h");
});

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();
    try neutral_host.proveLiveLifecycle(allocator);

    // Bind the two suites. neutral_host stays project-neutral and cannot see
    // the Hive wire schema; this layer imports both, so the create results the
    // host actually commits are validated against the schema generated from
    // src/schemas/session-protocol.ts. Without this the native side can be
    // green against its own shapes while disagreeing with the wire.
    const documents = try neutral_host.proveCreateResultDocuments(allocator);
    defer documents.deinit(allocator);
    for ([_][]const u8{ documents.running, documents.refused }) |document| {
        if (!protocol.validateControlPayload(
            allocator,
            generated.wire_schema.terminal_host_create_result,
            document,
        )) return error.CreateResultViolatesWireSchema;
    }

    try proveControllerCreate(allocator);
}

/// The frozen `create` handler, end to end and on the wire's terms: a request
/// document that the frozen request schema accepts goes in, a real replacement
/// is launched, and the result document is validated against the frozen result
/// schema. Both directions are checked here rather than in the control plane's
/// own tests because that module deliberately cannot see the Hive wire schema.
fn proveControllerCreate(allocator: std.mem.Allocator) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/ncc-{x}", .{
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
    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();
    var direct = neutral_host.DirectHost.init(allocator, &registry, &pty);
    defer direct.deinit();
    var platform = process_inspector.RealPlatform.init();
    var controller: neutral_control_plane.Controller = .{
        .allocator = allocator,
        .registry = &registry,
        .platform = platform.platform(),
        .clock = neutral_control_plane.EvidenceClock.system(),
        .host = direct.host(),
    };

    const request = try std.json.Stringify.valueAlloc(allocator, .{
        .key = "foreign://neutral/controller-create",
        .idempotencyKey = "controller-create-1",
        .command = .{
            .executable = "/bin/sh",
            .arguments = [_][]const u8{ "-c", "while :; do sleep 1; done" },
            .workingDirectory = "/",
            .completeEnvironment = [_]struct {
                name: []const u8,
                value: []const u8,
            }{.{ .name = "PATH", .value = "/usr/bin:/bin" }},
            .descriptorMap = [_]u0{},
        },
        .terminalProfile = .{
            .inputMode = "literal",
            .echo = false,
            .signalCharacters = false,
            .softwareFlowControl = false,
            .eofByte = @as(u8, 4),
            .startByte = @as(u8, 17),
            .stopByte = @as(u8, 19),
            .hangupOnLastClose = true,
        },
        .initialWindow = .{
            .columns = @as(u32, 80),
            .rows = @as(u32, 24),
            .widthPixels = @as(u32, 800),
            .heightPixels = @as(u32, 480),
        },
    }, .{});
    defer allocator.free(request);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.terminal_host_create_request,
        request,
    )) return error.CreateRequestViolatesWireSchema;

    const created = try controller.create(request);
    defer allocator.free(created);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.terminal_host_create_result,
        created,
    )) return error.CreateResultViolatesWireSchema;

    const Projection = struct {
        session: struct { key: []const u8, incarnation: []const u8 },
        outcome: struct {
            state: []const u8,
            child: ?struct { processId: i32 } = null,
        },
    };
    var parsed = try std.json.parseFromSlice(Projection, allocator, created, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.outcome.state, "running"))
        return error.ControllerCreateNotRunning;
    const child_pid = (parsed.value.outcome.child orelse
        return error.ControllerCreateMissingChild).processId;
    if (!std.mem.eql(u8, parsed.value.session.key, "foreign://neutral/controller-create"))
        return error.ControllerCreateWrongSession;

    // The same idempotency key must replay the committed document verbatim
    // rather than launching a second replacement.
    const replayed = try controller.create(request);
    defer allocator.free(replayed);
    if (!std.mem.eql(u8, created, replayed)) return error.ControllerCreateReplayDiverged;

    try proveResizeAgainstRealTerminal(allocator, &registry, &pty, platform.platform(), .{
        .key = parsed.value.session.key,
        .incarnation = parsed.value.session.incarnation,
    });

    _ = c.kill(child_pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(child_pid, &status, 0);
}

/// Binds the frozen `resize` handler to a REAL terminal and to the wire. The
/// geometry asserted is what the terminal reported through TIOCGWINSZ after the
/// set, so a projection that echoed the request instead of the readback cannot
/// pass here, and a superseded revision must come back as `stale` naming the
/// revision that superseded it rather than as an opaque refusal.
fn proveResizeAgainstRealTerminal(
    allocator: std.mem.Allocator,
    registry: *neutral_host.Registry,
    pty: *pty_host.PtyHost,
    platform: process_inspector.Platform,
    session: neutral_host.SessionRef,
) !void {
    var evidence: GoldenEvidence = .{};
    var operations = try neutral_control_plane.HostOperations.init(
        allocator,
        registry,
        session,
        platform,
        evidence.provider(),
        neutral_control_plane.EvidenceClock.system(),
    );
    defer operations.deinit();
    var terminal: PtyTerminal = .{ .pty = pty };
    operations.terminal = terminal.provider();

    const window = .{
        .columns = @as(u32, 132),
        .rows = @as(u32, 43),
        .widthPixels = @as(u32, 1320),
        .heightPixels = @as(u32, 860),
    };
    const request = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = session,
        .window = window,
        .revision = "7",
        .idempotencyKey = "controller-resize-1",
    }, .{});
    defer allocator.free(request);
    // The wire request carries no schemaVersion, so validate the frozen shape
    // the caller actually sends rather than the transport envelope.
    const wire_request = try std.json.Stringify.valueAlloc(allocator, .{
        .session = session,
        .window = window,
        .revision = "7",
        .idempotencyKey = "controller-resize-1",
    }, .{});
    defer allocator.free(wire_request);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.terminal_host_resize_request,
        wire_request,
    )) return error.ResizeRequestViolatesWireSchema;

    const applied = try operations.handler().call(.{
        .session = session,
        .operation = .resize,
        .idempotencyKey = "controller-resize-1",
        .payload = request,
    });
    if (!applied.accepted) return error.ResizeRejected;
    try validateResizeResult(allocator, applied.payload);

    const Applied = struct {
        state: []const u8,
        revision: []const u8,
        readback: struct { columns: u32, rows: u32 },
    };
    var parsed = try std.json.parseFromSlice(Applied, allocator, applied.payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.state, "applied")) return error.ResizeNotApplied;
    if (!std.mem.eql(u8, parsed.value.revision, "7")) return error.ResizeWrongRevision;
    if (parsed.value.readback.columns != window.columns or
        parsed.value.readback.rows != window.rows) return error.ResizeReadbackDiverged;

    // The durable record must now hold what the TERMINAL reported, because a
    // later inspection answers from it.
    const record = registry.get(session) orelse return error.ResizeSessionMissing;
    if (record.windowRevision != 7) return error.ResizeRevisionNotCommitted;
    if (record.window.columns != window.columns or record.window.rows != window.rows)
        return error.ResizeWindowNotCommitted;

    // Replaying the same revision is superseded, not applied twice.
    const stale = try operations.handler().call(.{
        .session = session,
        .operation = .resize,
        .idempotencyKey = "controller-resize-1",
        .payload = request,
    });
    if (!stale.accepted) return error.ResizeRejected;
    try validateResizeResult(allocator, stale.payload);
    const Stale = struct { state: []const u8, currentRevision: []const u8 };
    var stale_parsed = try std.json.parseFromSlice(Stale, allocator, stale.payload, .{
        .ignore_unknown_fields = true,
    });
    defer stale_parsed.deinit();
    if (!std.mem.eql(u8, stale_parsed.value.state, "stale")) return error.ResizeNotStale;
    if (!std.mem.eql(u8, stale_parsed.value.currentRevision, "7"))
        return error.ResizeStaleWrongRevision;
}

fn validateResizeResult(allocator: std.mem.Allocator, payload: []const u8) !void {
    // Strip the transport envelope: the frozen result schema is strict, and
    // schemaVersion belongs to the operation frame rather than the result.
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, payload, .{});
    defer parsed.deinit();
    _ = parsed.value.object.swapRemove("schemaVersion");
    const wire = try std.json.Stringify.valueAlloc(allocator, parsed.value, .{});
    defer allocator.free(wire);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.terminal_host_resize_result,
        wire,
    )) return error.ResizeResultViolatesWireSchema;
}

/// The real terminal behind the neutral seam. pty_host owns the ordered set and
/// the post-set readback; the control plane only projects what it returns.
const PtyTerminal = struct {
    pty: *pty_host.PtyHost,

    fn resize(
        context: *anyopaque,
        window: neutral_host.WindowSize,
        revision: u64,
    ) anyerror!neutral_control_plane.AppliedResize {
        const self: *PtyTerminal = @ptrCast(@alignCast(context));
        const receipt = try self.pty.resize(.{
            .columns = window.columns,
            .rows = window.rows,
            .width_px = window.widthPixels,
            .height_px = window.heightPixels,
        }, revision);
        return .{
            .revision = receipt.revision,
            .orderedAt = receipt.ordered_at,
            .readback = .{
                .columns = receipt.readback.columns,
                .rows = receipt.readback.rows,
                .widthPixels = receipt.readback.width_px,
                .heightPixels = receipt.readback.height_px,
            },
        };
    }

    fn provider(self: *PtyTerminal) neutral_control_plane.TerminalProvider {
        return .{ .context = self, .resizeFn = resize };
    }
};

const GoldenEvidence = struct {
    fn measure(_: *anyopaque, _: std.mem.Allocator) !neutral_control_plane.LiveEvidence {
        return .{};
    }

    fn provider(self: *GoldenEvidence) neutral_control_plane.EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }
};
