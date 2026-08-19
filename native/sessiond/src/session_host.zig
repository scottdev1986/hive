// ! One HOST process owns one provider generation. ! This module composes the landed PTY, process-inspection, input-arbiter, and ! terminal-state leaves for the directly launched host process.

const std = @import("std");
const boot_envelope = @import("boot_envelope");
const daemon_identity = @import("daemon_identity");
const generated = @import("session_protocol_generated");
const input_arbiter = @import("input_arbiter");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const pty_host = @import("pty_host");
const session_types = @import("session_types");
const neutral_host = @import("neutral_host");

const wall_clock = @import("wall_clock");
const terminal_state = @import("terminal_state");

const c = @cImport({
    @cInclude("signal.h");
    @cInclude("sys/event.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/stat.h");
    @cInclude("sys/time.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
    @cInclude("stdlib.h");
});

test {
    std.testing.refAllDecls(@This());
}

const inherited_control_fd = boot_envelope.inherited_control_fd;
const readBootMessage = boot_envelope.read;

const VisibilityLease = @import("visibility_lease").VisibilityLease;

const neutral_contract = @import("neutral_contract");
const neutral_runtime = @import("neutral_runtime");
const checkpoint_format = @import("checkpoint_format");
const neutral_evidence = @import("neutral_evidence");
const neutral_operations = @import("neutral_operations");
pub fn requireEngineBuildId(value: ?[]const u8) !void {
    const expected = try session_types.engineBuildIdHex();
    if (value == null or !std.mem.eql(u8, value.?, &expected))
        return error.EngineMismatch;
}

const terminal_adapter = @import("terminal_adapter");
const ghostty_c = terminal_adapter.c_api;
const canonical_scrollback_bytes = terminal_adapter.canonical_scrollback_bytes;
const BridgeExport = terminal_adapter.BridgeExport;
const RealVtEngine = terminal_adapter.RealVtEngine;
const PtyQueueSink = terminal_adapter.PtyQueueSink;

const final_evidence = @import("final_evidence");
const FinalState = final_evidence.FinalState;
const FinalSurvivor = final_evidence.FinalSurvivor;
const FinalError = final_evidence.FinalError;
const FinalEvidence = final_evidence.FinalEvidence;
const writeFinalExclusive = final_evidence.writeExclusive;

const host_record = @import("host_record");
const WireLocator = host_record.WireLocator;
const WireGeometry = host_record.WireGeometry;
const HostRegistration = host_record.HostRegistration;
const locatorValue = host_record.locatorValue;
const processRootValue = host_record.processRootValue;
const geometryValue = host_record.geometryValue;
const visibilityValue = host_record.visibilityValue;
const protocolValue = host_record.protocolValue;
const encodeHostRegister = host_record.encodeHostRegister;

const host_wire = @import("host_wire");
const readRequiredFrame = host_wire.readRequiredFrame;
const writeHostFailure = host_wire.writeFailure;
const host_registration = @import("host_registration");
const sendReadyAfterBoot = host_registration.sendReadyAfterBoot;
const parseLocator = host_registration.parseLocator;
const writeHostWelcome = host_registration.writeHostWelcome;
const WireHello = host_registration.WireHello;

const host_process = @import("host_runtime");
const security = @import("security_helpers");
const setControlTimeoutMs = host_process.setControlTimeoutMs;
const setControlTimeout = host_process.setControlTimeout;
const ConnectionDeadline = host_process.ConnectionDeadline;
const readConnectionFrame = host_process.readConnectionFrame;
const acceptedConnectionReady = host_process.acceptedConnectionReady;
const HostRuntime = host_process.HostRuntime;
const executableBuildHash = host_process.executableBuildHash;

const host_core = @import("host_core");
const checkpointWireSeq = host_core.checkpointWireSeq;
const GrantOperations = host_core.GrantOperations;
const ViewerAuthorization = host_core.ViewerAuthorization;
const TerminationBinding = host_core.TerminationBinding;
const max_replay_entries = host_core.max_replay_entries;
const deliverGracefulAction = host_core.deliverGracefulAction;
const HostCore = host_core.HostCore;
const ExpectedPeerRole = enum { broker, viewer, either };

const AcceptedHello = struct {
    allocator: std.mem.Allocator,
    build_id: []u8,
    grant_token: ?[]u8,
    role: ExpectedPeerRole,

    fn deinit(self: *AcceptedHello) void {
        self.allocator.free(self.build_id);
        if (self.grant_token) |token| {
            std.crypto.secureZero(u8, token);
            self.allocator.free(token);
        }
        self.* = undefined;
    }
};

fn acceptHostHello(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    deadline: *const ConnectionDeadline,
    now_ns: u64,
    expected_role: ExpectedPeerRole,
) !?AcceptedHello {
    const peer = try daemon_identity.inspectPeer(stream.handle);
    if (peer.uid != std.posix.getuid() or
        peer.gid != @as(u32, @intCast(c.getgid())))
        return error.UnauthenticatedPeer;

    var hello_frame = try readConnectionFrame(allocator, stream, deadline);
    defer {
        std.crypto.secureZero(u8, hello_frame.payload);
        hello_frame.deinit(allocator);
    }
    if (hello_frame.header.type_code != generated.frame_type.hello or
        hello_frame.header.flags != 0 or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.hello_payload,
            hello_frame.payload,
        ))
    {
        try writeHostFailure(allocator, stream, hello_frame.header, .malformed_frame);
        return null;
    }
    var hello = try std.json.parseFromSlice(WireHello, allocator, hello_frame.payload, .{
        .ignore_unknown_fields = true,
    });
    defer hello.deinit();
    if (hello.value.protocol.major != generated.protocol_major or
        hello.value.protocol.minMinor > generated.protocol_minor or
        hello.value.protocol.maxMinor < generated.protocol_minor or
        (expected_role == .broker and
            !std.mem.eql(u8, hello.value.buildId, core.broker_build_id)))
    {
        try writeHostFailure(allocator, stream, hello_frame.header, .protocol_mismatch);
        return null;
    }
    if (!std.mem.eql(u8, hello.value.instanceId, core.registration.record.locator.instance_id)) {
        try writeHostFailure(allocator, stream, hello_frame.header, .instance_mismatch);
        return null;
    }
    const role: ExpectedPeerRole = if (std.mem.eql(u8, hello.value.clientRole, "broker"))
        .broker
    else if (std.mem.eql(u8, hello.value.clientRole, "viewer"))
        .viewer
    else {
        try writeHostFailure(allocator, stream, hello_frame.header, .forbidden);
        return null;
    };
    if ((expected_role != .either and role != expected_role) or
        (role == .viewer and hello.value.grantToken == null))
    {
        try writeHostFailure(allocator, stream, hello_frame.header, .forbidden);
        return null;
    }
    const build_id = try allocator.dupe(u8, hello.value.buildId);
    errdefer allocator.free(build_id);
    const grant_token = if (hello.value.grantToken) |token|
        try allocator.dupe(u8, token)
    else
        null;
    errdefer if (grant_token) |token| {
        std.crypto.secureZero(u8, token);
        allocator.free(token);
    };
    try writeHostWelcome(
        allocator,
        stream,
        hello_frame.header,
        core.registration,
        core.registration.record.executable_build_hash,
        now_ns,
    );
    return .{
        .allocator = allocator,
        .build_id = build_id,
        .grant_token = grant_token,
        .role = role,
    };
}

const AuthorizedViewer = struct {
    authorization: ViewerAuthorization,
    attach_minor: u8,
    attach_request_id: u64,
};

fn viewerAttachFailureCode(err: anyerror) protocol.WireError {
    return switch (err) {
        error.VisibilityExpired => .not_ready,
        error.InvalidHostAttach => .malformed_frame,
        // Exact-locator fence: a wrong or superseded generation is a typed refusal before any grant/token evaluation.
        error.AttachLocatorMismatch => .generation_mismatch,
        error.InvalidViewerGrant => .unauthenticated,
        error.OutOfMemory => .resource_exhausted,
        else => .verification_unknown,
    };
}

fn authorizeViewerAfterHello(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    hello: *const AcceptedHello,
    deadline: *const ConnectionDeadline,
    now_ns: u64,
) !AuthorizedViewer {
    var request = try readConnectionFrame(allocator, stream, deadline);
    defer {
        std.crypto.secureZero(u8, request.payload);
        request.deinit(allocator);
    }
    if (request.header.flags != 0 or
        request.header.type_code != generated.frame_type.host_attach)
    {
        try writeHostFailure(allocator, stream, request.header, .malformed_frame);
        return error.InvalidHostAttach;
    }
    const authorization = core.authorizeViewerAttach(
        request.payload,
        hello.grant_token.?,
        now_ns,
    ) catch |err| {
        try writeHostFailure(allocator, stream, request.header, viewerAttachFailureCode(err));
        return err;
    };
    return .{
        .authorization = authorization,
        .attach_minor = request.header.minor,
        .attach_request_id = request.header.request_id,
    };
}

pub fn authorizeViewerConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
) !ViewerAuthorization {
    var timer = try std.time.Timer.start();
    const deadline = try ConnectionDeadline.init(&timer);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .viewer)) orelse
        return error.ViewerHandshakeRefused;
    defer hello.deinit();
    const authorized = try authorizeViewerAfterHello(allocator, stream, core, &hello, &deadline, now_ns);
    return authorized.authorization;
}

const WireCaptureRequest = struct {
    include: []const u8,
    maxRows: u16,
    expectedOutputSeq: ?[]const u8 = null,
};

fn captureTerminalPayload(
    allocator: std.mem.Allocator,
    locator: session_types.Locator,
    state: *terminal_state.TerminalState,
    real_engine: *RealVtEngine,
    payload: []const u8,
) ![]u8 {
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.capture_request,
        payload,
    )) return error.InvalidCaptureRequest;
    var parsed = try std.json.parseFromSlice(WireCaptureRequest, allocator, payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    const include_text = if (std.mem.eql(u8, parsed.value.include, "visible-text"))
        true
    else if (std.mem.eql(u8, parsed.value.include, "metadata"))
        false
    else
        return error.InvalidCaptureRequest;
    if (parsed.value.expectedOutputSeq) |expected| {
        const expected_seq = std.fmt.parseInt(u64, expected, 10) catch
            return error.InvalidCaptureRequest;
        if (expected_seq != state.outputSeq()) return error.CaptureSequenceMismatch;
    }

    var capture = try real_engine.capture(
        allocator,
        parsed.value.maxRows,
        include_text,
    );
    defer capture.deinit();
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var cursor = std.json.ObjectMap.init(a);
    try cursor.put("row", .{ .integer = capture.cursor.row });
    try cursor.put("column", .{ .integer = capture.cursor.column });
    try cursor.put("visible", .{ .bool = capture.cursor.visible });
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    if (capture.text) |text| hasher.update(text);
    hasher.update(&.{0});
    if (capture.styled_text) |text| hasher.update(text);
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    const digest_hex = std.fmt.bytesToHex(digest, .lower);
    const output_seq = try std.fmt.allocPrint(a, "{d}", .{state.outputSeq()});
    var root = std.json.ObjectMap.init(a);
    try root.put("locator", try locatorValue(a, locator));
    try root.put("outputSeq", .{ .string = output_seq });
    try root.put("columns", .{ .integer = capture.columns });
    try root.put("rows", .{ .integer = capture.rows });
    try root.put("rowStart", .{ .integer = capture.row_start });
    try root.put("screen", .{ .string = @tagName(capture.screen) });
    try root.put("cursor", .{ .object = cursor });
    try root.put("text", if (capture.text) |text| .{ .string = text } else .null);
    try root.put(
        "styledText",
        if (capture.styled_text) |text| .{ .string = text } else .null,
    );
    try root.put("truncated", .{ .bool = capture.row_start != 0 });
    try root.put("sha256", .{ .string = try a.dupe(u8, &digest_hex) });
    try root.put("composer", .null);
    const response = try std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
    errdefer allocator.free(response);
    if (response.len > generated.limits.control_json_bytes)
        return error.CapturePayloadTooLarge;
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.capture_result,
        response,
    )) return error.InvalidCaptureResponse;
    return response;
}

test "HOST_CAPTURE encodes the measured libghostty grid" {
    var clock_context: u8 = 0;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const engine_build_id = try RealVtEngine.engineBuildId();
    const real_engine = try RealVtEngine.create(std.testing.allocator, 8, 3, null);
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = FixedClock.now },
        &engine_build_id,
        .{
            .columns = 8,
            .rows = 3,
            .cell_width_px_16_16 = 8 << 16,
            .cell_height_px_16_16 = 16 << 16,
        },
        temporary.dir,
    );
    defer state.deinit();
    try state.feedOutput("first\r\n\x1b[1msecond\x1b[0m");
    const response = try captureTerminalPayload(
        std.testing.allocator,
        fixtureRegistration().record.locator,
        &state,
        real_engine,
        "{\"include\":\"visible-text\",\"maxRows\":2}",
    );
    defer std.testing.allocator.free(response);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.capture_result,
        response,
    ));
    const Captured = struct {
        outputSeq: []const u8,
        columns: u16,
        rows: u16,
        rowStart: u16,
        cursor: struct { row: u16, column: u16, visible: bool },
        text: ?[]const u8,
        styledText: ?[]const u8,
        truncated: bool,
    };
    var captured = try std.json.parseFromSlice(Captured, std.testing.allocator, response, .{
        .ignore_unknown_fields = true,
    });
    defer captured.deinit();
    try std.testing.expectEqual(
        state.outputSeq(),
        try std.fmt.parseInt(u64, captured.value.outputSeq, 10),
    );
    try std.testing.expectEqual(@as(u16, 8), captured.value.columns);
    try std.testing.expectEqual(@as(u16, 3), captured.value.rows);
    try std.testing.expectEqual(@as(u16, 1), captured.value.rowStart);
    try std.testing.expectEqual(@as(u16, 1), captured.value.cursor.row);
    try std.testing.expectEqual(@as(u16, 6), captured.value.cursor.column);
    try std.testing.expect(captured.value.cursor.visible);
    try std.testing.expect(captured.value.truncated);
    try std.testing.expect(std.mem.indexOf(u8, captured.value.text.?, "second") != null);
    try std.testing.expect(std.mem.indexOf(u8, captured.value.styledText.?, "\x1b[1m") != null);
}

fn serveControlRequest(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    state: ?*terminal_state.TerminalState,
    real_engine: ?*RealVtEngine,
    hello_build_id: []const u8,
    deadline: *const ConnectionDeadline,
    now_ns: u64,
) !void {
    var request = try readConnectionFrame(allocator, stream, deadline);
    defer request.deinit(allocator);
    if (request.header.flags != 0) {
        try writeHostFailure(allocator, stream, request.header, .malformed_frame);
        return;
    }
    // Same-uid + instanceId + buildId prove only that the peer is A local process running the same executable; the 32-byte adoption secret is the proof it is THE broker that owns this host. HOST_ADOPT is therefore the only pre-adoption verb: terminate, grant_register, and any future privileged RPC fail closed until adoption has set core.adopted (write-once for the host's lifetime).
    if (request.header.type_code != generated.frame_type.host_adopt and !core.adopted) {
        try writeHostFailure(allocator, stream, request.header, .unauthenticated);
        return;
    }
    switch (request.header.type_code) {
        generated.frame_type.host_adopt => {
            // Kernel-owned peer identity, read before the secret is checked so the supervisor this host watches from here on is the process the kernel says is on the other end of the socket, never a claim.
            const adopting = daemon_identity.inspectPeer(stream.handle) catch null;
            const response = core.adopt(
                request.payload,
                hello_build_id,
                now_ns,
            ) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    if (err == error.VisibilityExpired) .not_ready else .unauthenticated,
                );
                return;
            };
            defer core.allocator.free(response);
            if (adopting) |peer| core.supervisorAdoptedBy(peer.pid);
            try protocol.writeFrame(
                stream,
                request.header.response(generated.frame_type.host_adopt, response.len),
                response,
            );
        },
        generated.frame_type.grant_register => {
            const response = core.registerGrant(request.payload, now_ns) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    switch (err) {
                        error.VisibilityExpired => .not_ready,
                        error.GrantCapacityExceeded => .capacity_exceeded,
                        else => .malformed_frame,
                    },
                );
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                request.header.response(generated.frame_type.grant_register, response.len),
                response,
            );
        },
        generated.frame_type.host_capture => {
            const terminal = real_engine orelse {
                try writeHostFailure(allocator, stream, request.header, .verification_unknown);
                return;
            };
            const terminal_state_value = state orelse {
                try writeHostFailure(allocator, stream, request.header, .verification_unknown);
                return;
            };
            const response = captureTerminalPayload(
                allocator,
                core.registration.record.locator,
                terminal_state_value,
                terminal,
                request.payload,
            ) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    switch (err) {
                        error.InvalidCaptureRequest => .malformed_frame,
                        error.CapturePayloadTooLarge => .resource_exhausted,
                        else => .verification_unknown,
                    },
                );
                return;
            };
            defer allocator.free(response);
            try protocol.writeFrame(
                stream,
                request.header.response(generated.frame_type.host_captured, response.len),
                response,
            );
        },
        generated.frame_type.terminate => {
            const response = core.terminate(request.payload) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    switch (err) {
                        error.TerminationNotReady => .not_ready,
                        error.AlreadyTerminated => .already_exists,
                        else => .verification_unknown,
                    },
                );
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                request.header.response(generated.frame_type.terminated, response.len),
                response,
            );
        },
        else => try writeHostFailure(allocator, stream, request.header, .unsupported_frame),
    }
}

fn serveHostConnectionWithTerminal(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    state: ?*terminal_state.TerminalState,
    real_engine: ?*RealVtEngine,
    now_ns: u64,
    budget_ms: u64,
) !void {
    var timer = try std.time.Timer.start();
    const deadline = try ConnectionDeadline.initWithBudget(&timer, budget_ms);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .broker)) orelse return;
    defer hello.deinit();
    return serveControlRequest(
        allocator,
        stream,
        core,
        state,
        real_engine,
        hello.build_id,
        &deadline,
        now_ns,
    );
}

fn viewerFailureCode(err: anyerror) protocol.WireError {
    return switch (err) {
        error.GenerationMismatch => .generation_mismatch,
        error.InvalidInputSubmit,
        error.InvalidResize,
        error.InvalidResizeReplay,
        => .malformed_frame,
        error.InputPayloadTooLarge => .payload_too_large,
        error.OutOfMemory => .resource_exhausted,
        else => .verification_unknown,
    };
}

