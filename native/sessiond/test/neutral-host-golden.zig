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

    _ = c.kill(child_pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(child_pid, &status, 0);
}
