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

    try proveResizeOverTheRealRoute(allocator, &runtime, &registry, &pty, platform.platform(), .{
        .key = parsed.value.session.key,
        .incarnation = parsed.value.session.incarnation,
    });

    _ = c.kill(child_pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(child_pid, &status, 0);
}

/// Drives `resize` over the route the PRODUCT takes: Controller.resize, across
/// the neutral Client/Endpoint transport, into a HostOperations bound to a REAL
/// terminal. An earlier version of this proof called handler().call on a
/// hand-built operations object, which passed while the shipped host bound no
/// terminal at all and answered every resize `unknown` -- a golden that
/// hand-feeds the handler proves nothing about the wiring.
///
/// The geometry asserted is what the terminal reported through TIOCGWINSZ after
/// the set, so a projection that echoed the request cannot pass, and a
/// superseded revision comes back as `stale` naming the revision in force.
fn proveResizeOverTheRealRoute(
    allocator: std.mem.Allocator,
    runtime: *neutral_host.Runtime,
    registry: *neutral_host.Registry,
    pty: *pty_host.PtyHost,
    platform: process_inspector.Platform,
    session: neutral_host.SessionRef,
) !void {
    var endpoint = try neutral_host.HostEndpoint.open(allocator, runtime, session);
    defer endpoint.deinit();
    var evidence: GoldenEvidence = .{};
    var terminal: PtyTerminal = .{ .pty = pty };
    var operations = try neutral_control_plane.HostOperations.init(
        allocator,
        registry,
        endpoint.session,
        platform,
        evidence.provider(),
        neutral_control_plane.EvidenceClock.system(),
        terminal.provider(),
    );
    defer operations.deinit();
    var controller: neutral_control_plane.Controller = .{
        .allocator = allocator,
        .registry = registry,
        .platform = platform,
        .clock = neutral_control_plane.EvidenceClock.system(),
    };

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

    // Controller.resize connects over the endpoint socket and blocks until the
    // host answers, so the host is served from another thread. This is the same
    // client/server split the product runs; nothing here reaches the handler.
    var server: EndpointServer = .{ .endpoint = &endpoint, .operations = &operations };
    const applied = try server.round(&controller, request);
    defer allocator.free(applied);
    try validateResizeResult(allocator, applied);

    // The outcome fields are optional HERE only so the state check reports the
    // real problem: an unbound terminal answers `unknown`, and a struct that
    // demanded `revision` would fail as a parse error rather than naming it.
    // Both are required below once the state is known to be `applied`.
    const Applied = struct {
        state: []const u8,
        revision: ?[]const u8 = null,
        readback: ?struct { columns: u32, rows: u32 } = null,
    };
    var parsed = try std.json.parseFromSlice(Applied, allocator, applied, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.state, "applied")) return error.ResizeNotApplied;
    const revision = parsed.value.revision orelse return error.ResizeReceiptMissingRevision;
    const readback = parsed.value.readback orelse return error.ResizeReceiptMissingReadback;
    if (!std.mem.eql(u8, revision, "7")) return error.ResizeWrongRevision;
    if (readback.columns != window.columns or readback.rows != window.rows)
        return error.ResizeReadbackDiverged;

    // The durable record must now hold what the TERMINAL reported, because a
    // later inspection answers from it.
    const record = registry.get(session) orelse return error.ResizeSessionMissing;
    if (record.windowRevision != 7) return error.ResizeRevisionNotCommitted;
    if (record.window.columns != window.columns or record.window.rows != window.rows)
        return error.ResizeWindowNotCommitted;

    // PARTIAL IDEMPOTENCY -- this records what the implementation does today,
    // and deliberately does NOT certify it as the contract.
    //
    // The frozen request schema says a repeat of the same TRANSACTION replays
    // its receipt rather than mutating twice. Replaying receipts needs durable
    // per-session receipt storage (idempotency key + request digest + the
    // applied receipt), which belongs to the single Record migration #108 owns;
    // doing it here would mean migrating the same struct twice.
    //
    // So today an identical replay is answered `stale` naming the revision in
    // force. That answer is TRUTHFUL -- revision 7 really is current, and no
    // second mutation happened, which is the guarantee that actually protects
    // the terminal. It is simply not yet the receipt replay §5 asks for. The
    // assertion below pins the current behavior so a change is visible, and
    // this comment is why it must not be read as the target.
    const replayed = try server.round(&controller, request);
    defer allocator.free(replayed);
    try validateResizeResult(allocator, replayed);
    const Replay = struct { state: []const u8, currentRevision: ?[]const u8 = null };
    var replay_parsed = try std.json.parseFromSlice(Replay, allocator, replayed, .{
        .ignore_unknown_fields = true,
    });
    defer replay_parsed.deinit();
    // The invariant that must hold either way: a replay never mutates again.
    if (pty.resizeRevision() != 7) return error.ResizeReplayMutatedAgain;
    if (std.mem.eql(u8, replay_parsed.value.state, "applied")) {
        // Receipt replay landed (#108). That is the contract target, not a
        // regression -- but it must be the SAME revision, not a new mutation.
        return;
    }
    if (!std.mem.eql(u8, replay_parsed.value.state, "stale")) return error.ResizeReplayNotStale;
    const current_revision = replay_parsed.value.currentRevision orelse
        return error.ResizeStaleMissingRevision;
    if (!std.mem.eql(u8, current_revision, "7")) return error.ResizeStaleWrongRevision;
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
    ) anyerror!neutral_control_plane.TerminalResize {
        const self: *PtyTerminal = @ptrCast(@alignCast(context));
        const receipt = self.pty.resize(.{
            .columns = window.columns,
            .rows = window.rows,
            .width_px = window.widthPixels,
            .height_px = window.heightPixels,
        }, revision) catch |err| switch (err) {
            error.StaleResizeRevision => return .{ .superseded = .{
                .revision = self.pty.resizeRevision(),
                .orderedAt = self.pty.resizeOrderedAt(),
                .readback = geometryToWindow(self.pty.geometry),
            } },
            else => return err,
        };
        return .{ .applied = .{
            .revision = receipt.revision,
            .orderedAt = receipt.ordered_at,
            .readback = geometryToWindow(receipt.readback),
        } };
    }

    fn provider(self: *PtyTerminal) neutral_control_plane.TerminalProvider {
        return .{ .context = self, .resizeFn = resize };
    }
};

/// One request/response round over the real transport: the host serves on a
/// thread while Controller.resize drives the client side.
const EndpointServer = struct {
    endpoint: *neutral_host.HostEndpoint,
    operations: *neutral_control_plane.HostOperations,
    served: ?anyerror = null,

    fn serve(self: *EndpointServer) void {
        self.endpoint.serveOne(self.operations.handler()) catch |err| {
            self.served = err;
        };
    }

    fn round(
        self: *EndpointServer,
        controller: *neutral_control_plane.Controller,
        request: []const u8,
    ) ![]u8 {
        self.served = null;
        const thread = try std.Thread.spawn(.{}, serve, .{self});
        const response = controller.resize(request);
        thread.join();
        if (self.served) |err| return err;
        return response;
    }
};

fn geometryToWindow(geometry: pty_host.Geometry) neutral_host.WindowSize {
    return .{
        .columns = geometry.columns,
        .rows = geometry.rows,
        .widthPixels = geometry.width_px,
        .heightPixels = geometry.height_px,
    };
}

const GoldenEvidence = struct {
    fn measure(_: *anyopaque, _: std.mem.Allocator) !neutral_control_plane.LiveEvidence {
        return .{};
    }

    fn provider(self: *GoldenEvidence) neutral_control_plane.EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }
};