fn handleViewerFrame(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    authorization: *const ViewerAuthorization,
    request: *const protocol.Frame,
    now_ns: u64,
) !void {
    const expected_flags: u16 = if (request.header.type_code == generated.frame_type.input_submit or
        request.header.type_code == generated.frame_type.user_input)
        generated.frame_flag.content_sensitive
    else
        0;
    if (request.header.flags != expected_flags) {
        try writeHostFailure(allocator, stream, request.header, .malformed_frame);
        return;
    }
    if (request.header.type_code == generated.frame_type.user_input) {
        if (!authorization.operations.user_input) return error.Forbidden;
        try core.submitRawInput(request.payload);
        return;
    }
    var response_type: u16 = undefined;
    const response = switch (request.header.type_code) {
        generated.frame_type.input_submit => blk: {
            if (!authorization.operations.user_input) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.applied;
            break :blk core.submitInput(
                request.payload,
                authorization.viewer_id,
                now_ns,
            ) catch |err| {
                try writeHostFailure(allocator, stream, request.header, viewerFailureCode(err));
                return;
            };
        },
        generated.frame_type.resize => blk: {
            if (!authorization.operations.resize) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.applied;
            break :blk core.resizeTerminal(request.payload, state) catch |err| {
                try writeHostFailure(allocator, stream, request.header, viewerFailureCode(err));
                return;
            };
        },
        else => {
            try writeHostFailure(allocator, stream, request.header, .unsupported_frame);
            return;
        },
    };
    defer core.allocator.free(response);
    try protocol.writeFrame(
        stream,
        request.header.response(response_type, response.len),
        response,
    );
}

const AttachedViewer = struct {
    stream: std.net.Stream,
    authorization: ViewerAuthorization,
    sent_seq: u64,
    acked_seq: u64,

    fn close(self: *AttachedViewer, allocator: std.mem.Allocator) void {
        self.stream.close();
        self.authorization.deinit(allocator);
        self.* = undefined;
    }
};

fn pushRetainedOutput(
    stream: std.net.Stream,
    state: *terminal_state.TerminalState,
    seq: *u64,
) !void {
    const slice = try state.journal.sliceFrom(seq.*);
    var offset: usize = 0;
    while (offset < slice.len) {
        const take = @min(generated.limits.stream_chunk_bytes, slice.len - offset);
        try protocol.writeFrame(stream, .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.output,
            .flags = 0,
            .payload_length = @intCast(take),
            .request_id = 0,
            .stream_seq = seq.* + @as(u64, @intCast(offset)),
        }, slice[offset..][0..take]);
        offset += take;
    }
    seq.* += @as(u64, @intCast(slice.len));
}

/// attach stream for an authorized viewer: when the requested cursor is below the retained journal start, the newest verified HVTCP001 checkpoint envelope is sent as correlated SNAPSHOT_BYTES chunks; every retained byte after the effective base then replays as ordered OUTPUT. Returns the exclusive high-water written. A cursor the retained journal and checkpoint cannot bridge is a typed CHECKPOINT_UNAVAILABLE failure, never silence.
fn beginViewerStream(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    state: *terminal_state.TerminalState,
    authorized: *const AuthorizedViewer,
) !u64 {
    const attach_header: protocol.Header = .{
        .minor = authorized.attach_minor,
        .type_code = generated.frame_type.host_attach,
        .flags = 0,
        .payload_length = 0,
        .request_id = authorized.attach_request_id,
        .stream_seq = 0,
    };
    var base: u64 = authorized.authorization.after_seq;
    const retained_start = state.retainedOutputStart();
    if (base < retained_start) {
        const checkpoint = state.newestCheckpoint() orelse {
            try writeHostFailure(allocator, stream, attach_header, .checkpoint_unavailable);
            return error.CheckpointUnavailable;
        };
        const through_seq = checkpoint.header.through_seq;
        if (through_seq < retained_start) {
            try writeHostFailure(allocator, stream, attach_header, .checkpoint_unavailable);
            return error.CheckpointUnavailable;
        }
        var buffer: [checkpoint_format.checkpoint_stream_chunk_bytes]u8 = undefined;
        var offset: usize = 0;
        while (offset < checkpoint.totalBytes()) {
            const take = try checkpoint.readAt(&buffer, offset);
            const final_flag: u16 = if (offset + take == checkpoint.totalBytes())
                generated.frame_flag.final
            else
                0;
            try protocol.writeFrame(stream, .{
                .minor = authorized.attach_minor,
                .type_code = generated.frame_type.snapshot_bytes,
                .flags = generated.frame_flag.response | final_flag,
                .payload_length = @intCast(take),
                .request_id = authorized.attach_request_id,
                .stream_seq = @intCast(offset),
            }, buffer[0..take]);
            offset += take;
        }
        base = through_seq;
    }
    try pushRetainedOutput(stream, state, &base);
    return base;
}

fn writeAttachReady(
    stream: std.net.Stream,
    authorized: *const AuthorizedViewer,
) !void {
    try protocol.writeFrame(stream, .{
        .minor = authorized.attach_minor,
        .type_code = generated.frame_type.attach_ready,
        .flags = generated.frame_flag.response | generated.frame_flag.final,
        .payload_length = 0,
        .request_id = authorized.attach_request_id,
        .stream_seq = 0,
    }, "");
}

/// Serves one accepted host.sock connection. A broker connection is one RPC. A viewer connection authorizes, streams the attach snapshot/replay, and is returned to the host loop as the live attached viewer; the caller closes the stream in every other outcome.
fn serveSessionConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    real_engine: *RealVtEngine,
    timer: *std.time.Timer,
) !?AttachedViewer {
    const now_ns = timer.read();
    const deadline = try ConnectionDeadline.init(timer);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .either)) orelse return null;
    defer hello.deinit();
    switch (hello.role) {
        .broker => {
            try serveControlRequest(
                allocator,
                stream,
                core,
                state,
                real_engine,
                hello.build_id,
                &deadline,
                now_ns,
            );
            return null;
        },
        .viewer => {
            var authorized = try authorizeViewerAfterHello(
                allocator,
                stream,
                core,
                &hello,
                &deadline,
                now_ns,
            );
            errdefer authorized.authorization.deinit(core.allocator);
            const sent_seq = try beginViewerStream(allocator, stream, state, &authorized);
            try writeAttachReady(stream, &authorized);
            return .{
                .stream = stream,
                .authorization = authorized.authorization,
                .sent_seq = sent_seq,
                .acked_seq = authorized.authorization.after_seq,
            };
        },
        .either => unreachable,
    }
}

/// Per-iteration bound on dispatched inbound viewer frames so a chatty viewer cannot starve the PTY pump.
const viewer_inbound_frames_per_iteration = 32;

fn publishViewerFloor(
    viewers: *const std.ArrayList(AttachedViewer),
    state: *terminal_state.TerminalState,
) void {
    var floor: ?u64 = null;
    for (viewers.items) |viewer| {
        floor = if (floor) |current| @min(current, viewer.sent_seq) else viewer.sent_seq;
    }
    state.setViewerFloor(floor);
}

fn detachAttachedViewer(
    allocator: std.mem.Allocator,
    viewers: *std.ArrayList(AttachedViewer),
    viewer_index: usize,
    state: *terminal_state.TerminalState,
    cause: []const u8,
    detail: ?anyerror,
) void {
    var viewer = viewers.swapRemove(viewer_index);
    std.log.warn(
        "viewer detached cause={s} detail={s} viewer={s} sent={d} acked={d} output={d} retained_start={d}",
        .{
            cause,
            if (detail) |err| @errorName(err) else "-",
            viewer.authorization.viewer_id,
            viewer.sent_seq,
            viewer.acked_seq,
            state.outputSeq(),
            state.retainedOutputStart(),
        },
    );
    viewer.close(allocator);
    publishViewerFloor(viewers, state);
}

fn installAttachedViewer(
    allocator: std.mem.Allocator,
    viewers: *std.ArrayList(AttachedViewer),
    state: *terminal_state.TerminalState,
    incoming: AttachedViewer,
) !void {
    var viewer = incoming;
    errdefer viewer.close(allocator);
    for (viewers.items, 0..) |attached, index| {
        if (std.mem.eql(
            u8,
            attached.authorization.viewer_id,
            viewer.authorization.viewer_id,
        )) {
            detachAttachedViewer(
                allocator,
                viewers,
                index,
                state,
                "superseded-by-same-viewer",
                null,
            );
            break;
        }
    }
    try viewers.append(allocator, viewer);
    publishViewerFloor(viewers, state);
}

const ViewerDetach = struct {
    cause: []const u8,
    detail: ?anyerror,
};

fn pumpAttachedViewer(
    allocator: std.mem.Allocator,
    viewer: *AttachedViewer,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    timer: *std.time.Timer,
) ?ViewerDetach {
    // One absolute budget per pump call: poll proves only that SOME byte is readable, so a dribbling viewer cannot stall the host loop.
    const deadline = ConnectionDeadline.init(timer) catch return null;
    if (state.retainedOutputStart() > viewer.sent_seq) {
        return .{ .cause = "retention-gap", .detail = null };
    }
    var handled: u32 = 0;
    while (handled < viewer_inbound_frames_per_iteration) : (handled += 1) {
        var fds = [_]std.posix.pollfd{.{
            .fd = viewer.stream.handle,
            .events = std.posix.POLL.IN,
            .revents = 0,
        }};
        const ready = std.posix.poll(&fds, 0) catch 0;
        if (ready == 0 or fds[0].revents == 0) break;
        var frame = readConnectionFrame(allocator, viewer.stream, &deadline) catch |err| {
            return .{ .cause = "inbound-read", .detail = err };
        };
        defer {
            if (frame.header.type_code == generated.frame_type.input_submit or
                frame.header.type_code == generated.frame_type.user_input)
                std.crypto.secureZero(u8, frame.payload);
            frame.deinit(allocator);
        }
        if (frame.header.type_code == generated.frame_type.applied) {
            if (viewerOutputAckThroughSeq(allocator, &frame)) |through_seq| {
                // Duplicate/stale acks are harmless retransmits; an ack beyond what was sent is a protocol violation.
                if (through_seq <= viewer.sent_seq) {
                    if (through_seq > viewer.acked_seq) viewer.acked_seq = through_seq;
                    continue;
                }
            }
            // A malformed or impossible acknowledgement cannot erase or disconnect a healthy terminal.
            continue;
        }
        handleViewerFrame(
            allocator,
            viewer.stream,
            core,
            state,
            &viewer.authorization,
            &frame,
            timer.read(),
        ) catch |err| {
            return .{ .cause = "frame-handle", .detail = err };
        };
    }
    if (state.outputSeq() > viewer.sent_seq and
        viewer.sent_seq - viewer.acked_seq < generated.limits.viewer_queue_bytes)
    {
        pushRetainedOutput(viewer.stream, state, &viewer.sent_seq) catch |err| {
            return .{ .cause = "output-write", .detail = err };
        };
    }
    return null;
}

fn pumpAttachedViewers(
    allocator: std.mem.Allocator,
    viewers: *std.ArrayList(AttachedViewer),
    core: *HostCore,
    state: *terminal_state.TerminalState,
    timer: *std.time.Timer,
) void {
    var index: usize = 0;
    while (index < viewers.items.len) {
        if (pumpAttachedViewer(
            allocator,
            &viewers.items[index],
            core,
            state,
            timer,
        )) |reason| {
            detachAttachedViewer(
                allocator,
                viewers,
                index,
                state,
                reason.cause,
                reason.detail,
            );
        } else {
            index += 1;
        }
    }
    publishViewerFloor(viewers, state);
}

fn viewerOutputAckThroughSeq(
    allocator: std.mem.Allocator,
    frame: *const protocol.Frame,
) ?u64 {
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.applied_payload,
        frame.payload,
    )) return null;
    const Ack = struct {
        schemaVersion: u8,
        resultKind: []const u8,
        throughSeq: []const u8,
    };
    var parsed = std.json.parseFromSlice(Ack, allocator, frame.payload, .{
        .ignore_unknown_fields = true,
    }) catch return null;
    defer parsed.deinit();
    if (parsed.value.schemaVersion != 1 or
        !std.mem.eql(u8, parsed.value.resultKind, "output"))
        return null;
    return std.fmt.parseInt(u64, parsed.value.throughSeq, 10) catch null;
}

const WireCreateSpec = struct {
    schemaVersion: u8,
    locator: WireLocator,
    // Null for a headless orchestrator root: no vendor CLI is attached, so there is nothing honest to name. Parsed and never read below — the host launches whatever argv it is given regardless of which vendor, if any, is behind it.
    provider: ?[]const u8 = null,
    cwd: []const u8,
    argv: []const []const u8,
    environment: std.json.Value,
    expectedExecutable: []const u8,
    geometry: WireGeometry,
    visibility: struct {
        workspaceSessionId: []const u8,
        workspacePid: i32,
        workspaceStartToken: []const u8,
        openTerminalRevision: []const u8,
    },
};

test "WireCreateSpec.provider parses identically whether the JSON key is explicit null or absent" {
    const allocator = std.testing.allocator;
    const locator_and_tail =
        \\"locator":{"schemaVersion":1,"instanceId":"i","subject":{"kind":"root"},"generation":1,"sessionId":"s","hostKind":"sessiond","engineBuildId":"e"},"cwd":"/tmp","argv":["/bin/zsh"],"environment":{},"expectedExecutable":"/bin/zsh","geometry":{"columns":80,"rows":24,"widthPx":800,"heightPx":480,"cellWidthPx":10,"cellHeightPx":20},"visibility":{"workspaceSessionId":"w","workspacePid":1,"workspaceStartToken":"1:1","openTerminalRevision":"1"}}
    ;
    const with_explicit_null = "{\"schemaVersion\":1,\"provider\":null," ++ locator_and_tail;
    const with_key_absent = "{\"schemaVersion\":1," ++ locator_and_tail;

    var parsed_null = try std.json.parseFromSlice(WireCreateSpec, allocator, with_explicit_null, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    });
    defer parsed_null.deinit();
    var parsed_absent = try std.json.parseFromSlice(WireCreateSpec, allocator, with_key_absent, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    });
    defer parsed_absent.deinit();

    // TypeScript always sends the key explicitly (nullable(), not optional()), so only the first
    // case occurs in production today. Both are proven so a future caller that omits the key
    // instead is not a surprise.
    try std.testing.expectEqual(@as(?[]const u8, null), parsed_null.value.provider);
    try std.testing.expectEqual(@as(?[]const u8, null), parsed_absent.value.provider);
}

fn environmentEntries(
    allocator: std.mem.Allocator,
    value: std.json.Value,
) ![]const neutral_contract.EnvironmentEntry {
    const object = switch (value) {
        .object => |object| object,
        else => return error.InvalidEnvironment,
    };
    const result = try allocator.alloc(neutral_contract.EnvironmentEntry, object.count());
    var iterator = object.iterator();
    var index: usize = 0;
    while (iterator.next()) |entry| : (index += 1) {
        if (entry.key_ptr.*.len == 0 or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, '=') != null or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, 0) != null)
            return error.InvalidEnvironment;
        const item = switch (entry.value_ptr.*) {
            .string => |item| item,
            else => return error.InvalidEnvironment,
        };
        if (std.mem.indexOfScalar(u8, item, 0) != null)
            return error.InvalidEnvironment;
        result[index] = .{ .name = entry.key_ptr.*, .value = item };
    }
    return result;
}

fn environmentStrings(
    allocator: std.mem.Allocator,
    value: std.json.Value,
) ![]const []const u8 {
    const object = switch (value) {
        .object => |object| object,
        else => return error.InvalidEnvironment,
    };
    const result = try allocator.alloc([]const u8, object.count());
    var iterator = object.iterator();
    var index: usize = 0;
    while (iterator.next()) |entry| : (index += 1) {
        if (entry.key_ptr.*.len == 0 or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, '=') != null or
            std.mem.indexOfScalar(u8, entry.key_ptr.*, 0) != null)
            return error.InvalidEnvironment;
        const item = switch (entry.value_ptr.*) {
            .string => |item| item,
            else => return error.InvalidEnvironment,
        };
        if (std.mem.indexOfScalar(u8, item, 0) != null)
            return error.InvalidEnvironment;
        result[index] = try std.fmt.allocPrint(
            allocator,
            "{s}={s}",
            .{ entry.key_ptr.*, item },
        );
    }
    return result;
}

fn validateSpawnStrings(
    cwd: []const u8,
    expected_executable: []const u8,
    argv: []const []const u8,
) !void {
    if (argv.len == 0) return error.EmptyProviderCommand;
    if (!std.fs.path.isAbsolute(cwd) or
        std.mem.indexOfScalar(u8, cwd, 0) != null)
        return error.InvalidWorkingDirectory;
    if (std.mem.indexOfScalar(u8, expected_executable, 0) != null)
        return error.InvalidExpectedExecutable;
    for (argv) |argument| {
        if (std.mem.indexOfScalar(u8, argument, 0) != null)
            return error.InvalidProviderArgument;
    }
}

fn geometryFixed16_16(value: f64) !u32 {
    const scale = 65_536.0;
    const maximum = @as(f64, @floatFromInt(std.math.maxInt(u32))) / scale;
    if (!std.math.isFinite(value) or value <= 0 or value > maximum)
        return error.InvalidGeometry;
    return @intFromFloat(value * scale);
}

fn verifyWorkspaceIdentity(pid: i32, start_token: []const u8) !void {
    const identity = switch (process_inspector.observeProcess(pid)) {
        .present => |identity| identity,
        .absent, .unobservable => return error.InvalidWorkspaceIdentity,
    };
    var storage: [64]u8 = undefined;
    const observed = try identity.start_token.format(&storage);
    if (!std.mem.eql(u8, observed, start_token))
        return error.InvalidWorkspaceIdentity;
}

const TimerClock = struct {
    timer: *std.time.Timer,

    fn now(context: *anyopaque) u64 {
        const self: *TimerClock = @ptrCast(@alignCast(context));
        return self.timer.read();
    }
};

const PersistenceCursor = struct {
    checkpoint_seq: ?u64 = null,
};

/// Streaming output batches persist the journal on the batch window; any path that needs the tail durable NOW (terminate, lease expiry, startup) or that just verified a checkpoint (which evicted the covered journal prefix) forces the rewrite.
const JournalPersist = enum { batched, forced };

fn persistTerminalState(
    state: *terminal_state.TerminalState,
    directory: std.fs.Dir,
    cursor: *PersistenceCursor,
    journal: JournalPersist,
) !void {
    const checkpoint_seq: ?u64 = if (state.checkpointAvailable()) checkpointWireSeq(state) else null;
    const new_checkpoint = checkpoint_seq != null and cursor.checkpoint_seq != checkpoint_seq;
    if (journal == .forced or new_checkpoint) {
        try state.persistJournal(directory);
    } else {
        try state.persistJournalIfDue(directory);
    }
    const seq = checkpoint_seq orelse return;
    if (cursor.checkpoint_seq == seq) return;
    try state.persistCheckpoints(directory);
    cursor.checkpoint_seq = seq;
}

fn refreshRegistration(
    core: *HostCore,
    state: *terminal_state.TerminalState,
) void {
    core.registration.record.output_seq = state.outputSeq();
    core.registration.record.checkpoint_seq = checkpointWireSeq(state);
}

/// The real terminal behind the neutral control plane's mutation seam. The neutral plane deliberately owns no terminal, so without this binding its resize handler has nothing to set and answers `unknown`. It performs the SAME two-part mutation the production resize path does: the PTY set with its post-set readback, and the shadow VT following the applied window so later checkpoints carry the real geometry rather than the create-time size. Setting the PTY alone would leave the shadow behind and make a restored checkpoint render at the wrong size.
const NeutralTerminalSource = struct {
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
    test_resize_columns_adjustment: u32 = 0,

    fn provider(self: *NeutralTerminalSource) neutral_evidence.TerminalProvider {
        return .{ .context = self, .resizeFn = resize };
    }

    fn resize(
        context: *anyopaque,
        window: neutral_contract.WindowSize,
        revision: u64,
    ) anyerror!neutral_evidence.TerminalResize {
        const self: *NeutralTerminalSource = @ptrCast(@alignCast(context));
        const columns = std.math.add(u32, window.columns, self.test_resize_columns_adjustment) catch
            return error.InvalidGeometry;
        var prepared = try self.state.prepareResize(.{
            .columns = columns,
            .rows = window.rows,
            .cell_width_px_16_16 = pty_host.cellFixed16_16(window.widthPixels, columns),
            .cell_height_px_16_16 = pty_host.cellFixed16_16(window.heightPixels, window.rows),
        });
        defer prepared.deinit();
        try self.state.applyPreparedResize(&prepared);
        const receipt = self.pty.resize(.{
            .columns = columns,
            .rows = window.rows,
            .width_px = window.widthPixels,
            .height_px = window.heightPixels,
        }, revision) catch |err| switch (err) {
            error.StaleResizeRevision => {
                try self.state.rollbackPreparedResize(&prepared);
                return .{ .superseded = try self.current() };
            },
            else => {
                try self.state.rollbackPreparedResize(&prepared);
                return err;
            },
        };
        self.state.finalizePreparedResize(&prepared);
        return .{ .applied = .{
            .revision = receipt.revision,
            .orderedAt = receipt.ordered_at,
            .readback = neutralWindow(receipt.readback),
        } };
    }

    /// The mutation has two halves and the PTY half lands first, so a failure in between leaves the shadow behind a terminal that has already moved. Reporting the terminal's order without repairing the shadow would let a retry be answered `applied` for a geometry the shadow does not hold, and a checkpoint taken afterwards would restore at the wrong size. So the shadow is brought into agreement here too, and if it cannot be, this reports nothing applied at all.
    fn current(self: *NeutralTerminalSource) !neutral_evidence.AppliedResize {
        var prepared = try self.state.prepareResize(.{
            .columns = self.pty.geometry.columns,
            .rows = self.pty.geometry.rows,
            .cell_width_px_16_16 = pty_host.cellFixed16_16(
                self.pty.geometry.width_px,
                self.pty.geometry.columns,
            ),
            .cell_height_px_16_16 = pty_host.cellFixed16_16(
                self.pty.geometry.height_px,
                self.pty.geometry.rows,
            ),
        });
        defer prepared.deinit();
        try self.state.applyPreparedResize(&prepared);
        self.state.finalizePreparedResize(&prepared);
        return .{
            .revision = self.pty.resizeRevision(),
            .orderedAt = self.pty.resizeOrderedAt(),
            .readback = neutralWindow(self.pty.geometry),
        };
    }

    fn neutralWindow(geometry: pty_host.Geometry) neutral_contract.WindowSize {
        return .{
            .columns = geometry.columns,
            .rows = geometry.rows,
            .widthPixels = geometry.width_px,
            .heightPixels = geometry.height_px,
        };
    }
};

const NeutralLiveEvidenceSource = struct {
    core: *HostCore,
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,

    fn provider(self: *NeutralLiveEvidenceSource) neutral_evidence.EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }

    fn measure(
        context: *anyopaque,
        allocator: std.mem.Allocator,
    ) !neutral_evidence.LiveEvidence {
        const self: *NeutralLiveEvidenceSource = @ptrCast(@alignCast(context));
        var diagnostics: std.ArrayList([]const u8) = .{};
        const foreground_process_group_id: ?i32 = self.pty.foregroundProcessGroupId() catch null;
        var newest_checkpoint: ?neutral_evidence.CheckpointSnapshot = null;
        if (self.state.newestCheckpoint()) |checkpoint| {
            const encoded_size = std.base64.standard.Encoder.calcSize(
                checkpoint.header.payload_length,
            );
            if (encoded_size > generated.limits.control_json_bytes) {
                try diagnostics.append(allocator, "checkpoint-body-exceeds-control-frame");
                try diagnostics.append(
                    allocator,
                    "checkpoint-body-omitted-from-bounded-control-projection",
                );
            } else {
                newest_checkpoint = .{
                    .contentType = "application/vnd.hive.terminal-checkpoint",
                    .schemaVersion = "HVTCP001",
                    .throughEventSequence = checkpoint.header.through_seq,
                    .throughOutputOffset = checkpoint.header.through_seq,
                    .opaqueBytes = try checkpoint.readOpaqueAlloc(allocator),
                };
            }
        }
        return .{
            .foregroundProcessGroupId = foreground_process_group_id,
            .newestCheckpoint = newest_checkpoint,
            .diagnostics = try diagnostics.toOwnedSlice(allocator),
        };
    }
};

fn refreshNeutralRecord(
    registry: *neutral_runtime.Registry,
    session: neutral_contract.SessionRef,
    core: *HostCore,
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
) !void {
    const checkpoint = state.newestCheckpoint();
    _ = try registry.update(session, .{
        .window = .{
            .columns = core.registration.record.geometry.columns,
            .rows = core.registration.record.geometry.rows,
            .widthPixels = core.registration.record.geometry.width_px,
            .heightPixels = core.registration.record.geometry.height_px,
        },
        .windowRevision = pty.resizeRevision(),
        .eventSequenceHighWater = state.outputSeq(),
        .output = .{
            .retainedStart = state.retainedOutputStart(),
            .retainedEndExclusive = state.outputSeq(),
            .closed = state.outputClosed(),
        },
        .checkpoints = .{
            .retained = state.retainedCheckpointCount(),
            .newestThroughEventSequence = if (checkpoint) |value| value.header.through_seq else null,
            .newestThroughOutputOffset = if (checkpoint) |value| value.header.through_seq else null,
        },
    });
}

const NeutralHostServing = struct {
    operations: *neutral_operations.HostOperations,
    core: *HostCore,

    fn handler(self: *NeutralHostServing) neutral_runtime.OperationHandler {
        return .{ .context = self, .callFn = call };
    }

    fn call(
        context: *anyopaque,
        request: neutral_runtime.OperationRequest,
    ) !neutral_runtime.OperationResponse {
        const self: *NeutralHostServing = @ptrCast(@alignCast(context));
        const response = self.operations.handler().call(request) catch |err| {
            switch (request.operation) {
                .inspect, .terminate => self.core.reconcileNeutralOperationFailure(err) catch {},
                else => {},
            }
            return err;
        };
        if (response.accepted) switch (request.operation) {
            .inspect => self.core.acceptNeutralInspection(response.payload) catch |err| {
                self.core.reconcileNeutralOperationFailure(err) catch {};
                return err;
            },
            .terminate => self.core.acceptNeutralTermination(response.payload) catch |err| {
                self.core.reconcileNeutralOperationFailure(err) catch {};
                return err;
            },
            else => {},
        };
        return response;
    }
};

fn serveNeutralAccepted(
    endpoint: *neutral_runtime.HostEndpoint,
    stream: std.net.Stream,
    handler: neutral_runtime.OperationHandler,
    timeout_ms: u64,
) !void {
    defer stream.close();
    try security.setBlocking(stream.handle, error.SocketBlockingFailed);
    try setControlTimeoutMs(stream.handle, timeout_ms);
    try endpoint.serveAccepted(stream, handler);
}

/// How long the host loop may sleep with no descriptor ready. Two obligations are answered on a
/// clock rather than by a descriptor and ride this tick: renewing the visibility lease, which has
/// to land inside `generated.limits.visibility_expiry_ms`, and checking for supervisor loss, which
/// has to keep observing the supervisor across `host_core.supervisor_grace_ns`. Both windows are
/// seconds wide, so this leaves each of them room to spare while an idle host does nothing at all
/// in between.
const host_tick_ms: isize = 1000;
const host_tick_ns: u64 = @as(u64, @intCast(host_tick_ms)) * std.time.ns_per_ms;

/// The host loop's blocking wait, so an idle terminal costs no CPU and a keystroke wakes the host
/// on the byte instead of on the next retry.
///
/// Registered once at `open`: the two listening sockets, the PTY master's read side, and the root
/// child process, which all outlive the loop; the PTY master's write side, left disabled because a
/// write only needs retrying while the ordered queue still holds bytes the master would not take;
/// and the tick timer, which is added exactly once because re-registering an EVFILT_TIMER restarts
/// its interval. Viewer sockets are registered as they attach — closing a descriptor removes its
/// registrations, so a detached viewer needs no matching call here.
///
/// `block` reports only the root-child exit event, whose one-shot kernel notification must be
/// retained across the next loop pass. Every descriptor source is still re-checked without
/// blocking, so their individual identities remain irrelevant.
const HostWait = struct {
    queue: std.posix.fd_t,
    pty_master: std.posix.fd_t,
    child_ident: usize,
    pty_write_armed: bool = false,

    /// EVFILT_TIMER identifies its registration by this number rather than by a descriptor. Any
    /// value is legal because the timer is the only non-descriptor filter on this queue.
    const timer_ident: usize = 0;

    fn open(
        host_listener: std.posix.fd_t,
        neutral_listener: std.posix.fd_t,
        pty_master: std.posix.fd_t,
        child_pid: i32,
    ) !HostWait {
        const queue = try std.posix.kqueue();
        errdefer std.posix.close(queue);
        const changes = [_]std.posix.Kevent{
            readChange(host_listener),
            readChange(neutral_listener),
            readChange(pty_master),
            .{
                .ident = @intCast(child_pid),
                .filter = @intCast(c.EVFILT_PROC),
                .flags = @intCast(c.EV_ADD | c.EV_ONESHOT),
                .fflags = @intCast(c.NOTE_EXIT),
                .data = 0,
                .udata = 0,
            },
            .{
                .ident = @intCast(pty_master),
                .filter = std.c.EVFILT.WRITE,
                .flags = std.c.EV.ADD | std.c.EV.DISABLE,
                .fflags = 0,
                .data = 0,
                .udata = 0,
            },
            .{
                .ident = timer_ident,
                .filter = std.c.EVFILT.TIMER,
                .flags = std.c.EV.ADD,
                // No NOTE_SECONDS/USECONDS/NSECONDS unit flag, which is what makes the period
                // below milliseconds.
                .fflags = 0,
                .data = host_tick_ms,
                .udata = 0,
            },
        };
        try submit(queue, &changes);
        return .{
            .queue = queue,
            .pty_master = pty_master,
            .child_ident = @intCast(child_pid),
        };
    }

    fn close(self: *HostWait) void {
        std.posix.close(self.queue);
        self.* = undefined;
    }

    fn watchViewer(self: *HostWait, viewer: std.posix.fd_t) !void {
        try submit(self.queue, &[_]std.posix.Kevent{readChange(viewer)});
    }

    /// Sleep until one of the registered sources is ready or the tick timer fires. `write_pending`
    /// is the PTY write queue's state: a short write leaves bytes behind that only the master
    /// becoming writable can retire, and watching for that unconditionally would wake the host
    /// continuously on an idle terminal whose master is always writable.
    fn block(self: *HostWait, write_pending: bool) !bool {
        if (write_pending != self.pty_write_armed) {
            try submit(self.queue, &[_]std.posix.Kevent{.{
                .ident = @intCast(self.pty_master),
                .filter = std.c.EVFILT.WRITE,
                .flags = if (write_pending) std.c.EV.ENABLE else std.c.EV.DISABLE,
                .fflags = 0,
                .data = 0,
                .udata = 0,
            }});
            self.pty_write_armed = write_pending;
        }
        // Events beyond this array stay queued and are reported on the next call, and the loop
        // body re-checks every source regardless, so its size bounds one syscall's output rather
        // than how much the host can notice.
        var ready: [8]std.posix.Kevent = undefined;
        const count = try std.posix.kevent(self.queue, &.{}, &ready, null);
        for (ready[0..count]) |event| {
            if (event.ident == self.child_ident and
                event.filter == @as(i16, @intCast(c.EVFILT_PROC)) and
                event.fflags & @as(u32, @intCast(c.NOTE_EXIT)) != 0)
                return true;
        }
        return false;
    }

    fn readChange(descriptor: std.posix.fd_t) std.posix.Kevent {
        return .{
            .ident = @intCast(descriptor),
            .filter = std.c.EVFILT.READ,
            .flags = std.c.EV.ADD,
            .fflags = 0,
            .data = 0,
            .udata = 0,
        };
    }

    /// Apply registrations without collecting events. An empty event list makes the kernel report
    /// a rejected registration as a failed call instead of burying it in the returned events.
    fn submit(queue: std.posix.fd_t, changes: []const std.posix.Kevent) !void {
        const immediately: std.posix.timespec = .{ .sec = 0, .nsec = 0 };
        _ = try std.posix.kevent(queue, changes, &.{}, &immediately);
    }
};

/// Everything a live host owes on a clock rather than on a descriptor becoming ready. Returns true
/// once supervisor loss has terminated this host, which ends the loop.
fn serviceHostTick(core: *HostCore, now_ns: u64) !bool {
    // A live host holds its own lease open. Nothing has to arrive for a terminal to keep living,
    // and nothing infers its death: the only things that end a terminal are an explicit
    // termination and the supervisor check below. Self-terminating on a supervisor this host could
    // no longer observe killed working agents whose vendor TUI was rendered and running.
    core.lease.touch(now_ns);
    // Without this the host cannot notice that the process which launched it is gone. A daemon
    // crash or a missed teardown would leave it reparented to launchd, holding its socket and
    // burning its provider's tokens, with nothing left that could ever ask it to stop.
    return core.enforceSupervisorLoss(now_ns);
}

fn runHostLoop(
    runtime: *HostRuntime,
    neutral_registry: *neutral_runtime.Registry,
    neutral_endpoint: *neutral_runtime.HostEndpoint,
    neutral_serving: *NeutralHostServing,
    core: *HostCore,
    timer: *std.time.Timer,
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
    real_engine: *RealVtEngine,
    persistence: *PersistenceCursor,
) !void {
    var attached: std.ArrayList(AttachedViewer) = .{};
    defer {
        while (attached.items.len > 0) {
            var viewer = attached.pop().?;
            viewer.close(core.allocator);
        }
        attached.deinit(core.allocator);
        state.setViewerFloor(null);
    }
    var wait = try HostWait.open(
        runtime.server.stream.handle,
        neutral_endpoint.server.stream.handle,
        pty.master_fd,
        pty.pid,
    );
    defer wait.close();
    // Zero makes the first pass tick, so a host launched by an already-dead supervisor notices at
    // once instead of outliving it by a tick.
    var next_tick_ns: u64 = 0;
    var root_exit_pending = false;
    while (!core.terminated) {
        refreshRegistration(core, state);
        const now_ns = timer.read();
        if (now_ns >= next_tick_ns) {
            next_tick_ns = now_ns + host_tick_ns;
            if (try serviceHostTick(core, now_ns)) break;
        }

        if (root_exit_pending) {
            while (true) {
                const output = pty.readAvailable() catch |err| switch (err) {
                    error.Closed => break,
                    else => return err,
                };
                if (output.bytes.len == 0) break;
                try state.feedOutput(output.bytes);
                try persistTerminalState(state, runtime.directory, persistence, .batched);
                refreshRegistration(core, state);
            }
            try persistTerminalState(state, runtime.directory, persistence, .forced);
            refreshRegistration(core, state);
            pumpAttachedViewers(core.allocator, &attached, core, state, timer);
            const response = try core.terminateBound(.immediate, null);
            core.allocator.free(response);
            break;
        }

        if (try runtime.accept()) |stream| {
            // A per-connection setup failure — a peer that reset the socket before setsockopt ran — drops THIS connection and keeps serving. It must never tear down the host: a single client cannot kill the terminal.
            if (!acceptedConnectionReady(stream.handle)) {
                std.log.err("host connection setup refused; dropping connection", .{});
                stream.close();
                continue;
            }
            const accepted = serveSessionConnection(
                core.allocator,
                stream,
                core,
                state,
                real_engine,
                timer,
            ) catch |err| blk: {
                std.log.err("host connection refused: {s}", .{@errorName(err)});
                break :blk null;
            };
            if (accepted) |viewer| {
                try installAttachedViewer(
                    core.allocator,
                    &attached,
                    state,
                    viewer,
                );
                try wait.watchViewer(viewer.stream.handle);
            } else {
                stream.close();
            }
            continue;
        }

        if (try neutral_endpoint.acceptIfReady()) |stream| {
            errdefer stream.close();
            refreshNeutralRecord(
                neutral_registry,
                neutral_endpoint.session,
                core,
                pty,
                state,
            ) catch |err| {
                std.log.err("neutral host evidence refresh failed: {s}", .{@errorName(err)});
                stream.close();
                continue;
            };
            serveNeutralAccepted(
                neutral_endpoint,
                stream,
                neutral_serving.handler(),
                generated.limits.control_rpc_timeout_ms,
            ) catch |err| {
                // A timeout after any partial frame is fatal to this stream; serveNeutralAccepted closes it; the next request is fresh.
                std.log.err("neutral host operation refused: {s}", .{@errorName(err)});
            };
            continue;
        }

        _ = pty.writeDrain() catch |err| switch (err) {
            error.Closed => {},
            else => return err,
        };
        const output = pty.readAvailable() catch |err| switch (err) {
            error.Closed => {
                try persistTerminalState(state, runtime.directory, persistence, .forced);
                refreshRegistration(core, state);
                // Best-effort tail push: every journaled byte reaches the attached viewers before the endpoint closes (drain).
                pumpAttachedViewers(core.allocator, &attached, core, state, timer);
                const response = try core.terminateBound(.immediate, null);
                core.allocator.free(response);
                break;
            },
            else => return err,
        };
        if (output.bytes.len > 0) {
            try state.feedOutput(output.bytes);
            try persistTerminalState(state, runtime.directory, persistence, .batched);
            refreshRegistration(core, state);
        }
        pumpAttachedViewers(core.allocator, &attached, core, state, timer);
        root_exit_pending = try wait.block(pty.write_queue.items.len > 0);
    }
}

pub const control_socket_env = "HIVE_HOST_CONTROL_SOCKET";

/// The control stream carrying the HVB1 boot message. A launcher that can hand a socketpair down as a descriptor passes nothing and this inherits fd 3. A launcher that cannot — anything that is not a forking C parent — names a socket it is already listening on, and the host dials it. Both produce the same private SOCK_STREAM, so everything after this point is identical; only who calls connect changes. The path is per-host, so accepting one connection on it is unambiguous without a correlation token.
fn openControlStream(allocator: std.mem.Allocator) !std.net.Stream {
    const path = std.process.getEnvVarOwned(allocator, control_socket_env) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return .{ .handle = inherited_control_fd },
        else => return err,
    };
    defer allocator.free(path);
    return std.net.connectUnixSocket(path);
}

pub fn runHostRole(
    allocator: std.mem.Allocator,
    roots: security.Roots,
) !void {
    const control = try openControlStream(allocator);
    defer control.close();
    runHostRoleWithControl(allocator, roots, control) catch |err| {
        host_registration.sendStartupFailure(
            allocator,
            control,
            err,
        ) catch {};
        return err;
    };
}

fn runHostRoleWithControl(
    allocator: std.mem.Allocator,
    roots: security.Roots,
    control: std.net.Stream,
) !void {
    try setControlTimeoutMs(control.handle, host_process.host_ready_timeout_ms);
    const control_file: std.fs.File = .{ .handle = control.handle };
    var boot = try readBootMessage(allocator, control_file.deprecatedReader());
    var boot_owned = true;
    defer if (boot_owned) boot.deinit(allocator);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.create_begin_payload,
        boot.spec_json,
    )) return error.InvalidCreatePayload;
    var spec = try std.json.parseFromSlice(WireCreateSpec, allocator, boot.spec_json, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    });
    defer spec.deinit();
    if (spec.value.schemaVersion != 1) return error.InvalidCreateSchemaVersion;
    try validateSpawnStrings(
        spec.value.cwd,
        spec.value.expectedExecutable,
        spec.value.argv,
    );
    try verifyWorkspaceIdentity(
        spec.value.visibility.workspacePid,
        spec.value.visibility.workspaceStartToken,
    );

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const locator = try parseLocator(a, spec.value.locator);
    const revision = try std.fmt.parseInt(
        u64,
        spec.value.visibility.openTerminalRevision,
        10,
    );
    if (revision == 0) return error.InvalidVisibilityRevision;
    const engine_build_digest = try RealVtEngine.engineBuildId();
    const engine_build_hex = std.fmt.bytesToHex(engine_build_digest, .lower);
    try requireEngineBuildId(locator.engine_build_id);

    var runtime = try HostRuntime.open(
        allocator,
        roots,
        locator.session_id,
        boot.adoption_secret,
    );
    defer runtime.deinit();
    var timer = try std.time.Timer.start();
    var timer_clock: TimerClock = .{ .timer = &timer };
    const start_ns = timer.read();

    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();

    var nh_runtime = try neutral_runtime.Runtime.open(allocator, roots);
    defer nh_runtime.deinit();
    var neutral_registry = try neutral_runtime.Registry.open(allocator, &nh_runtime);
    defer neutral_registry.deinit();
    var direct = neutral_host.DirectHost.init(allocator, &neutral_registry, &pty);
    defer direct.deinit();

    const created = try direct.host().create(.{
        // The neutral host never interprets the key; the Hive session id is simply the opaque name the adapter above already chose.
        .key = locator.session_id,
        .idempotencyKey = spec.value.visibility.openTerminalRevision,
        .command = .{
            .executable = spec.value.argv[0],
            .arguments = spec.value.argv[1..],
            .workingDirectory = spec.value.cwd,
            .completeEnvironment = try environmentEntries(a, spec.value.environment),
            .descriptorMap = &.{},
        },
        // Login-tty profile for interactive zsh + hive agent-ui. Default profile is
        // ICANON + ECHO + ISIG + OPOST|ONLCR + HUPCL. OpenTUI will raw the slave itself;
        // when it exits, zsh is already a normal interactive shell.
        .terminalProfile = .{
            .inputMode = .canonical,
            .echo = true,
            .signalCharacters = true,
            .softwareFlowControl = false,
            .eofByte = 4,
            .startByte = 17,
            .stopByte = 19,
            .hangupOnLastClose = true,
        },
        .initialWindow = .{
            .columns = spec.value.geometry.columns,
            .rows = spec.value.geometry.rows,
            .widthPixels = spec.value.geometry.widthPx,
            .heightPixels = spec.value.geometry.heightPx,
        },
    });
    const launch = switch (created.outcome) {
        .running => |value| value,
        .@"exec-failed" => |failure| {
            std.log.err("provider exec failed at {s}: {s}", .{
                @tagName(failure.layer),
                failure.diagnostic,
            });
            return error.ProviderExecFailed;
        },
        .exited, .unknown => return error.ProviderExecFailed,
    };
    _ = direct.launch_evidence orelse return error.ProviderExecFailed;

    var neutral_endpoint = try neutral_runtime.HostEndpoint.open(
        allocator,
        &nh_runtime,
        created.session,
    );
    defer neutral_endpoint.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    const real_engine = try RealVtEngine.create(
        allocator,
        spec.value.geometry.columns,
        spec.value.geometry.rows,
        sink.effectSink(),
    );
    var state = terminal_state.TerminalState.init(
        allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &timer_clock, .nowFn = TimerClock.now },
        &engine_build_digest,
        .{
            .columns = spec.value.geometry.columns,
            .rows = spec.value.geometry.rows,
            .cell_width_px_16_16 = try geometryFixed16_16(spec.value.geometry.cellWidthPx),
            .cell_height_px_16_16 = try geometryFixed16_16(spec.value.geometry.cellHeightPx),
        },
        runtime.directory,
    );
    defer state.deinit();
    var arbiter = input_arbiter.InputArbiter.init(sink.arbiterSink());
    defer arbiter.deinit();
    var persistence: PersistenceCursor = .{};
    try persistTerminalState(&state, runtime.directory, &persistence, .forced);

    const host_identity = switch (process_inspector.observeProcess(c.getpid())) {
        .present => |identity| identity,
        .absent, .unobservable => return error.HostIdentityUnavailable,
    };
    var host_token_storage: [64]u8 = undefined;
    const host_token = try host_identity.start_token.format(&host_token_storage);
    const root_token = launch.child.startToken;
    const host_executable = host_identity.executablePath();
    if (host_executable.len == 0) return error.HostIdentityUnavailable;
    const host_build_id = try executableBuildHash(allocator, host_executable);
    defer allocator.free(host_build_id);
    var expiry_storage: [24]u8 = undefined;
    const expires_at = try wall_clock.deadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    const registration: HostRegistration = .{
        .record = .{
            .locator = locator,
            .host_pid = c.getpid(),
            .host_start_token = try a.dupe(u8, host_token),
            .process_root = .{
                .pid = launch.child.processId,
                .start_token = try a.dupe(u8, root_token),
                .process_group_id = launch.jobControl.childProcessGroupId,
            },
            .expected_executable = spec.value.expectedExecutable,
            .executable_build_hash = try a.dupe(u8, host_build_id),
            .engine_build_id = try a.dupe(u8, &engine_build_hex),
            .protocol_major = generated.protocol_major,
            .protocol_minor = generated.protocol_minor,
            .geometry = .{
                .columns = @intCast(spec.value.geometry.columns),
                .rows = @intCast(spec.value.geometry.rows),
                .width_px = spec.value.geometry.widthPx,
                .height_px = spec.value.geometry.heightPx,
                .cell_width_px = spec.value.geometry.cellWidthPx,
                .cell_height_px = spec.value.geometry.cellHeightPx,
            },
            .state = .live,
            .visibility = .{
                .state = .attaching,
                .workspace_session_id = spec.value.visibility.workspaceSessionId,
                .open_terminal_revision = revision,
                .expires_mono_ns = try std.math.add(
                    u64,
                    start_ns,
                    generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
                ),
            },
            .output_seq = state.outputSeq(),
            .checkpoint_seq = checkpointWireSeq(&state),
        },
        .expires_at = try a.dupe(u8, expires_at),
    };
    var core = try HostCore.init(
        allocator,
        registration,
        boot.adoption_secret,
        host_executable,
        "pending-registration",
        start_ns,
    );
    defer core.deinit();
    core.bindTermination(.{
        .pty = &pty,
        .directory = runtime.directory,
        .arbiter = &arbiter,
    });
    core.bindSupervisor(host_core.SupervisorWatch.of(c.getppid()) orelse
        return error.SupervisorUnobservable);
    var live_evidence: NeutralLiveEvidenceSource = .{
        .core = &core,
        .pty = &pty,
        .state = &state,
    };
    var neutral_platform = process_inspector.RealPlatform.init();
    var neutral_terminal: NeutralTerminalSource = .{ .pty = &pty, .state = &state };
    var host_operations = try neutral_operations.HostOperations.initServingTerminal(
        allocator,
        &neutral_registry,
        neutral_endpoint.session,
        neutral_platform.platform(),
        live_evidence.provider(),
        neutral_evidence.EvidenceClock.system(),
        neutral_terminal.provider(),
    );
    defer host_operations.deinit();
    var neutral_serving: NeutralHostServing = .{
        .operations = &host_operations,
        .core = &core,
    };
    boot.deinit(allocator);
    boot_owned = false;
    errdefer if (!core.terminated) {
        const response = core.terminateBound(.immediate, "HOST_START_FAILED") catch null;
        if (response) |bytes| allocator.free(bytes);
    };

    try sendReadyAfterBoot(
        allocator,
        control,
        core.registration,
    );
    try host_registration.waitForReadyAcknowledgement(allocator, control);
    core.broker_build_id = host_build_id;
    try runHostLoop(
        &runtime,
        &neutral_registry,
        &neutral_endpoint,
        &neutral_serving,
        &core,
        &timer,
        &pty,
        &state,
        real_engine,
        &persistence,
    );
}

test "ready neutral endpoint drops a timed-out partial frame" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &root_storage,
        "/tmp/nho-{x}",
        .{std.crypto.random.int(u64)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{});
    try root_directory.chmod(0o700);
    root_directory.close();

    var runtime = try neutral_runtime.Runtime.open(
        std.testing.allocator,
        .{ .socket = root, .state = root },
    );
    defer runtime.deinit();
    var registry = try neutral_runtime.Registry.open(std.testing.allocator, &runtime);
    defer registry.deinit();
    const reserved = try registry.reserve(
        "partial-frame-proof",
        "partial-frame-proof-create",
        @splat(0x41),
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    );
    const session = switch (reserved) {
        .reserved => |record| record.session,
        .existing => return error.UnexpectedNeutralSessionReplay,
    };
    var endpoint = try neutral_runtime.HostEndpoint.open(
        std.testing.allocator,
        &runtime,
        session,
    );
    defer endpoint.deinit();
    try std.testing.expect((try endpoint.acceptIfReady()) == null);

    const client = try std.net.connectUnixSocket(endpoint.socketPath);
    defer client.close();
    var accepted: ?std.net.Stream = null;
    var attempts: usize = 0;
    while (accepted == null and attempts < 100) : (attempts += 1) {
        accepted = try endpoint.acceptIfReady();
        if (accepted == null) std.Thread.sleep(std.time.ns_per_ms);
    }
    const server = accepted orelse return error.NeutralEndpointNotReady;
    try client.writeAll("NHOP");

    const NeverCalled = struct {
        called: bool = false,

        fn operation(
            context: *anyopaque,
            _: neutral_runtime.OperationRequest,
        ) !neutral_runtime.OperationResponse {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.called = true;
            return .{ .payload = "unexpected" };
        }

        fn handler(self: *@This()) neutral_runtime.OperationHandler {
            return .{ .context = self, .callFn = operation };
        }
    };
    var handler: NeverCalled = .{};
    if (serveNeutralAccepted(&endpoint, server, handler.handler(), 5)) |_| {
        return error.PartialOperationFrameAccepted;
    } else |_| {}
    try std.testing.expect(!handler.called);
}

test "WELCOME engine build id passes create validation and a wrong id fails" {
    const welcome_engine_build_id = try session_types.engineBuildIdHex();
    try requireEngineBuildId(&welcome_engine_build_id);
    var wrong = welcome_engine_build_id;
    wrong[0] = if (wrong[0] == '0') '1' else '0';
    try std.testing.expectError(error.EngineMismatch, requireEngineBuildId(&wrong));
}

test "a running host holds its own lease open" {
    const start_ns: u64 = 1_000;
    var lease = try VisibilityLease.initial("workspace-1", 7, start_ns);
    const first = lease.expires_mono_ns;
    try std.testing.expect(!lease.expired(first - 1));

    // Past the unrenewed deadline with no renewal from anywhere: the host is still running, so it touches its own lease and the terminal lives. A running host holds its own lease open: reading an unrenewed lease as death kills working agents whose vendor TUI is rendered and running.
    lease.touch(first + 1);
    try std.testing.expect(lease.expires_mono_ns > first);
    try std.testing.expect(!lease.expired(first + 1));
}

test "spawn strings reject C ABI truncation with a valid control" {
    const valid_argv = [_][]const u8{ "/bin/sh", "-c" };
    try validateSpawnStrings("/tmp", "/bin/sh", &valid_argv);

    const invalid_argv = [_][]const u8{"/bin/sh\x00ignored"};
    try std.testing.expectError(
        error.InvalidProviderArgument,
        validateSpawnStrings("/tmp", "/bin/sh", &invalid_argv),
    );
    try std.testing.expectError(
        error.InvalidWorkingDirectory,
        validateSpawnStrings("/tmp\x00ignored", "/bin/sh", &valid_argv),
    );
}

test "terminal cell metrics fail closed before 16.16 conversion" {
    try std.testing.expectEqual(
        @as(u32, 10 << 16),
        try geometryFixed16_16(10),
    );
    try std.testing.expectError(
        error.InvalidGeometry,
        geometryFixed16_16(100_000),
    );
    try std.testing.expectError(
        error.InvalidGeometry,
        geometryFixed16_16(0),
    );
}

test "environment strings reject ambiguous execve entries with a valid control" {
    var valid = try std.json.parseFromSlice(
        std.json.Value,
        std.testing.allocator,
        "{\"KEY\":\"value\"}",
        .{},
    );
    defer valid.deinit();
    var valid_arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer valid_arena.deinit();
    const entries = try environmentStrings(valid_arena.allocator(), valid.value);
    try std.testing.expectEqual(@as(usize, 1), entries.len);
    try std.testing.expectEqualStrings("KEY=value", entries[0]);

    const invalid_json = [_][]const u8{
        "{\"\":\"value\"}",
        "{\"BAD=KEY\":\"value\"}",
        "{\"KEY\":\"before\\u0000after\"}",
    };
    for (invalid_json) |source| {
        var parsed = try std.json.parseFromSlice(
            std.json.Value,
            std.testing.allocator,
            source,
            .{},
        );
        defer parsed.deinit();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        try std.testing.expectError(
            error.InvalidEnvironment,
            environmentStrings(arena.allocator(), parsed.value),
        );
    }
}

test "bridge export is copied into the caller Zig allocator" {
    const Fixture = struct {
        bytes: [4]u8 = .{ 1, 2, 3, 4 },
        freed: bool = false,

        fn exportBytes(context: *anyopaque, out: *?[*]u8, len: *usize) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            out.* = @ptrCast(&self.bytes);
            len.* = self.bytes.len;
        }

        fn free(context: *anyopaque, _: [*]u8, _: usize) void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.freed = true;
        }
    };
    var fixture: Fixture = .{};
    const copied = try (BridgeExport{
        .context = &fixture,
        .exportFn = Fixture.exportBytes,
        .freeFn = Fixture.free,
    }).copyInto(std.testing.allocator);
    defer std.testing.allocator.free(copied);
    try std.testing.expect(fixture.freed);
    try std.testing.expectEqualSlices(u8, &fixture.bytes, copied);
    try std.testing.expect(@intFromPtr(copied.ptr) != @intFromPtr(&fixture.bytes));
}

test "live VT effects use only the bounded PTY sink with an audit control" {
    const Recorder = struct {
        bytes: std.ArrayList(u8) = .{},

        fn write(context: *anyopaque, bytes: []const u8) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            try self.bytes.appendSlice(std.testing.allocator, bytes);
        }
    };
    var recorder: Recorder = .{};
    defer recorder.bytes.deinit(std.testing.allocator);
    const live = try RealVtEngine.create(std.testing.allocator, 80, 24, .{
        .context = &recorder,
        .writeFn = Recorder.write,
    });
    defer live.engine().deinit();
    const reply = "terminal-reply";
    RealVtEngine.writePtyCallback(live.terminal, live, reply.ptr, reply.len);
    try std.testing.expectEqualStrings(reply, recorder.bytes.items);
    try std.testing.expectEqual(@as(usize, 0), live.effects.items.len);
    try std.testing.expect(!live.effect_failed);
    RealVtEngine.writePtyCallback(live.terminal, live, null, 0);
    try std.testing.expect(!live.effect_failed);
    RealVtEngine.writePtyCallback(live.terminal, live, null, 1);
    try std.testing.expect(live.effect_failed);

    const audit = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    defer audit.engine().deinit();
    RealVtEngine.writePtyCallback(audit.terminal, audit, reply.ptr, reply.len);
    try std.testing.expectEqualStrings(reply, audit.effects.items);
}

test "real libghostty-vt export is copied and TerminalState is sole engine owner" {
    const options = RealVtEngine.terminalOptions(80, 24);
    try std.testing.expectEqual(canonical_scrollback_bytes, options.max_scrollback);
    var clock_context: u8 = 0;
    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine = real_engine.engine();
    try engine.write("hello\x1b[31m world");
    const exported = try engine.exportOpaque(std.testing.allocator);
    defer std.testing.allocator.free(exported);
    try std.testing.expect(exported.len > 0);
    try std.testing.expect(real_engine.last_bridge_address != 0);
    try std.testing.expect(real_engine.last_copy_address == @intFromPtr(exported.ptr));
    try std.testing.expect(real_engine.last_bridge_address != real_engine.last_copy_address);

    const engine_build_id = try RealVtEngine.engineBuildId();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        engine,
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = FixedClock.now },
        &engine_build_id,
        .{
            .columns = 80,
            .rows = 24,
            .cell_width_px_16_16 = 10 << 16,
            .cell_height_px_16_16 = 20 << 16,
        },
        temporary.dir,
    );
    defer state.deinit();
    try state.feedOutput("checkpoint-me");
    try state.tryCheckpoint();
    try std.testing.expect(state.checkpointAvailable());
    try std.testing.expect(checkpointWireSeq(&state) == state.outputSeq());
    var cursor: PersistenceCursor = .{};
    try persistTerminalState(&state, temporary.dir, &cursor, .forced);
    const first_checkpoint = try std.posix.fstatat(
        temporary.dir.fd,
        "checkpoint-0.bin",
        std.posix.AT.SYMLINK_NOFOLLOW,
    );
    try state.feedOutput("tail");
    try persistTerminalState(&state, temporary.dir, &cursor, .forced);
    const unchanged_checkpoint = try std.posix.fstatat(
        temporary.dir.fd,
        "checkpoint-0.bin",
        std.posix.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expectEqual(first_checkpoint.ino, unchanged_checkpoint.ino);
}

fn drainReadable(stream: std.net.Stream, sink: *std.ArrayList(u8)) !void {
    var buf: [4096]u8 = undefined;
    while (true) {
        var fds = [_]std.posix.pollfd{.{
            .fd = stream.handle,
            .events = std.posix.POLL.IN,
            .revents = 0,
        }};
        const ready = std.posix.poll(&fds, 0) catch 0;
        if (ready == 0 or fds[0].revents == 0) return;
        const read = try std.posix.read(stream.handle, &buf);
        if (read == 0) return;
        try sink.appendSlice(std.testing.allocator, buf[0..read]);
    }
}

test "a checkpoint inside feedOutput never detaches the attached viewer" {
    const AdvancingClock = struct {
        nanos: u64 = 0,
        fn now(context: *anyopaque) u64 {
            const self: *@This() = @ptrCast(@alignCast(context));
            return self.nanos;
        }
    };
    var clock: AdvancingClock = .{};

    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine_build_id = try RealVtEngine.engineBuildId();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &clock, .nowFn = AdvancingClock.now },
        &engine_build_id,
        .{
            .columns = 80,
            .rows = 24,
            .cell_width_px_16_16 = 10 << 16,
            .cell_height_px_16_16 = 20 << 16,
        },
        temporary.dir,
    );
    defer state.deinit();

    const secret: [32]u8 = @splat(0x3c);
    var core = try HostCore.init(
        std.testing.allocator,
        fixtureRegistration(),
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        0,
    );
    defer core.deinit();
    var timer = try std.time.Timer.start();

    const sockets = try socketPair();
    var peer_open = true;
    defer if (peer_open) sockets[1].close();
    var attached: std.ArrayList(AttachedViewer) = .{};
    defer {
        for (attached.items) |*viewer| viewer.close(std.testing.allocator);
        attached.deinit(std.testing.allocator);
    }
    try attached.append(std.testing.allocator, .{
        .stream = sockets[0],
        .authorization = .{
            .viewer_id = try std.testing.allocator.dupe(u8, "viewer-a"),
            .operations = .{ .view = true },
            .geometry = fixtureRegistration().record.geometry,
            .after_seq = 0,
        },
        .sent_seq = 0,
        .acked_seq = 0,
    });
    publishViewerFloor(&attached, &state);

    var received: std.ArrayList(u8) = .{};
    defer received.deinit(std.testing.allocator);

    try state.feedOutput("first");
    pumpAttachedViewers(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expectEqual(@as(usize, 1), attached.items.len);
    try std.testing.expectEqual(@as(u64, 5), attached.items[0].sent_seq);
    try drainReadable(sockets[1], &received);
    try std.testing.expect(std.mem.indexOf(u8, received.items, "first") != null);

    // Loop iteration two: the 30s interval has elapsed, so feedOutput checkpoints and evicts before the pump ever runs.
    clock.nanos += terminal_state.checkpoint_interval_ns;
    try state.feedOutput("second");
    try std.testing.expect(state.checkpointSeq() > 0);

    pumpAttachedViewers(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expectEqual(@as(usize, 1), attached.items.len);
    try std.testing.expectEqual(@as(u64, 11), attached.items[0].sent_seq);
    try std.testing.expect(state.retainedOutputStart() <= 5);
    try drainReadable(sockets[1], &received);
    try std.testing.expect(std.mem.indexOf(u8, received.items, "second") != null);

    peer_open = false;
    sockets[1].close();
    pumpAttachedViewers(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expectEqual(@as(usize, 0), attached.items.len);
    try std.testing.expect(state.viewer_floor_seq == null);
}

test "daemon viewer coexists with renderer and detaches independently" {
    var clock_context: u8 = 0;

    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine_build_id = try RealVtEngine.engineBuildId();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = FixedClock.now },
        &engine_build_id,
        .{
            .columns = 80,
            .rows = 24,
            .cell_width_px_16_16 = 10 << 16,
            .cell_height_px_16_16 = 20 << 16,
        },
        temporary.dir,
    );
    defer state.deinit();

    const secret: [32]u8 = @splat(0x4d);
    var core = try HostCore.init(
        std.testing.allocator,
        fixtureRegistration(),
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        0,
    );
    defer core.deinit();
    var timer = try std.time.Timer.start();

    const renderer_sockets = try socketPair();
    defer renderer_sockets[1].close();
    const daemon_sockets = try socketPair();
    var daemon_peer_open = true;
    defer if (daemon_peer_open) daemon_sockets[1].close();

    var attached: std.ArrayList(AttachedViewer) = .{};
    defer {
        for (attached.items) |*viewer| viewer.close(std.testing.allocator);
        attached.deinit(std.testing.allocator);
    }
    try installAttachedViewer(
        std.testing.allocator,
        &attached,
        &state,
        .{
            .stream = renderer_sockets[0],
            .authorization = .{
                .viewer_id = try std.testing.allocator.dupe(u8, "workspace-pane-queen"),
                .operations = .{ .view = true },
                .geometry = fixtureRegistration().record.geometry,
                .after_seq = 0,
            },
            .sent_seq = 0,
            .acked_seq = 0,
        },
    );
    try installAttachedViewer(
        std.testing.allocator,
        &attached,
        &state,
        .{
            .stream = daemon_sockets[0],
            .authorization = .{
                .viewer_id = try std.testing.allocator.dupe(u8, "hive-daemon:fixture"),
                .operations = .{ .view = true, .user_input = true },
                .geometry = fixtureRegistration().record.geometry,
                .after_seq = 0,
            },
            .sent_seq = 0,
            .acked_seq = 0,
        },
    );
    try std.testing.expectEqual(@as(usize, 2), attached.items.len);

    try state.feedOutput("wake");
    pumpAttachedViewers(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expectEqual(@as(usize, 2), attached.items.len);
    var renderer_received: std.ArrayList(u8) = .{};
    defer renderer_received.deinit(std.testing.allocator);
    var daemon_received: std.ArrayList(u8) = .{};
    defer daemon_received.deinit(std.testing.allocator);
    try drainReadable(renderer_sockets[1], &renderer_received);
    try drainReadable(daemon_sockets[1], &daemon_received);
    try std.testing.expect(std.mem.indexOf(u8, renderer_received.items, "wake") != null);
    try std.testing.expect(std.mem.indexOf(u8, daemon_received.items, "wake") != null);

    daemon_peer_open = false;
    daemon_sockets[1].close();
    pumpAttachedViewers(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expectEqual(@as(usize, 1), attached.items.len);
    try std.testing.expectEqualStrings(
        "workspace-pane-queen",
        attached.items[0].authorization.viewer_id,
    );

    try state.feedOutput("-still-live");
    pumpAttachedViewers(std.testing.allocator, &attached, &core, &state, &timer);
    try drainReadable(renderer_sockets[1], &renderer_received);
    try std.testing.expect(
        std.mem.indexOf(u8, renderer_received.items, "still-live") != null,
    );
}

// The journal-pressure path deliberately evicts past the viewer floor, and the viewer it drops is by definition one whose unacknowledged window is full. If the pump tested backpressure first it would skip the cursor read forever: the lost range would never be observed, the socket would stay open, and the pane would freeze silently — which contract forbids.
test "retention loss detaches a viewer whose unacknowledged window is full" {
    var clock_context: u8 = 0;

    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine_build_id = try RealVtEngine.engineBuildId();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = FixedClock.now },
        &engine_build_id,
        .{ .columns = 80, .rows = 24 },
        temporary.dir,
    );
    defer state.deinit();

    const secret: [32]u8 = @splat(0x3d);
    var core = try HostCore.init(
        std.testing.allocator,
        fixtureRegistration(),
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        0,
    );
    defer core.deinit();
    var timer = try std.time.Timer.start();

    const sockets = try socketPair();
    defer sockets[1].close();

    const window = generated.limits.viewer_queue_bytes;
    state.journal.start_seq = window + 1;
    state.output_seq = window + 1;
    var attached: std.ArrayList(AttachedViewer) = .{};
    defer {
        for (attached.items) |*viewer| viewer.close(std.testing.allocator);
        attached.deinit(std.testing.allocator);
    }
    try attached.append(std.testing.allocator, .{
        .stream = sockets[0],
        .authorization = .{
            .viewer_id = try std.testing.allocator.dupe(u8, "viewer-b"),
            .operations = .{ .view = true },
            .geometry = fixtureRegistration().record.geometry,
            .after_seq = 0,
        },
        .sent_seq = window,
        .acked_seq = 0,
    });
    publishViewerFloor(&attached, &state);
    // Precondition: the backpressure gate really is shut, so this test cannot pass through the ordinary push-then-fail route.
    try std.testing.expect(
        attached.items[0].sent_seq - attached.items[0].acked_seq >= window,
    );
    try std.testing.expect(state.retainedOutputStart() > attached.items[0].sent_seq);

    pumpAttachedViewers(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expectEqual(@as(usize, 0), attached.items.len);
    try std.testing.expect(state.viewer_floor_seq == null);

    // Peer-observable: EOF, not an open socket that never speaks again. The wire cannot carry a typed failure here (ERROR is response-flagged and an unsolicited request_id 0 is malformed), so the close IS the signal, and the re-attach types the gap.
    var eof: [1]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), try std.posix.read(sockets[1].handle, &eof));
}

test "host runtime accepts the launcher layout and rejects a public hosts directory" {
    var path_storage: [96]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &path_storage,
        "/tmp/h{x}",
        .{std.crypto.random.int(u32)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    const session_id = "ses_018f1e90-7b5a-7cc0-8000-0000000000a1";
    var state_root = try std.fs.openDirAbsolute(root, .{});
    defer state_root.close();
    try state_root.makePath("hosts/ses_018f1e90-7b5a-7cc0-8000-0000000000a1");
    // The root's own mode is the caller's business — it is asserted for ownership only, so a
    // group-readable root must still be accepted. Privacy is enforced from `hosts` inward.
    try state_root.chmod(0o755);
    var hosts = try state_root.openDir("hosts", .{ .no_follow = true });
    defer hosts.close();
    try hosts.chmod(0o700);
    var directory = try hosts.openDir(session_id, .{ .no_follow = true });
    defer directory.close();
    try directory.chmod(0o700);
    const secret: [32]u8 = @splat(0x5a);
    var secret_file = try directory.createFile("adopt.cap", .{ .mode = 0o600, .exclusive = true });
    try secret_file.chmod(0o600);
    try secret_file.writeAll(&secret);
    secret_file.close();
    const roots: security.Roots = .{ .socket = root, .state = root };
    var host_runtime = try HostRuntime.open(
        std.testing.allocator,
        roots,
        session_id,
        secret,
    );
    // The socket is bound under the socket root, not inside the session's state directory — the
    // state directory is free to sit under a home too long to bind in.
    try std.testing.expect(std.mem.endsWith(
        u8,
        host_runtime.socket_path,
        &host_process.hostSocketName(session_id),
    ));
    _ = try std.fs.cwd().statFile(host_runtime.socket_path);
    host_runtime.deinit();

    try hosts.chmod(0o755);
    try std.testing.expectError(
        error.DirectorySubstitution,
        HostRuntime.open(std.testing.allocator, roots, session_id, secret),
    );
}

test "a session reclaims its own dead socket and is refused its live one" {
    var path_storage: [96]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &path_storage,
        "/tmp/hr{x}",
        .{std.crypto.random.int(u32)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    const session_id = "ses_018f1e90-7b5a-7cc0-8000-0000000000a1";
    var state_root = try std.fs.openDirAbsolute(root, .{});
    defer state_root.close();
    try state_root.makePath("hosts/ses_018f1e90-7b5a-7cc0-8000-0000000000a1");
    var hosts = try state_root.openDir("hosts", .{ .no_follow = true });
    defer hosts.close();
    try hosts.chmod(0o700);
    var directory = try hosts.openDir(session_id, .{ .no_follow = true });
    defer directory.close();
    try directory.chmod(0o700);
    const secret: [32]u8 = @splat(0x5a);
    var secret_file = try directory.createFile("adopt.cap", .{ .mode = 0o600, .exclusive = true });
    try secret_file.chmod(0o600);
    try secret_file.writeAll(&secret);
    secret_file.close();
    const roots: security.Roots = .{ .socket = root, .state = root };

    // A socket left behind by a host that died without unlinking: bound, then closed with the
    // inode still on disk. This is what a SIGKILLed terminal leaves under a root nothing sweeps.
    const name = host_process.hostSocketName(session_id);
    const stale_path = try std.fs.path.join(std.testing.allocator, &.{ root, &name });
    defer std.testing.allocator.free(stale_path);
    {
        const stale_address = try std.net.Address.initUnix(stale_path);
        const saved_umask = std.c.umask(0o177);
        var corpse = try stale_address.listen(.{});
        _ = std.c.umask(saved_umask);
        corpse.deinit();
    }
    _ = try std.fs.cwd().statFile(stale_path);

    // STALE: the name is taken and nobody is behind it, so the session gets its socket back.
    var reclaimed = try HostRuntime.open(std.testing.allocator, roots, session_id, secret);
    _ = try std.fs.cwd().statFile(reclaimed.socket_path);

    // LIVE: the same name, while the first host is still serving it, is refused — and the refusal
    // must leave that socket exactly where it is. A reclaim that unlinked first would pass the
    // refusal check above and still have handed one session's address to two hosts.
    try std.testing.expectError(
        error.SocketAddressHeldByLiveHost,
        HostRuntime.open(std.testing.allocator, roots, session_id, secret),
    );
    _ = try std.fs.cwd().statFile(reclaimed.socket_path);
    const survivor = try std.net.connectUnixSocket(reclaimed.socket_path);
    survivor.close();
    reclaimed.deinit();
}

test "the host socket root is preflighted against sun_path, as the neutral one already was" {
    var path_storage: [96]u8 = undefined;
    const base = try std.fmt.bufPrint(
        &path_storage,
        "/tmp/hp{x}",
        .{std.crypto.random.int(u32)},
    );
    try std.fs.makeDirAbsolute(base);
    defer std.fs.deleteTreeAbsolute(base) catch {};
    const session_id = "ses_018f1e90-7b5a-7cc0-8000-0000000000a1";
    var state_root = try std.fs.openDirAbsolute(base, .{});
    defer state_root.close();
    try state_root.makePath("hosts/ses_018f1e90-7b5a-7cc0-8000-0000000000a1");
    var hosts = try state_root.openDir("hosts", .{ .no_follow = true });
    defer hosts.close();
    try hosts.chmod(0o700);
    var directory = try hosts.openDir(session_id, .{ .no_follow = true });
    defer directory.close();
    try directory.chmod(0o700);
    const secret: [32]u8 = @splat(0x5a);
    var secret_file = try directory.createFile("adopt.cap", .{ .mode = 0o600, .exclusive = true });
    try secret_file.chmod(0o600);
    try secret_file.writeAll(&secret);
    secret_file.close();

    // A socket root one byte too long to hold any socket name. Before this preflight the host path
    // never measured anything and the bind failed as a bare NameTooLong from inside boot.
    const overlong_name: [90]u8 = @splat('x');
    try state_root.makeDir(&overlong_name);
    const overlong = try std.fs.path.join(std.testing.allocator, &.{ base, &overlong_name });
    defer std.testing.allocator.free(overlong);
    try std.testing.expectError(error.SocketPathTooLong, HostRuntime.open(
        std.testing.allocator,
        .{ .socket = overlong, .state = base },
        session_id,
        secret,
    ));

    // Positive control: the identical layout with a root that fits opens, so the refusal above is
    // the length and nothing else.
    var accepted = try HostRuntime.open(
        std.testing.allocator,
        .{ .socket = base, .state = base },
        session_id,
        secret,
    );
    accepted.deinit();
}

const FixedClock = struct {
    fn now(_: *anyopaque) u64 {
        return 1;
    }
};

fn fixtureRegistration() HostRegistration {
    return .{
        .record = .{
            .locator = .{
                .instance_id = "instance-a",
                .session_id = "ses_01890f9e-7b9a-7cc2-8e2b-8c6b8b8b8b8b",
                .generation = 1,
                .subject = .{ .agent = "agent-a" },
                .host_kind = .sessiond,
                .engine_build_id = "engine-build-a",
            },
            .host_pid = 123,
            .host_start_token = "100:2",
            .process_root = .{
                .pid = 124,
                .start_token = "101:3",
                .process_group_id = 124,
            },
            .expected_executable = "/usr/bin/true",
            .executable_build_hash = "host-build-a",
            .engine_build_id = "engine-build-a",
            .protocol_major = generated.protocol_major,
            .protocol_minor = generated.protocol_minor,
            .geometry = .{
                .columns = 80,
                .rows = 24,
                .width_px = 800,
                .height_px = 480,
                .cell_width_px = 10,
                .cell_height_px = 20,
            },
            .state = .live,
            .visibility = .{
                .state = .attaching,
                .workspace_session_id = "workspace-a",
                .open_terminal_revision = 1,
                .expires_mono_ns = 15 * std.time.ns_per_s,
            },
            .output_seq = 0,
            .checkpoint_seq = 0,
        },
        .expires_at = "2026-07-17T14:30:15.000Z",
    };
}

test "HOST_REGISTER uses its generated strict schema" {
    const registration = fixtureRegistration();
    const host_register = try encodeHostRegister(std.testing.allocator, registration);
    defer std.testing.allocator.free(host_register);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_register_payload,
        host_register,
    ));
}

fn socketPair() ![2]std.net.Stream {
    var sockets: [2]c_int = .{ -1, -1 };
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, &sockets) != 0)
        return error.SocketPairFailed;
    return .{
        .{ .handle = sockets[0] },
        .{ .handle = sockets[1] },
    };
}

test "fresh child reports its real startup failure instead of an invalid frame" {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    try host_registration.sendStartupFailure(
        std.testing.allocator,
        sockets[1],
        error.ProviderExecFailed,
    );
    var failure = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer failure.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.@"error", failure.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        failure.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.error_payload,
        failure.payload,
    ));
    try std.testing.expect(std.mem.indexOf(u8, failure.payload, "ProviderExecFailed") != null);
}

fn adoptionChallenge(
    allocator: std.mem.Allocator,
    locator: session_types.Locator,
    secret: [32]u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const secret_hex = std.fmt.bytesToHex(secret, .lower);
    var root = std.json.ObjectMap.init(a);
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("adoptionSecretHex", .{ .string = try a.dupe(u8, &secret_hex) });
    try root.put("expectedLocator", try locatorValue(a, locator));
    try root.put("brokerBuildId", .{ .string = "host-build-a" });
    try root.put("protocol", try protocolValue(a, generated.protocol_major, generated.protocol_minor));
    try root.put("operation", .{ .string = "adopt" });
    return std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
}

test "HOST_ADOPT returns exact identity only for matching secret and live lease" {
    const secret: [32]u8 = @splat(0x7b);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, secret);
    defer std.testing.allocator.free(challenge);
    const response = try core.adopt(challenge, "host-build-a", 2_000);
    defer std.testing.allocator.free(response);
    try std.testing.expect(core.adopted);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_adopt_payload,
        response,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response, "\"executable\":\"/tmp/hive-sessiond\"") != null);
}

test "HOST_ADOPT positive controls reject wrong secret and expired lease" {
    const secret: [32]u8 = @splat(0x7b);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const wrong: [32]u8 = @splat(0x7c);
    const wrong_challenge = try adoptionChallenge(
        std.testing.allocator,
        registration.record.locator,
        wrong,
    );
    defer std.testing.allocator.free(wrong_challenge);
    try std.testing.expectError(
        error.InvalidAdoption,
        core.adopt(wrong_challenge, "host-build-a", 2_000),
    );
    try std.testing.expect(!core.adopted);

    const good_challenge = try adoptionChallenge(
        std.testing.allocator,
        registration.record.locator,
        secret,
    );
    defer std.testing.allocator.free(good_challenge);
    const expired_at = 1_000 + generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expectError(
        error.VisibilityExpired,
        core.adopt(good_challenge, "host-build-a", expired_at),
    );
    try std.testing.expect(!core.adopted);
}

const HostConnectionThread = struct {
    stream: std.net.Stream,
    core: *HostCore,
    state: ?*terminal_state.TerminalState = null,
    real_engine: ?*RealVtEngine = null,
    now_ns: u64,
    budget_ms: u64 = generated.limits.control_rpc_timeout_ms,
    failure: ?anyerror = null,

    fn run(self: *@This()) void {
        serveHostConnectionWithTerminal(
            std.heap.c_allocator,
            self.stream,
            self.core,
            self.state,
            self.real_engine,
            self.now_ns,
            self.budget_ms,
        ) catch |err| {
            self.failure = err;
        };
    }
};

fn writeTestBrokerHello(stream: std.net.Stream, registration: HostRegistration) !void {
    const hello = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .buildId = "host-build-a",
        .instanceId = registration.record.locator.instance_id,
        .protocol = .{
            .major = generated.protocol_major,
            .minMinor = generated.protocol_minor,
            .maxMinor = generated.protocol_minor,
        },
        .clientRole = "broker",
    }, .{});
    defer std.testing.allocator.free(hello);
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.hello,
        .flags = 0,
        .payload_length = @intCast(hello.len),
        .request_id = 1,
        .stream_seq = 0,
    }, hello);
}

fn readTestWelcome(stream: std.net.Stream) !void {
    var welcome = try readRequiredFrame(std.testing.allocator, stream);
    defer welcome.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.welcome, welcome.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.welcome_payload,
        welcome.payload,
    ));
}

fn writeTestAdopt(stream: std.net.Stream, challenge: []const u8) !void {
    try writeTestHostRequest(stream, generated.frame_type.host_adopt, challenge);
}

fn writeTestHostRequest(
    stream: std.net.Stream,
    type_code: u16,
    payload: []const u8,
) !void {
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = type_code,
        .flags = 0,
        .payload_length = @intCast(payload.len),
        .request_id = 2,
        .stream_seq = 0,
    }, payload);
}

test "host.sock dispatcher authenticates HELLO and serves HOST_ADOPT" {
    const secret: [32]u8 = @splat(0x4d);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, secret);
    defer std.testing.allocator.free(challenge);
    try writeTestAdopt(sockets[0], challenge);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expect(core.adopted);
    try std.testing.expectEqual(generated.frame_type.host_adopt, response.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response | generated.frame_flag.final,
        response.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_adopt_payload,
        response.payload,
    ));
}

test "host.sock positive control returns typed error for wrong adoption secret" {
    const secret: [32]u8 = @splat(0x4d);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const wrong: [32]u8 = @splat(0x4e);
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, wrong);
    defer std.testing.allocator.free(challenge);
    try writeTestAdopt(sockets[0], challenge);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expect(!core.adopted);
    try std.testing.expectEqual(generated.frame_type.@"error", response.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        response.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.error_payload,
        response.payload,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response.payload, "UNAUTHENTICATED") != null);
}

/// Runs one full broker-role adoption handshake over its own connection so later RPC connections meet the privileged-RPC adoption precondition.
fn adoptForTest(core: *HostCore, registration: HostRegistration, secret: [32]u8) !void {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const challenge = try adoptionChallenge(std.testing.allocator, registration.record.locator, secret);
    defer std.testing.allocator.free(challenge);
    try writeTestAdopt(sockets[0], challenge);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();
    try std.testing.expect(server.failure == null);
    try std.testing.expect(core.adopted);
}

test "host.sock HOST_CAPTURE returns the measured terminal generation" {
    const secret: [32]u8 = @splat(0x4d);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    try adoptForTest(&core, registration, secret);

    var clock_context: u8 = 0;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const engine_build_id = try RealVtEngine.engineBuildId();
    const real_engine = try RealVtEngine.create(std.testing.allocator, 8, 3, null);
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = FixedClock.now },
        &engine_build_id,
        .{
            .columns = 8,
            .rows = 3,
            .cell_width_px_16_16 = 8 << 16,
            .cell_height_px_16_16 = 16 << 16,
        },
        temporary.dir,
    );
    defer state.deinit();
    try state.feedOutput("first\r\n\x1b[1msecond\x1b[0m");

    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .state = &state,
        .real_engine = real_engine,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    try writeTestHostRequest(
        sockets[0],
        generated.frame_type.host_capture,
        "{\"include\":\"visible-text\",\"maxRows\":2}",
    );
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();
    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.host_captured, response.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response | generated.frame_flag.final,
        response.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.capture_result,
        response.payload,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response.payload, "second") != null);
}

/// Serves one broker-role request on a fresh connection and returns the raw response frame; the caller owns (and must deinit) the frame.
fn serveOneControlRequest(
    core: *HostCore,
    registration: HostRegistration,
    type_code: u16,
    payload: []const u8,
) !protocol.Frame {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    try writeTestHostRequest(sockets[0], type_code, payload);
    const response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    thread.join();
    try std.testing.expect(server.failure == null);
    return response;
}

fn expectUnauthenticatedRefusal(response: *const protocol.Frame) !void {
    try std.testing.expectEqual(generated.frame_type.@"error", response.header.type_code);
    try std.testing.expectEqual(
        generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        response.header.flags,
    );
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.error_payload,
        response.payload,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response.payload, "UNAUTHENTICATED") != null);
}

test "host.sock fails closed for privileged broker RPCs before adoption" {
    const secret: [32]u8 = @splat(0x52);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();

    const grant_payload = try grantRegistrationPayload(
        std.testing.allocator,
        @splat(0x92),
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(grant_payload);
    var grant_response = try serveOneControlRequest(
        &core,
        registration,
        generated.frame_type.grant_register,
        grant_payload,
    );
    defer grant_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&grant_response);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);

    const terminate_payload = try terminationPayload(std.testing.allocator, registration, "immediate");
    defer std.testing.allocator.free(terminate_payload);
    var terminate_response = try serveOneControlRequest(
        &core,
        registration,
        generated.frame_type.terminate,
        terminate_payload,
    );
    defer terminate_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&terminate_response);
    try std.testing.expect(!core.terminated);

    try adoptForTest(&core, registration, secret);
    var granted_response = try serveOneControlRequest(
        &core,
        registration,
        generated.frame_type.grant_register,
        grant_payload,
    );
    defer granted_response.deinit(std.testing.allocator);
    try std.testing.expectEqual(generated.frame_type.grant_register, granted_response.header.type_code);
    try std.testing.expectEqual(@as(usize, 1), core.grants.items.len);
}

test "connection deadline fails closed once the absolute budget is spent" {
    var timer = try std.time.Timer.start();
    var deadline = try ConnectionDeadline.init(&timer);
    // Shrink the 10 s budget so the test does not wait on wall time.
    deadline.budget_ns = 50 * std.time.ns_per_ms;
    try deadline.check();
    std.Thread.sleep(80 * std.time.ns_per_ms);
    try std.testing.expectError(error.ConnectionDeadlineExceeded, deadline.check());
}

test "slow-dribble connection is dropped at the absolute service deadline" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const secret: [32]u8 = @splat(0x5e);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    // A 250 ms budget stands in for the production 10 s one: without the absolute deadline this partial HELLO re-arms the per-syscall timeout forever and holds the single-threaded host loop with it.
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
        .budget_ms = 250,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    var timer = try std.time.Timer.start();
    const partial = [_]u8{0} ** 8;
    try sockets[0].writeAll(&partial);
    thread.join();
    const elapsed = timer.read();
    try std.testing.expect(server.failure != null);
    try std.testing.expect(elapsed < generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms);
    // Dropped at its own budget, so the loop always regains control: it still has a supervisor to observe and viewers to pump.
    try std.testing.expect(elapsed < 5 * std.time.ns_per_s);
    try std.testing.expect(!core.adopted);
}

fn inputSubmitPayload(allocator: std.mem.Allocator, key: []const u8) ![]u8 {
    const registration = fixtureRegistration();
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .provenance = "user",
        .action = "edit",
        .transactionId = key,
        .idempotencyKey = key,
        .operation = .{ .kind = "hangup" },
    }, .{});
}

const reuse_rejection = "idempotency key reused with different input";

test "an identical resend replays instead of being called different input" {
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();

    const first = try inputSubmitPayload(std.testing.allocator, "msg-1");
    defer std.testing.allocator.free(first);
    const applied = try core.submitInput(first, "hive-daemon:inst", 2_000);
    defer core.allocator.free(applied);
    try std.testing.expectEqual(@as(usize, 1), core.input_replays.items.len);

    const resent = try inputSubmitPayload(std.testing.allocator, "msg-1");
    defer std.testing.allocator.free(resent);
    const replayed = try core.submitInput(resent, "hive-daemon:inst", 3_000);
    defer core.allocator.free(replayed);
    try std.testing.expect(std.mem.indexOf(u8, replayed, reuse_rejection) == null);
    try std.testing.expectEqual(@as(usize, 1), core.input_replays.items.len);

    const stolen = try inputSubmitPayload(std.testing.allocator, "msg-1");
    defer std.testing.allocator.free(stolen);
    const refused = try core.submitInput(stolen, "workspace-pane-nina", 4_000);
    defer core.allocator.free(refused);
    try std.testing.expect(std.mem.indexOf(u8, refused, reuse_rejection) != null);
}

test "replay ledgers evict the oldest entry beyond the retention cap" {
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();

    var key_storage: [32]u8 = undefined;
    var index: usize = 0;
    while (index < max_replay_entries + 4) : (index += 1) {
        const key = try std.fmt.bufPrint(&key_storage, "input-key-{d}", .{index});
        const payload = try inputSubmitPayload(std.testing.allocator, key);
        defer std.testing.allocator.free(payload);
        const applied = try core.submitInput(payload, "viewer-a", 2_000);
        defer core.allocator.free(applied);
        try std.testing.expect(core.input_replays.items.len <= max_replay_entries);
    }
    try std.testing.expectEqual(max_replay_entries, core.input_replays.items.len);
    try std.testing.expectEqualStrings("input-key-4", core.input_replays.items[0].idempotency_key);
    var recent_storage: [32]u8 = undefined;
    const recent_key = try std.fmt.bufPrint(&recent_storage, "input-key-{d}", .{max_replay_entries + 3});
    const replay_payload = try inputSubmitPayload(std.testing.allocator, recent_key);
    defer std.testing.allocator.free(replay_payload);
    const replayed = try core.submitInput(replay_payload, "viewer-a", 2_000);
    defer core.allocator.free(replayed);
    try std.testing.expectEqual(max_replay_entries, core.input_replays.items.len);

    index = 0;
    while (index < max_replay_entries + 2) : (index += 1) {
        const key = try std.fmt.bufPrint(&key_storage, "resize-key-{d}", .{index});
        _ = try core.reserveResizeReplay(.{
            .schemaVersion = 1,
            .session = .{
                .key = registration.record.locator.session_id,
                .incarnation = "1",
            },
            .window = .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
            .revision = "1",
            .idempotencyKey = key,
        }, 1);
        try std.testing.expect(core.resize_replays.items.len <= max_replay_entries);
    }
    try std.testing.expectEqual(max_replay_entries, core.resize_replays.items.len);
    try std.testing.expectEqualStrings("resize-key-2", core.resize_replays.items[0].idempotency_key);
}

test "null-sink VT effects retention fails closed at the journal ceiling" {
    const audit = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    defer audit.engine().deinit();
    // Simulate a verification engine that already retains the journal ceiling: one more PTY-effect byte must fail closed, not grow the session-lifetime copy without bound.
    try audit.effects.ensureTotalCapacity(std.testing.allocator, terminal_state.journal_max_bytes);
    audit.effects.items.len = terminal_state.journal_max_bytes;
    const reply = "x";
    RealVtEngine.writePtyCallback(audit.terminal, audit, reply.ptr, reply.len);
    try std.testing.expect(audit.effect_failed);
    try std.testing.expectEqual(terminal_state.journal_max_bytes, audit.effects.items.len);
}

test "sustained output does not export a checkpoint per written chunk" {
    const real = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine = real.engine();
    defer engine.deinit();

    const baseline = real.bridge_exports;
    var index: usize = 0;
    while (index < 16) : (index += 1) try engine.write("sustained output ");
    try std.testing.expectEqual(baseline, real.bridge_exports);

    // Deferring the measurement must not stale it: the first read pays for one export, a repeat read pays for none, and a later write invalidates it.
    const measured = engine.digest();
    try std.testing.expectEqual(baseline + 1, real.bridge_exports);
    try std.testing.expectEqualSlices(u8, &measured, &engine.digest());
    try std.testing.expectEqual(baseline + 1, real.bridge_exports);

    try engine.write("and more output ");
    const after = engine.digest();
    try std.testing.expectEqual(baseline + 2, real.bridge_exports);
    try std.testing.expect(!std.mem.eql(u8, &measured, &after));
}

const freeze_e_target_bytes: usize = 100 * 1024 * 1024;
const freeze_e_block_bytes: usize = 64 * 1024;
/// Bytes read before the software stop is issued: far enough into the file that the producer provably still has work left, cheap enough to reach quickly.
const freeze_e_stop_after_bytes: u64 = 8 * 1024 * 1024;

const FreezeEEngine = struct {
    const magic = "FREEZEE1";

    allocator: std.mem.Allocator,
    rolling: u64 = 0,

    fn create(allocator: std.mem.Allocator) !*FreezeEEngine {
        const self = try allocator.create(FreezeEEngine);
        self.* = .{ .allocator = allocator };
        return self;
    }

    fn engine(self: *FreezeEEngine) terminal_state.VtEngine {
        return .{
            .context = self,
            .deinitFn = deinitCb,
            .writeFn = writeCb,
            .exportFn = exportCb,
            .importFn = importCb,
            .digestFn = digestCb,
            .effectsFn = effectsCb,
            .resizeFn = resizeCb,
        };
    }

    fn factory() terminal_state.VtEngineFactory {
        return .{ .context = @ptrCast(&freeze_e_factory_context), .createFn = factoryCreate };
    }

    fn factoryCreate(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        columns: u32,
        rows: u32,
    ) anyerror!terminal_state.VtEngine {
        _ = .{ context, columns, rows };
        const created = try FreezeEEngine.create(allocator);
        return created.engine();
    }

    fn deinitCb(context: *anyopaque) void {
        const self: *FreezeEEngine = @ptrCast(@alignCast(context));
        self.allocator.destroy(self);
    }

    fn writeCb(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *FreezeEEngine = @ptrCast(@alignCast(context));
        for (bytes) |byte| self.rolling = self.rolling *% 31 +% byte;
    }

    fn exportCb(context: *anyopaque, allocator: std.mem.Allocator) anyerror![]u8 {
        const self: *FreezeEEngine = @ptrCast(@alignCast(context));
        const out = try allocator.alloc(u8, magic.len + 8);
        @memcpy(out[0..magic.len], magic);
        std.mem.writeInt(u64, out[magic.len..][0..8], self.rolling, .little);
        return out;
    }

    fn importCb(context: *anyopaque, payload: []const u8) anyerror!void {
        const self: *FreezeEEngine = @ptrCast(@alignCast(context));
        if (payload.len != magic.len + 8 or !std.mem.eql(u8, payload[0..magic.len], magic))
            return error.InvalidCheckpoint;
        self.rolling = std.mem.readInt(u64, payload[magic.len..][0..8], .little);
    }

    fn digestCb(context: *anyopaque) [32]u8 {
        const self: *FreezeEEngine = @ptrCast(@alignCast(context));
        var storage: [8]u8 = undefined;
        std.mem.writeInt(u64, &storage, self.rolling, .little);
        var out: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(&storage, &out, .{});
        return out;
    }

    fn effectsCb(context: *anyopaque) []const u8 {
        _ = context;
        return &.{};
    }

    fn resizeCb(context: *anyopaque, columns: u32, rows: u32, width: u32, height: u32) anyerror!void {
        _ = .{ context, columns, rows, width, height };
    }
};

var freeze_e_factory_context: u8 = 0;

const FreezeEDrainer = struct {
    host: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
    digest: std.crypto.hash.sha2.Sha256 = std.crypto.hash.sha2.Sha256.init(.{}),
    total: u64 = 0,
    max_retained: usize = 0,

    fn drain(self: *FreezeEDrainer, until: u64, idle_budget: usize) !bool {
        var idle: usize = 0;
        while (self.total < until) {
            const chunk = self.host.readAvailable() catch |err| switch (err) {
                error.Closed => return false,
                else => return err,
            };
            if (chunk.bytes.len == 0) {
                idle += 1;
                if (idle >= idle_budget) return true;
                std.Thread.sleep(1 * std.time.ns_per_ms);
                continue;
            }
            idle = 0;
            self.digest.update(chunk.bytes);
            try self.state.feedOutput(chunk.bytes);
            self.total += chunk.bytes.len;
            self.max_retained = @max(self.max_retained, self.state.journal.retainedBytes());
        }
        return false;
    }
};

fn freezeESendFlowByte(host: *pty_host.PtyHost, byte: u8) !void {
    _ = try host.writeAccept(&[_]u8{byte});
    try host.writeDrainAll();
}

test "freeze E: 100 MiB producer bounds retention, keeps byte integrity, and gaps explicitly" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    const allocator = std.testing.allocator;
    const block = try allocator.alloc(u8, freeze_e_block_bytes);
    defer allocator.free(block);
    for (block, 0..) |*byte, index| byte.* = 0x20 + @as(u8, @intCast(index % 95));
    comptime std.debug.assert(freeze_e_target_bytes % freeze_e_block_bytes == 0);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    {
        const file = try tmp.dir.createFile("freeze-e.bin", .{});
        defer file.close();
        var written: usize = 0;
        while (written < freeze_e_target_bytes) : (written += freeze_e_block_bytes)
            try file.writeAll(block);
    }
    var path_storage: [std.fs.max_path_bytes]u8 = undefined;
    const source_path = try tmp.dir.realpath("freeze-e.bin", &path_storage);

    var expected_hasher = std.crypto.hash.sha2.Sha256.init(.{});
    {
        var written: usize = 0;
        while (written < freeze_e_target_bytes) : (written += freeze_e_block_bytes)
            expected_hasher.update(block);
    }
    var expected_digest: [32]u8 = undefined;
    expected_hasher.final(&expected_digest);

    var host = try pty_host.PtyHost.init(allocator);
    defer host.deinit();
    switch (try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/cat", source_path },
        .terminal_profile = .{ .software_flow_control = true },
        .geometry = .{ .columns = 80, .rows = 24, .width_px = 640, .height_px = 384 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    const engine = try FreezeEEngine.create(allocator);
    const engine_build_id = try RealVtEngine.engineBuildId();
    var timer = try std.time.Timer.start();
    var timer_clock: TimerClock = .{ .timer = &timer };
    var state = terminal_state.TerminalState.init(
        allocator,
        engine.engine(),
        FreezeEEngine.factory(),
        .{ .context = &timer_clock, .nowFn = TimerClock.now },
        &engine_build_id,
        .{
            .columns = 80,
            .rows = 24,
            .cell_width_px_16_16 = 8 << 16,
            .cell_height_px_16_16 = 16 << 16,
        },
        tmp.dir,
    );
    defer state.deinit();

    var drainer: FreezeEDrainer = .{ .host = &host, .state = &state };

    // Positive control for the quiescence instrument: while the producer runs, the same detector that must fire after XOFF must NOT fire here. Without this, "quiescent" could just mean "the poll budget was too small".
    try std.testing.expect(!try drainer.drain(freeze_e_stop_after_bytes, 2_000));
    try std.testing.expectEqual(freeze_e_stop_after_bytes, drainer.total);

    var flow_transitions: u8 = 0;
    try freezeESendFlowByte(&host, 19); // stop_byte (^S)
    flow_transitions += 1;
    try std.testing.expect(try drainer.drain(freeze_e_target_bytes, 200));
    const stopped_total = drainer.total;
    try std.testing.expect(stopped_total < freeze_e_target_bytes);

    std.Thread.sleep(100 * std.time.ns_per_ms);
    try std.testing.expect(try drainer.drain(freeze_e_target_bytes, 50));
    try std.testing.expectEqual(stopped_total, drainer.total);

    try freezeESendFlowByte(&host, 17); // start_byte (^Q)
    flow_transitions += 1;
    try std.testing.expect(!try drainer.drain(freeze_e_target_bytes, 5_000));
    try std.testing.expectEqual(@as(u8, 2), flow_transitions);

    // Byte integrity: every produced byte arrived exactly once, in order, across the stop and the restart.
    var observed_digest: [32]u8 = undefined;
    drainer.digest.final(&observed_digest);
    try std.testing.expectEqual(@as(u64, freeze_e_target_bytes), drainer.total);
    try std.testing.expectEqualSlices(u8, &expected_digest, &observed_digest);
    try std.testing.expectEqual(@as(u64, freeze_e_target_bytes), state.outputSeq());

    // Bounded memory: 100 MiB flowed through a journal that never exceeded its ceiling, and nothing outside the journal is retained on its behalf.
    try std.testing.expect(drainer.max_retained <= terminal_state.journal_max_bytes);
    try std.testing.expect(state.journal.retainedBytes() <= terminal_state.journal_max_bytes);

    // Explicit gap: the evicted prefix is refused, never silently shortened.
    const retained_start = state.retainedOutputStart();
    try std.testing.expect(retained_start > 0);
    try std.testing.expectError(error.CheckpointUnavailable, state.journal.sliceFrom(0));
    try std.testing.expectError(
        error.CheckpointUnavailable,
        state.journal.sliceFrom(retained_start - 1),
    );

    const retained = try state.journal.sliceFrom(retained_start);
    try std.testing.expectEqual(freeze_e_target_bytes - retained_start, retained.len);
    if (state.checkpointAvailable()) {
        const checkpoint = state.newestCheckpoint() orelse return error.TestUnexpectedResult;
        try std.testing.expect(checkpoint.header.through_seq >= retained_start);
    }

    var offset: usize = 0;
    while (offset < retained.len) {
        const from = @as(usize, @intCast((retained_start + offset) % freeze_e_block_bytes));
        const take = @min(freeze_e_block_bytes - from, retained.len - offset);
        try std.testing.expectEqualSlices(
            u8,
            block[from..][0..take],
            retained[offset..][0..take],
        );
        offset += take;
    }
}

fn grantRegistrationPayload(
    allocator: std.mem.Allocator,
    hash: [32]u8,
    additional_ms: u64,
) ![]u8 {
    const hash_hex = std.fmt.bytesToHex(hash, .lower);
    var tagged_storage: [71]u8 = undefined;
    const tagged = try std.fmt.bufPrint(&tagged_storage, "sha256:{s}", .{&hash_hex});
    var expiry_storage: [24]u8 = undefined;
    const expires_at = try wall_clock.deadline(&expiry_storage, additional_ms);
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .grantTokenSha256 = tagged,
        .viewerId = "viewer-a",
        .operations = &[_][]const u8{ "view", "user-input" },
        .expiresAt = expires_at,
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
    }, .{});
}

fn hostAttachPayload(
    allocator: std.mem.Allocator,
    locator: session_types.Locator,
    token: []const u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var geometry = std.json.ObjectMap.init(a);
    try geometry.put("columns", .{ .integer = 80 });
    try geometry.put("rows", .{ .integer = 24 });
    try geometry.put("widthPx", .{ .integer = 800 });
    try geometry.put("heightPx", .{ .integer = 480 });
    try geometry.put("cellWidthPx", .{ .float = 10 });
    try geometry.put("cellHeightPx", .{ .float = 20 });
    var root = std.json.ObjectMap.init(a);
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("locator", try locatorValue(a, locator));
    try root.put("token", .{ .string = token });
    try root.put("geometry", .{ .object = geometry });
    try root.put("afterSeq", .{ .string = "0" });
    return std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
}

const ViewerConnectionThread = struct {
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
    authorization: ?ViewerAuthorization = null,
    failure: ?anyerror = null,

    fn run(self: *@This()) void {
        self.authorization = authorizeViewerConnection(
            std.heap.c_allocator,
            self.stream,
            self.core,
            self.now_ns,
        ) catch |err| {
            self.failure = err;
            return;
        };
    }
};

fn writeTestViewerHello(
    stream: std.net.Stream,
    registration: HostRegistration,
    token: []const u8,
) !void {
    const hello = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .buildId = "viewer-build-a",
        .instanceId = registration.record.locator.instance_id,
        .protocol = .{
            .major = generated.protocol_major,
            .minMinor = generated.protocol_minor,
            .maxMinor = generated.protocol_minor,
        },
        .clientRole = "viewer",
        .grantToken = token,
    }, .{});
    defer std.testing.allocator.free(hello);
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.hello,
        .flags = 0,
        .payload_length = @intCast(hello.len),
        .request_id = 1,
        .stream_seq = 0,
    }, hello);
}

test "HOST_ATTACH consumes an exact one-use viewer grant" {
    const token = "viewer-capability-a";
    var token_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &token_hash, .{});
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const registration_payload = try grantRegistrationPayload(
        std.testing.allocator,
        token_hash,
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(registration_payload);
    const accepted = try core.registerGrant(registration_payload, 2_000);
    defer std.testing.allocator.free(accepted);
    const attach_payload = try hostAttachPayload(
        std.testing.allocator,
        registration.record.locator,
        token,
    );
    defer std.testing.allocator.free(attach_payload);

    try std.testing.expectError(
        error.InvalidViewerGrant,
        core.authorizeViewerAttach(attach_payload, "wrong-capability", 3_000),
    );
    try std.testing.expectEqual(@as(usize, 1), core.grants.items.len);

    var authorization = try core.authorizeViewerAttach(attach_payload, token, 3_000);
    defer authorization.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("viewer-a", authorization.viewer_id);
    try std.testing.expect(authorization.operations.view);
    try std.testing.expect(authorization.operations.user_input);
    try std.testing.expectEqual(@as(u64, 0), authorization.after_seq);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);
    try std.testing.expectError(
        error.InvalidViewerGrant,
        core.authorizeViewerAttach(attach_payload, token, 3_000),
    );
}

test "INPUT_SUBMIT hangup closes a real PTY and returns a distinct ordered receipt" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    _ = switch (try pty.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => |readback| readback,
        .exec_failed => return error.TestUnexpectedResult,
    };
    var sink: PtyQueueSink = .{ .pty = &pty };
    var arbiter = input_arbiter.InputArbiter.init(sink.arbiterSink());
    defer arbiter.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    const input_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .provenance = "user",
        .action = "edit",
        .transactionId = "hangup-transaction",
        .idempotencyKey = "hangup-idempotency",
        .operation = .{ .kind = "hangup" },
    }, .{});
    defer std.testing.allocator.free(input_payload);
    const applied = try core.submitInput(input_payload, "viewer-a", 3_000);
    defer std.testing.allocator.free(applied);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.applied_payload,
        applied,
    ));
    const Applied = struct {
        resultKind: []const u8,
        receipt: struct { stage: []const u8, orderedAt: []const u8, byteRange: ?std.json.Value },
    };
    var parsed = try std.json.parseFromSlice(Applied, std.testing.allocator, applied, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    try std.testing.expectEqualStrings("input", parsed.value.resultKind);
    try std.testing.expectEqualStrings("accepted", parsed.value.receipt.stage);
    try std.testing.expectEqualStrings("1", parsed.value.receipt.orderedAt);
    try std.testing.expect(parsed.value.receipt.byteRange == null);
    const exit = try pty.waitExit(true);
    try std.testing.expect(exit.reaped);
}

fn userBytesPayload(
    allocator: std.mem.Allocator,
    provenance: []const u8,
    action: []const u8,
    transaction: []const u8,
    bytes: []const u8,
) ![]u8 {
    const registration = fixtureRegistration();
    const encoded = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
    defer allocator.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, bytes);
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .provenance = provenance,
        .action = action,
        .transactionId = transaction,
        .idempotencyKey = transaction,
        .operation = .{ .kind = "bytes", .encoding = "base64", .bytes = encoded },
    }, .{});
}

test "generated input enums accept every schema provenance and action" {
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();

    const user = try userBytesPayload(std.testing.allocator, "user", "edit", "txn-user", "hi");
    defer std.testing.allocator.free(user);
    const applied = try core.submitInput(user, "viewer-a", 2_000);
    defer std.testing.allocator.free(applied);

    const cases = [_]struct { provenance: []const u8, action: []const u8 }{
        .{ .provenance = "automation", .action = "edit" },
        .{ .provenance = "automation", .action = "deliver" },
        .{ .provenance = "user", .action = "deliver" },
        .{ .provenance = "user", .action = "keys" },
    };
    for (cases, 0..) |case, index| {
        var transaction_storage: [32]u8 = undefined;
        const transaction = try std.fmt.bufPrint(&transaction_storage, "txn-auto-{d}", .{index});
        const payload = try userBytesPayload(
            std.testing.allocator,
            case.provenance,
            case.action,
            transaction,
            "notice",
        );
        defer std.testing.allocator.free(payload);
        const result = try core.submitInput(payload, "viewer-a", 3_000);
        defer std.testing.allocator.free(result);
    }
    try std.testing.expectEqual(@as(usize, 5), core.input_replays.items.len);
}

test "two viewers interleave user input through one ordered arbiter" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const output_name = "ordered-input.bin";
    (try tmp.dir.createFile(output_name, .{})).close();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const output_path = try tmp.dir.realpath(output_name, &path_buf);

    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    _ = switch (try pty.spawn(.{
        .argv = &.{ "/bin/sh", "-c", "exec /bin/cat > \"$1\"", "hive-input-test", output_path },
        .terminal_profile = .{
            .input_mode = .literal,
            .echo = false,
            .signal_characters = false,
        },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => |readback| readback,
        .exec_failed => return error.TestUnexpectedResult,
    };
    var sink: PtyQueueSink = .{ .pty = &pty };
    var arbiter = input_arbiter.InputArbiter.init(sink.arbiterSink());
    defer arbiter.deinit();
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = tmp.dir, .arbiter = &arbiter });

    const Applied = struct {
        resultKind: []const u8,
        receipt: struct {
            stage: []const u8,
            byteRange: ?struct { start: []const u8, endExclusive: []const u8 },
        },
    };
    const writes = [_]struct { viewer: []const u8, transaction: []const u8, bytes: []const u8 }{
        .{ .viewer = "viewer-a", .transaction = "txn-a-1", .bytes = "alpha" },
        .{ .viewer = "viewer-b", .transaction = "txn-b-1", .bytes = "BETA" },
        .{ .viewer = "viewer-a", .transaction = "txn-a-2", .bytes = "\x1b[A" },
    };
    var expected_start: u64 = 0;
    var expected_len: usize = 0;
    for (writes) |write| {
        const payload = try userBytesPayload(
            std.testing.allocator,
            "user",
            "edit",
            write.transaction,
            write.bytes,
        );
        defer std.testing.allocator.free(payload);
        const applied = try core.submitInput(payload, write.viewer, 3_000);
        defer std.testing.allocator.free(applied);
        var parsed = try std.json.parseFromSlice(Applied, std.testing.allocator, applied, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        try std.testing.expectEqualStrings("written-to-terminal", parsed.value.receipt.stage);
        const range = parsed.value.receipt.byteRange orelse return error.TestUnexpectedResult;
        var start_storage: [24]u8 = undefined;
        const expected = try std.fmt.bufPrint(&start_storage, "{d}", .{expected_start});
        try std.testing.expectEqualStrings(expected, range.start);
        expected_start += write.bytes.len;
        expected_len += write.bytes.len;
        var end_storage: [24]u8 = undefined;
        const expected_end = try std.fmt.bufPrint(&end_storage, "{d}", .{expected_start});
        try std.testing.expectEqualStrings(expected_end, range.endExclusive);
    }

    var observed: [64]u8 = undefined;
    var count: usize = 0;
    for (0..500) |_| {
        const output = try tmp.dir.openFile(output_name, .{});
        count = try output.readAll(&observed);
        output.close();
        if (count == expected_len) break;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    try std.testing.expectEqualStrings("alphaBETA\x1b[A", observed[0..count]);
}

test "viewer wire authenticates HELLO and validates HOST_ATTACH before streaming" {
    const token = "viewer-capability-wire-a";
    var token_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &token_hash, .{});
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const registration_payload = try grantRegistrationPayload(
        std.testing.allocator,
        token_hash,
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(registration_payload);
    const accepted = try core.registerGrant(registration_payload, 2_000);
    defer std.heap.c_allocator.free(accepted);

    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: ViewerConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 3_000,
    };
    const thread = try std.Thread.spawn(.{}, ViewerConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
    try writeTestViewerHello(sockets[0], registration, token);
    try readTestWelcome(sockets[0]);
    const attach = try hostAttachPayload(
        std.testing.allocator,
        registration.record.locator,
        token,
    );
    defer std.testing.allocator.free(attach);
    try writeTestHostRequest(sockets[0], generated.frame_type.host_attach, attach);
    thread.join();

    try std.testing.expect(server.failure == null);
    var authorization = &(server.authorization orelse return error.MissingViewerAuthorization);
    defer authorization.deinit(std.heap.c_allocator);
    try std.testing.expectEqualStrings("viewer-a", authorization.viewer_id);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);
}

test "host.sock GRANT_REGISTER stores only the one-use hash" {
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    // Privileged broker RPCs fail closed until adoption (the broker opens one connection per RPC, so adoption runs on its own connection first).
    try adoptForTest(&core, registration, secret);
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], registration);
    try readTestWelcome(sockets[0]);
    const hash: [32]u8 = @splat(0x92);
    const payload = try grantRegistrationPayload(
        std.testing.allocator,
        hash,
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(payload);
    try writeTestHostRequest(sockets[0], generated.frame_type.grant_register, payload);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.grant_register, response.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.grant_register_payload,
        response.payload,
    ));
    try std.testing.expectEqual(@as(usize, 1), core.grants.items.len);
    try std.testing.expectEqualSlices(u8, &hash, &core.grants.items[0].hash);
    try std.testing.expectEqualStrings("viewer-a", core.grants.items[0].viewer_id);
}

test "GRANT_REGISTER positive control rejects an expired grant" {
    const secret: [32]u8 = @splat(0x31);
    var core = try HostCore.init(
        std.testing.allocator,
        fixtureRegistration(),
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    const payload = try grantRegistrationPayload(
        std.testing.allocator,
        @splat(0x92),
        0,
    );
    defer std.testing.allocator.free(payload);
    try std.testing.expectError(error.Expired, core.registerGrant(payload, 2_000));
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);
}

fn terminationPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    mode: []const u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var incarnation_storage: [32]u8 = undefined;
    const incarnation = try std.fmt.bufPrint(
        &incarnation_storage,
        "{d}",
        .{registration.record.locator.generation},
    );
    var session = std.json.ObjectMap.init(a);
    try session.put("key", .{ .string = registration.record.locator.session_id });
    try session.put("incarnation", .{ .string = try a.dupe(u8, incarnation) });
    var root = std.json.ObjectMap.init(a);
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("session", .{ .object = session });
    try root.put("mode", .{ .string = mode });
    try root.put("target", .{ .string = "process-tree" });
    try root.put("deadline", .{ .string = "2099-01-01T00:00:00.000Z" });
    try root.put("idempotencyKey", .{ .string = "req_01890f9e-7b9a-7cc2-8e2b-8c6b8b8b8b8b" });
    return std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
}

fn spawnUnrelatedSleep() !i32 {
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        const argv = [_:null]?[*:0]const u8{ "sleep", "60" };
        _ = c.execve("/bin/sleep", @ptrCast(&argv), @ptrCast(std.c.environ));
        c._exit(127);
    }
    return @intCast(pid);
}

fn killTestProcess(pid: i32) void {
    if (pid <= 0) return;
    _ = c.kill(pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(pid, &status, 0);
}

fn bindTestProvider(
    allocator: std.mem.Allocator,
    core: *HostCore,
    pty: *pty_host.PtyHost,
    directory: std.fs.Dir,
) !void {
    const argv = [_][]const u8{ "/bin/sleep", "60" };
    const outcome = try pty.spawn(.{
        .argv = &argv,
        .geometry = .{ .columns = 80, .rows = 24, .width_px = 800, .height_px = 480 },
    });
    const readback = switch (outcome) {
        .running => |value| value,
        .exec_failed => return error.TestUnexpectedResult,
    };
    var token_storage: [64]u8 = undefined;
    const token = try readback.start_token.format(&token_storage);
    core.registration.record.process_root = .{
        .pid = readback.pid,
        .start_token = try allocator.dupe(u8, token),
        .process_group_id = readback.pgid,
    };
    core.bindTermination(.{ .pty = pty, .directory = directory });
}

test "optional provider graceful action reaches the PTY without fabricated bytes" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    const outcome = try pty.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = .{ .columns = 80, .rows = 24, .width_px = 800, .height_px = 480 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }
    const action = "explicit-provider-graceful-action\n";
    const echoed = "explicit-provider-graceful-action\r\n";
    try deliverGracefulAction(.{
        .pty = &pty,
        .directory = temporary.dir,
        .graceful_action = action,
    });
    var output: std.ArrayList(u8) = .{};
    defer output.deinit(std.testing.allocator);
    var attempts: usize = 0;
    while (attempts < 200 and std.mem.indexOf(u8, output.items, echoed) == null) : (attempts += 1) {
        const chunk = pty.readAvailable() catch |err| switch (err) {
            error.Closed => break,
            else => return err,
        };
        try output.appendSlice(std.testing.allocator, chunk.bytes);
        if (chunk.bytes.len == 0) std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(std.mem.indexOf(u8, output.items, echoed) != null);
}

test "host.sock TERMINATE returns process evidence, writes final, and spares sentinel" {
    const sentinel = try spawnUnrelatedSleep();
    defer killTestProcess(sentinel);
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var pty = try pty_host.PtyHost.init(std.heap.c_allocator);
    defer pty.deinit();
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.heap.c_allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer {
        if (!std.mem.eql(
            u8,
            core.registration.record.process_root.start_token,
            registration.record.process_root.start_token,
        )) core.allocator.free(core.registration.record.process_root.start_token);
        core.deinit();
    }
    try bindTestProvider(std.heap.c_allocator, &core, &pty, temporary.dir);
    const payload = try terminationPayload(std.testing.allocator, core.registration, "immediate");
    defer std.testing.allocator.free(payload);
    // Privileged broker RPCs fail closed until adoption.
    try adoptForTest(&core, core.registration, secret);
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    var thread_joined = false;
    defer if (!thread_joined) thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], core.registration);
    try readTestWelcome(sockets[0]);
    try writeTestHostRequest(sockets[0], generated.frame_type.terminate, payload);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();
    thread_joined = true;

    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.terminated, response.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.terminated_payload,
        response.payload,
    ));
    try std.testing.expect(std.mem.indexOf(u8, response.payload, "\"state\":\"unknown\"") != null);
    try std.testing.expect(
        std.mem.indexOf(u8, response.payload, "process-tree-escapees-unaccounted") != null,
    );
    try std.testing.expect(core.terminated);
    const final = try temporary.dir.readFileAlloc(
        std.testing.allocator,
        "final.json",
        generated.limits.control_json_bytes,
    );
    defer std.testing.allocator.free(final);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"state\":\"unknown\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"waitObserved\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"outputSeq\":\"0\"") != null);
    try std.testing.expect(switch (process_inspector.observeProcess(sentinel)) {
        .present => true,
        .absent, .unobservable => false,
    });
}

test "a host self-terminates only once its supervisor is observably gone" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    const secret: [32]u8 = @splat(0x31);
    const registration = fixtureRegistration();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer {
        if (!std.mem.eql(
            u8,
            core.registration.record.process_root.start_token,
            registration.record.process_root.start_token,
        )) core.allocator.free(core.registration.record.process_root.start_token);
        core.deinit();
    }
    try bindTestProvider(std.testing.allocator, &core, &pty, temporary.dir);
    const provider_pid = core.registration.record.process_root.pid;
    // A live supervisor, long past the unrenewed visibility deadline: nothing dies. A running host holds its own lease open; reading an unrenewed lease as death kills working agents whose vendor TUI is rendered and running.
    core.bindSupervisor(host_core.SupervisorWatch.of(c.getpid()).?);
    const past_old_lease = 1_000 + 10 * generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expect(!try core.enforceSupervisorLoss(past_old_lease));
    try std.testing.expect(!core.terminated);

    // Same pid, different start token: whatever holds that pid now is not the process that supervised this host. Absence must be continuous through the grace window, which exists so a restarting broker can adopt.
    core.supervisor.?.start_token.microseconds +%= 1;
    try std.testing.expect(!try core.enforceSupervisorLoss(past_old_lease));
    try std.testing.expect(!try core.enforceSupervisorLoss(
        past_old_lease + host_core.supervisor_grace_ns - 1,
    ));
    try std.testing.expect(try core.enforceSupervisorLoss(
        past_old_lease + host_core.supervisor_grace_ns,
    ));
    try std.testing.expect(core.terminated);
    try std.testing.expect(switch (process_inspector.observeProcess(provider_pid)) {
        .absent => true,
        .present, .unobservable => false,
    });
    const final = try temporary.dir.readFileAlloc(
        std.testing.allocator,
        "final.json",
        generated.limits.control_json_bytes,
    );
    defer std.testing.allocator.free(final);
    try std.testing.expect(std.mem.indexOf(u8, final, "SUPERVISOR_GONE") != null);
}

test "the host wait returns on PTY output rather than on its tick" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    // A child that says nothing until told to, so the wait below is entered with the master
    // quiet and can only be released by the write that follows.
    switch (try pty.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .geometry = .{ .columns = 80, .rows = 24, .width_px = 800, .height_px = 480 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }
    var listeners = try socketPair();
    defer listeners[0].close();
    defer listeners[1].close();

    var wait = try HostWait.open(
        listeners[0].handle,
        listeners[1].handle,
        pty.master_fd,
        pty.pid,
    );
    defer wait.close();
    _ = try pty.writeAccept("wake\n");
    try pty.writeDrainAll();

    var timer = try std.time.Timer.start();
    _ = try wait.block(false);
    // Anything close to host_tick_ms means the descriptor was never watched and the timer did
    // the waking, which would leave every terminal byte waiting on the next tick.
    try std.testing.expect(timer.read() < host_tick_ns / 2);
    var seen: usize = 0;
    while (seen == 0) seen = (try pty.readAvailable()).bytes.len;
}

test "the host wait reports root exit and persists waitpid evidence" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    const launch = switch (try pty.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "/bin/sleep 0.1; exit 23",
        },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => |value| value,
        .exec_failed => return error.TestUnexpectedResult,
    };
    var listeners = try socketPair();
    defer listeners[0].close();
    defer listeners[1].close();
    var wait = try HostWait.open(
        listeners[0].handle,
        listeners[1].handle,
        pty.master_fd,
        pty.pid,
    );
    defer wait.close();

    var timer = try std.time.Timer.start();
    var root_exited = false;
    while (!root_exited) {
        root_exited = try wait.block(false);
        try std.testing.expect(timer.read() < host_tick_ns / 2);
    }
    try std.testing.expect(timer.read() < host_tick_ns / 2);

    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var registration = fixtureRegistration();
    var token_storage: [64]u8 = undefined;
    registration.record.process_root.pid = launch.pid;
    registration.record.process_root.process_group_id = launch.pgid;
    registration.record.process_root.start_token = try launch.start_token.format(&token_storage);
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        @splat(0x31),
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer core.deinit();
    core.bindTermination(.{ .pty = &pty, .directory = temporary.dir });
    const response = try core.terminateBound(.immediate, null);
    defer std.testing.allocator.free(response);
    try std.testing.expect(core.terminated);
    try std.testing.expect(pty.master_fd < 0);
    const final = try temporary.dir.readFileAlloc(
        std.testing.allocator,
        "final.json",
        generated.limits.control_json_bytes,
    );
    defer std.testing.allocator.free(final);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"exitCode\":23") != null);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"waitObserved\":true") != null);
}

test "the running host loop is what reaps a host whose supervisor is gone" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    // A bound socket's path has to fit in sun_path, and the test cache directory is already too
    // deep to leave room for one.
    var root_storage: [32]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &root_storage,
        "/tmp/hsl-{x}",
        .{std.crypto.random.int(u64)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var root_directory = try std.fs.openDirAbsolute(root, .{});
    defer root_directory.close();
    try root_directory.chmod(0o700);

    const registration = fixtureRegistration();
    const session_id = registration.record.locator.session_id;
    const secret: [32]u8 = @splat(0x5c);
    var hosts_directory = try root_directory.makeOpenPath("hosts", .{});
    defer hosts_directory.close();
    try hosts_directory.chmod(0o700);
    var host_directory = try hosts_directory.makeOpenPath(session_id, .{});
    defer host_directory.close();
    try host_directory.chmod(0o700);
    {
        // HostRuntime.open proves the adoption secret against this file before it binds anything.
        const capability = try host_directory.createFile("adopt.cap", .{ .mode = 0o600 });
        defer capability.close();
        try capability.writeAll(&secret);
    }

    var runtime = try HostRuntime.open(
        std.testing.allocator,
        .{ .socket = root, .state = root },
        session_id,
        secret,
    );
    defer runtime.deinit();
    var nh_runtime = try neutral_runtime.Runtime.open(
        std.testing.allocator,
        .{ .socket = root, .state = root },
    );
    defer nh_runtime.deinit();
    var neutral_registry = try neutral_runtime.Registry.open(std.testing.allocator, &nh_runtime);
    defer neutral_registry.deinit();
    const reserved = try neutral_registry.reserve(
        session_id,
        "supervisor-loss-proof",
        @splat(0x42),
        .{ .columns = 80, .rows = 24, .widthPixels = 800, .heightPixels = 480 },
    );
    const session = switch (reserved) {
        .reserved => |record| record.session,
        .existing => return error.TestUnexpectedResult,
    };
    var neutral_endpoint = try neutral_runtime.HostEndpoint.open(
        std.testing.allocator,
        &nh_runtime,
        session,
    );
    defer neutral_endpoint.deinit();

    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var core = try HostCore.init(
        std.testing.allocator,
        registration,
        secret,
        "/tmp/hive-sessiond",
        "host-build-a",
        1_000,
    );
    defer {
        if (!std.mem.eql(
            u8,
            core.registration.record.process_root.start_token,
            registration.record.process_root.start_token,
        )) core.allocator.free(core.registration.record.process_root.start_token);
        core.deinit();
    }
    try bindTestProvider(std.testing.allocator, &core, &pty, runtime.directory);

    var timer = try std.time.Timer.start();
    // The loop reads its clock from this timer, so backdating the origin puts the very first tick
    // past host_core.supervisor_grace_ns instead of making the test wait out the real window.
    timer.started.timestamp.sec -= 200;
    var timer_clock: TimerClock = .{ .timer = &timer };
    var sink: PtyQueueSink = .{ .pty = &pty };
    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, sink.effectSink());
    const engine_build_digest = try RealVtEngine.engineBuildId();
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &timer_clock, .nowFn = TimerClock.now },
        &engine_build_digest,
        .{
            .columns = 80,
            .rows = 24,
            .cell_width_px_16_16 = try geometryFixed16_16(10),
            .cell_height_px_16_16 = try geometryFixed16_16(20),
        },
        runtime.directory,
    );
    defer state.deinit();
    var live_evidence: NeutralLiveEvidenceSource = .{
        .core = &core,
        .pty = &pty,
        .state = &state,
    };
    var neutral_platform = process_inspector.RealPlatform.init();
    var neutral_terminal: NeutralTerminalSource = .{ .pty = &pty, .state = &state };
    var host_operations = try neutral_operations.HostOperations.initServingTerminal(
        std.testing.allocator,
        &neutral_registry,
        neutral_endpoint.session,
        neutral_platform.platform(),
        live_evidence.provider(),
        neutral_evidence.EvidenceClock.system(),
        neutral_terminal.provider(),
    );
    defer host_operations.deinit();
    var neutral_serving: NeutralHostServing = .{
        .operations = &host_operations,
        .core = &core,
    };
    var persistence: PersistenceCursor = .{};

    // Same pid, different start token: whatever holds that pid now is not the process that
    // supervised this host, and the absence predates the grace window. Nothing but the loop can
    // act on that — enforceSupervisorLoss has no other caller — so a loop that returns with the
    // host terminated for SUPERVISOR_GONE is the whole proof.
    core.bindSupervisor(host_core.SupervisorWatch.of(c.getpid()).?);
    core.supervisor.?.start_token.microseconds +%= 1;
    core.supervisor.?.lost_since_ns = 1;
    const provider_pid = core.registration.record.process_root.pid;

    try runHostLoop(
        &runtime,
        &neutral_registry,
        &neutral_endpoint,
        &neutral_serving,
        &core,
        &timer,
        &pty,
        &state,
        real_engine,
        &persistence,
    );

    try std.testing.expect(core.terminated);
    try std.testing.expect(switch (process_inspector.observeProcess(provider_pid)) {
        .absent => true,
        .present, .unobservable => false,
    });
    const loop_final = try runtime.directory.readFileAlloc(
        std.testing.allocator,
        "final.json",
        generated.limits.control_json_bytes,
    );
    defer std.testing.allocator.free(loop_final);
    try std.testing.expect(std.mem.indexOf(u8, loop_final, "SUPERVISOR_GONE") != null);
}

comptime {
    _ = input_arbiter;
    _ = process_inspector;
    _ = protocol;
    _ = pty_host;
}

const BrittleShadowEngine = struct {
    allocator: std.mem.Allocator,
    fail_export: bool = false,
    fail_clone_export: bool = false,
    resizes: usize = 0,
    columns: u32 = 0,
    rows: u32 = 0,

    fn create(allocator: std.mem.Allocator) !*BrittleShadowEngine {
        const self = try allocator.create(BrittleShadowEngine);
        self.* = .{ .allocator = allocator };
        return self;
    }

    fn engine(self: *BrittleShadowEngine) terminal_state.VtEngine {
        return .{
            .context = self,
            .deinitFn = deinitCb,
            .writeFn = writeCb,
            .exportFn = exportCb,
            .cloneFn = cloneCb,
            .importFn = importCb,
            .digestFn = digestCb,
            .effectsFn = effectsCb,
            .resizeFn = resizeCb,
        };
    }

    fn deinitCb(context: *anyopaque) void {
        const self: *BrittleShadowEngine = @ptrCast(@alignCast(context));
        self.allocator.destroy(self);
    }

    fn writeCb(_: *anyopaque, _: []const u8) anyerror!void {}

    fn exportCb(context: *anyopaque, allocator: std.mem.Allocator) anyerror![]u8 {
        const self: *BrittleShadowEngine = @ptrCast(@alignCast(context));
        if (self.fail_export) return error.CheckpointExportFailed;
        return allocator.dupe(u8, "brittle-shadow");
    }

    fn cloneCb(context: *anyopaque, allocator: std.mem.Allocator) anyerror!terminal_state.VtEngine {
        const self: *BrittleShadowEngine = @ptrCast(@alignCast(context));
        const clone = try BrittleShadowEngine.create(allocator);
        clone.fail_export = self.fail_clone_export;
        clone.fail_clone_export = self.fail_clone_export;
        clone.columns = self.columns;
        clone.rows = self.rows;
        return clone.engine();
    }

    fn importCb(_: *anyopaque, _: []const u8) anyerror!void {}

    fn digestCb(_: *anyopaque) [32]u8 {
        return @splat(7);
    }

    fn effectsCb(_: *anyopaque) []const u8 {
        return "";
    }

    fn resizeCb(context: *anyopaque, columns: u32, rows: u32, _: u32, _: u32) anyerror!void {
        const self: *BrittleShadowEngine = @ptrCast(@alignCast(context));
        self.resizes += 1;
        self.columns = columns;
        self.rows = rows;
    }
};

fn brittleFactoryCreate(
    _: *anyopaque,
    allocator: std.mem.Allocator,
    _: u32,
    _: u32,
) anyerror!terminal_state.VtEngine {
    const created = try BrittleShadowEngine.create(allocator);
    return created.engine();
}

var brittle_factory_context: u8 = 0;

const BrittleClock = struct {
    fn now(_: *anyopaque) u64 {
        return 0;
    }
};

test "neutral resize drives the production adapter across both representations" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    const allocator = std.testing.allocator;

    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();
    _ = try pty.spawn(.{
        .argv = &[_][]const u8{ "/bin/sh", "-c", "while :; do sleep 1; done" },
        .cwd = "/",
        .geometry = .{ .columns = 80, .rows = 24, .width_px = 800, .height_px = 480 },
    });

    const shadow = try BrittleShadowEngine.create(allocator);
    var clock_context: u8 = 0;
    const engine_build_id = try RealVtEngine.engineBuildId();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var state = terminal_state.TerminalState.init(
        allocator,
        shadow.engine(),
        .{ .context = @ptrCast(&brittle_factory_context), .createFn = brittleFactoryCreate },
        .{ .context = &clock_context, .nowFn = BrittleClock.now },
        &engine_build_id,
        .{ .columns = 80, .rows = 24, .cell_width_px_16_16 = 10 << 16, .cell_height_px_16_16 = 20 << 16 },
        temporary.dir,
    );
    defer state.deinit();

    var source: NeutralTerminalSource = .{
        .pty = &pty,
        .state = &state,
        .test_resize_columns_adjustment = 1,
    };
    const provider = source.provider();
    const window: neutral_contract.WindowSize = .{
        .columns = 100,
        .rows = 30,
        .widthPixels = 1000,
        .heightPixels = 600,
    };

    switch (try provider.resize(window, 1)) {
        .applied => |applied| {
            try std.testing.expectEqual(@as(u64, 1), applied.revision);
            try std.testing.expectEqual(@as(u32, 101), applied.readback.columns);
        },
        .superseded => return error.UnexpectedSupersession,
    }
    var live_shadow: *BrittleShadowEngine = @ptrCast(@alignCast(state.engine.context));
    try std.testing.expectEqual(@as(u32, 101), live_shadow.columns);
    try std.testing.expectEqual(@as(u32, 30), live_shadow.rows);
    source.test_resize_columns_adjustment = 0;

    live_shadow.fail_clone_export = true;
    const divergent: neutral_contract.WindowSize = .{
        .columns = 120,
        .rows = 40,
        .widthPixels = 1200,
        .heightPixels = 800,
    };
    try std.testing.expectError(error.CheckpointUnavailable, provider.resize(divergent, 2));
    try std.testing.expectEqual(@as(u32, 101), pty.geometry.columns);
    live_shadow = @ptrCast(@alignCast(state.engine.context));
    try std.testing.expectEqual(@as(u32, 101), live_shadow.columns);
    try std.testing.expect(state.checkpointAvailable());

    live_shadow.fail_clone_export = false;
    switch (try provider.resize(divergent, 2)) {
        .applied => |applied| {
            try std.testing.expectEqual(@as(u64, 2), applied.revision);
            try std.testing.expectEqual(@as(u32, 120), applied.readback.columns);
        },
        .superseded => return error.UnexpectedSupersession,
    }
    live_shadow = @ptrCast(@alignCast(state.engine.context));
    try std.testing.expectEqual(@as(u32, 120), live_shadow.columns);
    try std.testing.expectEqual(@as(u32, 40), live_shadow.rows);
}
