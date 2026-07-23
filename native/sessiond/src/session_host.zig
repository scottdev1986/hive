//! WP4 Track Omega: one HOST process owns one provider generation.
//!
//! This module composes the landed PTY, process-inspection, input-arbiter, and
//! terminal-state leaves. Broker registry/admission authority remains in
//! broker.zig; this module implements only the host process and its launcher.

const std = @import("std");
const boot_envelope = @import("boot_envelope");
const broker = @import("broker");
const generated = @import("session_protocol_generated");
const input_arbiter = @import("input_arbiter");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const pty_host = @import("pty_host");
const neutral_host = @import("neutral_host");
const neutral_control_plane = @import("neutral_control_plane");
const wall_clock = @import("wall_clock");
/// Re-exported so real-host tests can derive checkpoint thresholds from the
/// shipped constants instead of restating them.
pub const terminal_state = @import("terminal_state");

const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("signal.h");
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

pub const inherited_control_fd = boot_envelope.inherited_control_fd;
pub const BootMessage = boot_envelope.Message;
pub const writeBootMessage = boot_envelope.write;
pub const readBootMessage = boot_envelope.read;

pub const VisibilityLease = @import("visibility_lease").VisibilityLease;

pub fn requireEngineBuildId(value: ?[]const u8) !void {
    const expected = try broker.engineBuildIdHex();
    if (value == null or !std.mem.eql(u8, value.?, &expected))
        return error.EngineMismatch;
}

const terminal_adapter = @import("terminal_adapter");
const ghostty_c = terminal_adapter.c_api;
pub const canonical_scrollback_bytes = terminal_adapter.canonical_scrollback_bytes;
pub const BridgeExport = terminal_adapter.BridgeExport;
pub const RealVtEngine = terminal_adapter.RealVtEngine;
pub const PtyQueueSink = terminal_adapter.PtyQueueSink;
pub const RealInputEncoder = terminal_adapter.RealInputEncoder;

const final_evidence = @import("final_evidence");
pub const FinalState = final_evidence.FinalState;
pub const FinalSurvivor = final_evidence.FinalSurvivor;
pub const FinalError = final_evidence.FinalError;
pub const FinalEvidence = final_evidence.FinalEvidence;
pub const writeFinalExclusive = final_evidence.writeExclusive;

const host_record = @import("host_record");
const WireLocator = host_record.WireLocator;
const WireGeometry = host_record.WireGeometry;
const WireHostRegisterRequest = host_record.WireHostRegisterRequest;
pub const HostRegistration = host_record.HostRegistration;
const locatorValue = host_record.locatorValue;
const processRootValue = host_record.processRootValue;
const geometryValue = host_record.geometryValue;
const visibilityValue = host_record.visibilityValue;
const protocolValue = host_record.protocolValue;
pub const encodeHostRegister = host_record.encodeHostRegister;
pub const encodeRecordJson = host_record.encodeRecordJson;
pub const encodeCreatedPayload = host_record.encodeCreatedPayload;

const host_wire = @import("host_wire");
const readRequiredFrame = host_wire.readRequiredFrame;
const writeHostFailure = host_wire.writeFailure;
const host_registration = @import("host_registration");
pub const serveInheritedRegistration = host_registration.serveInheritedRegistration;
pub const serveRegistrationAfterBoot = host_registration.serveRegistrationAfterBoot;
pub const ParsedRegistration = host_registration.ParsedRegistration;
const promoteTrustedExecutableEvidence = host_registration.promoteTrustedExecutableEvidence;
const parseLocator = host_registration.parseLocator;
const parseRegistration = host_registration.parseRegistration;
const PendingRegistrationReadback = host_registration.PendingRegistrationReadback;
const beginInheritedRegistration = host_registration.beginInheritedRegistration;
const acceptPendingRegistration = host_registration.acceptPendingRegistration;
const writeHostWelcome = host_registration.writeHostWelcome;
pub const completeInheritedRegistration = host_registration.completeInheritedRegistration;
const validatedHostLeaseRemaining = host_registration.validatedLeaseRemaining;
const WireHello = host_registration.WireHello;

const host_process = @import("host_runtime");
const closeHostInheritedDescriptors = host_process.closeHostInheritedDescriptors;
const scrubbedHostEnvironment = host_process.scrubbedHostEnvironment;
const spawnHostProcess = host_process.spawnHostProcess;
const killAndWait = host_process.killAndWait;
const setControlTimeoutMs = host_process.setControlTimeoutMs;
const setControlTimeout = host_process.setControlTimeout;
const ConnectionDeadline = host_process.ConnectionDeadline;
const readConnectionFrame = host_process.readConnectionFrame;
const acceptedConnectionReady = host_process.acceptedConnectionReady;
const leaseBoundControlTimeoutMs = host_process.leaseBoundControlTimeoutMs;
pub const HostRuntime = host_process.HostRuntime;
const executableBuildHash = host_process.executableBuildHash;
const LaunchClient = host_process.LaunchClient;
pub const ProductionHostLauncher = host_process.ProductionHostLauncher;

const host_core = @import("host_core");
pub const checkpointWireSeq = host_core.checkpointWireSeq;
pub const GrantOperations = host_core.GrantOperations;
pub const ViewerAuthorization = host_core.ViewerAuthorization;
pub const TerminationBinding = host_core.TerminationBinding;
const max_replay_entries = host_core.max_replay_entries;
const deliverGracefulAction = host_core.deliverGracefulAction;
pub const HostCore = host_core.HostCore;
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
    const peer = try broker.inspectPeer(stream.handle);
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
    /// HOST_ATTACH request header fields for correlated snapshot frames and
    /// typed attach failures (§20).
    attach_minor: u8,
    attach_request_id: u64,
};

fn viewerAttachFailureCode(err: anyerror) protocol.WireError {
    return switch (err) {
        error.VisibilityExpired => .not_ready,
        error.InvalidHostAttach => .malformed_frame,
        // Exact-locator fence (§06/§20): a wrong or superseded generation is a
        // typed refusal before any grant/token evaluation.
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

/// Authenticates the existing generated viewer HELLO and consumes the existing
/// generated HOST_ATTACH request. The caller retains the stream and begins the
/// snapshot/output sequence.
pub fn authorizeViewerConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
) !ViewerAuthorization {
    var timer = try std.time.Timer.start();
    const deadline = try ConnectionDeadline.init(&timer, core.lease, now_ns);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .viewer)) orelse
        return error.ViewerHandshakeRefused;
    defer hello.deinit();
    const authorized = try authorizeViewerAfterHello(allocator, stream, core, &hello, &deadline, now_ns);
    return authorized.authorization;
}

fn serveBrokerRequest(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
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
    // Same-uid + instanceId + buildId prove only that the peer is A local
    // process running the same executable; the 32-byte adoption secret is the
    // proof it is THE broker that owns this host. HOST_ADOPT is therefore the
    // only pre-adoption verb: terminate, grant_register, visibility_renew and
    // any future privileged RPC fail closed until adoption has set
    // core.adopted (write-once for the host's lifetime).
    if (request.header.type_code != generated.frame_type.host_adopt and !core.adopted) {
        try writeHostFailure(allocator, stream, request.header, .unauthenticated);
        return;
    }
    switch (request.header.type_code) {
        generated.frame_type.host_adopt => {
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
        generated.frame_type.visibility_renew => {
            const response = core.renewVisibility(request.payload, now_ns) catch |err| {
                try writeHostFailure(
                    allocator,
                    stream,
                    request.header,
                    switch (err) {
                        error.InvalidWorkspaceIdentity => .unauthenticated,
                        error.VisibilityExpired => .not_ready,
                        error.VisibilityForbidden => .forbidden,
                        else => .malformed_frame,
                    },
                );
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                request.header.response(generated.frame_type.renewed, response.len),
                response,
            );
        },
        generated.frame_type.input_orphan_discard => {
            const response = core.discardInputOrphan(request.payload, now_ns) catch {
                try writeHostFailure(allocator, stream, request.header, .malformed_frame);
                return;
            };
            defer core.allocator.free(response);
            try protocol.writeFrame(
                stream,
                request.header.response(generated.frame_type.orphan_discarded, response.len),
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

/// Serves one authenticated broker RPC on an already-accepted host.sock
/// connection. Kernel identity is captured before HELLO; broker JSON claims
/// are used only as cross-checks. The broker opens one connection per RPC.
pub fn serveHostConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    now_ns: u64,
) !void {
    var timer = try std.time.Timer.start();
    const deadline = try ConnectionDeadline.init(&timer, core.lease, now_ns);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .broker)) orelse return;
    defer hello.deinit();
    return serveBrokerRequest(allocator, stream, core, hello.build_id, &deadline, now_ns);
}

fn viewerFailureCode(err: anyerror) protocol.WireError {
    return switch (err) {
        error.GenerationMismatch => .generation_mismatch,
        error.InvalidClaimAcquire,
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
    const expected_flags: u16 = if (request.header.type_code == generated.frame_type.input_submit)
        generated.frame_flag.content_sensitive
    else
        0;
    if (request.header.flags != expected_flags) {
        try writeHostFailure(allocator, stream, request.header, .malformed_frame);
        return;
    }
    var response_type: u16 = undefined;
    const response = switch (request.header.type_code) {
        generated.frame_type.claim_acquire => blk: {
            if (!authorization.operations.human_input) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.claim_result;
            break :blk core.claimInput(
                request.payload,
                authorization.viewer_id,
                now_ns,
            ) catch |err| {
                try writeHostFailure(allocator, stream, request.header, viewerFailureCode(err));
                return;
            };
        },
        generated.frame_type.input_submit => blk: {
            if (!authorization.operations.human_input) {
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
        generated.frame_type.claim_release => blk: {
            if (!authorization.operations.human_input) {
                try writeHostFailure(allocator, stream, request.header, .forbidden);
                return;
            }
            response_type = generated.frame_type.applied;
            break :blk core.releaseInput(
                request.payload,
                authorization.viewer_id,
                now_ns,
            ) catch |err| {
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

/// One live attached viewer stream owned by the host loop (§20/§26). A later
/// successful attach for the same exact generation supersedes it.
const AttachedViewer = struct {
    stream: std.net.Stream,
    authorization: ViewerAuthorization,
    /// Exclusive journal byte offset already written to this viewer.
    sent_seq: u64,
    /// Exclusive contiguous OUTPUT high-water the viewer acknowledged (§20 APPLIED).
    acked_seq: u64,

    fn close(self: *AttachedViewer, allocator: std.mem.Allocator) void {
        self.stream.close();
        self.authorization.deinit(allocator);
        self.* = undefined;
    }
};

/// Push retained journal bytes from `seq.*` to the journal end as ordered
/// unsolicited OUTPUT frames (stream_seq = absolute first-byte offset),
/// chunked at the negotiated stream bound. Advances `seq.*`.
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
    // #91: the host loop feeds PTY output BEFORE it pumps, and a checkpoint
    // fires from inside feedOutput and evicts the journal it just covered.
    // Publishing the delivered high-water here — the one place a viewer's
    // sent_seq advances, on both the attach replay and the pump — keeps that
    // eviction behind the viewer instead of detaching a healthy pane every
    // checkpoint interval.
    state.setViewerFloor(seq.*);
}

/// §20 attach stream for an authorized viewer: when the requested cursor is
/// below the retained journal start, the newest verified HVTCP001 checkpoint
/// envelope is sent as correlated SNAPSHOT_BYTES chunks; every retained byte
/// after the effective base then replays as ordered OUTPUT. Returns the
/// exclusive high-water written. A cursor the retained journal and checkpoint
/// cannot bridge is a typed CHECKPOINT_UNAVAILABLE failure, never silence.
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
        var buffer: [terminal_state.checkpoint_stream_chunk_bytes]u8 = undefined;
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

/// Serves one accepted host.sock connection. A broker connection is one RPC.
/// A viewer connection authorizes, streams the attach snapshot/replay, and is
/// returned to the host loop as the live attached viewer; the caller closes
/// the stream in every other outcome.
fn serveSessionConnection(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    timer: *std.time.Timer,
) !?AttachedViewer {
    const now_ns = timer.read();
    const deadline = try ConnectionDeadline.init(timer, core.lease, now_ns);
    var hello = (try acceptHostHello(allocator, stream, core, &deadline, now_ns, .either)) orelse return null;
    defer hello.deinit();
    switch (hello.role) {
        .broker => {
            try serveBrokerRequest(allocator, stream, core, hello.build_id, &deadline, now_ns);
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

/// Per-iteration bound on dispatched inbound viewer frames so a chatty viewer
/// cannot starve the PTY pump.
const viewer_inbound_frames_per_iteration = 32;

/// Drives the attached viewer inside the host loop: pushes newly journaled
/// OUTPUT (paused while the unacknowledged window exceeds the negotiated
/// viewer queue bound), then dispatches any ready inbound frames. Any wire
/// error detaches the viewer; the logical pane representation is untouched.
fn detachAttachedViewer(
    allocator: std.mem.Allocator,
    core: *HostCore,
    viewer_slot: *?AttachedViewer,
    state: *terminal_state.TerminalState,
    now_ns: u64,
) void {
    if (viewer_slot.*) |*viewer| {
        // #40: unclean drop must orphan+clear host claim before free of viewer_id.
        core.onViewerDetached(viewer.authorization.viewer_id, now_ns);
        viewer.close(allocator);
        viewer_slot.* = null;
        // #91: a viewer that is gone must never pin journal retention.
        state.setViewerFloor(null);
    }
}

fn pumpAttachedViewer(
    allocator: std.mem.Allocator,
    viewer_slot: *?AttachedViewer,
    core: *HostCore,
    state: *terminal_state.TerminalState,
    timer: *std.time.Timer,
) void {
    if (viewer_slot.*) |*viewer| {
        // One absolute budget per pump call: poll() proves only that SOME
        // byte is readable, so a dribbling attached viewer would otherwise
        // stall the single-threaded loop inside the blocking frame read.
        // Budget exhaustion detaches the viewer (fail closed); an expired
        // lease simply skips the pump — the loop top owns lease teardown.
        const deadline = ConnectionDeadline.init(timer, core.lease, timer.read()) catch return;
        // Retention loss is typed and observable, never a silent freeze. The
        // journal-pressure path evicts past a viewer that has fallen a whole
        // journal behind, and that viewer's unacknowledged window is exactly
        // what is full — so the backpressure gate below would skip the cursor
        // read forever, the CheckpointUnavailable would never be observed, and
        // the pane would stall with its socket still open. The gap is therefore
        // checked BEFORE the gate (contract §6: silent loss is forbidden; §7: a
        // cursor outside retention owes a full checkpoint requirement).
        // The loss cannot be typed ON this stream: only EVENT and OUTPUT may be
        // unsolicited (protocol.zig unsolicitedType), and an ERROR frame is
        // response-flagged, so request_id 0 is malformed by validateHeader.
        // Detaching is therefore the observable signal — the viewer sees EOF and
        // re-attaches, and beginViewerStream types the gap there, where a
        // request_id exists to correlate it (CHECKPOINT_UNAVAILABLE, or a
        // SNAPSHOT_BYTES replay when a checkpoint can bridge the cursor).
        if (state.retainedOutputStart() > viewer.sent_seq) {
            detachAttachedViewer(allocator, core, viewer_slot, state, timer.read());
            return;
        }
        if (state.outputSeq() > viewer.sent_seq and
            viewer.sent_seq - viewer.acked_seq < generated.limits.viewer_queue_bytes)
        {
            pushRetainedOutput(viewer.stream, state, &viewer.sent_seq) catch {
                detachAttachedViewer(allocator, core, viewer_slot, state, timer.read());
                return;
            };
        }
        var handled: u32 = 0;
        while (handled < viewer_inbound_frames_per_iteration) : (handled += 1) {
            var fds = [_]std.posix.pollfd{.{
                .fd = viewer.stream.handle,
                .events = std.posix.POLL.IN,
                .revents = 0,
            }};
            const ready = std.posix.poll(&fds, 0) catch 0;
            if (ready == 0 or fds[0].revents == 0) return;
            var frame = readConnectionFrame(allocator, viewer.stream, &deadline) catch {
                detachAttachedViewer(allocator, core, viewer_slot, state, timer.read());
                return;
            };
            defer {
                if (frame.header.type_code == generated.frame_type.input_submit)
                    std.crypto.secureZero(u8, frame.payload);
                frame.deinit(allocator);
            }
            if (frame.header.type_code == generated.frame_type.applied) {
                if (viewerOutputAckThroughSeq(allocator, &frame)) |through_seq| {
                    // Duplicate/stale acks are harmless retransmits; an ack
                    // beyond what was sent is a protocol violation.
                    if (through_seq <= viewer.sent_seq) {
                        if (through_seq > viewer.acked_seq) viewer.acked_seq = through_seq;
                        continue;
                    }
                }
                detachAttachedViewer(allocator, core, viewer_slot, state, timer.read());
                return;
            }
            handleViewerFrame(
                allocator,
                viewer.stream,
                core,
                state,
                &viewer.authorization,
                &frame,
                timer.read(),
            ) catch {
                detachAttachedViewer(allocator, core, viewer_slot, state, timer.read());
                return;
            };
        }
    }
}

/// Parses a viewer→host APPLIED output acknowledgement; null on any shape
/// that is not the frozen output branch.
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

/// Same validation as `environmentStrings`, but kept as name/value pairs for
/// the neutral create request, which joins them itself.
fn environmentEntries(
    allocator: std.mem.Allocator,
    value: std.json.Value,
) ![]const neutral_host.EnvironmentEntry {
    const object = switch (value) {
        .object => |object| object,
        else => return error.InvalidEnvironment,
    };
    const result = try allocator.alloc(neutral_host.EnvironmentEntry, object.count());
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
    if (argv.len == 0 or !std.fs.path.isAbsolute(cwd) or
        std.mem.indexOfScalar(u8, cwd, 0) != null or
        std.mem.indexOfScalar(u8, expected_executable, 0) != null)
        return error.InvalidCreateSpec;
    for (argv) |argument| {
        if (std.mem.indexOfScalar(u8, argument, 0) != null)
            return error.InvalidCreateSpec;
    }
}

const sameExecutableIdentity = @import("executable_identity").sameFile;

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

/// Streaming output batches persist the journal on the §18 batch window; any
/// path that needs the tail durable NOW (terminate, lease expiry, startup) or
/// that just verified a checkpoint (which evicted the covered journal prefix)
/// forces the rewrite.
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
    core.registration.checkpoint_available = state.checkpointAvailable();
    core.registration.record.checkpoint_seq = checkpointWireSeq(state);
}

fn queueInitialInput(
    allocator: std.mem.Allocator,
    encoder: *RealInputEncoder,
    sink: *PtyQueueSink,
    bytes: []const u8,
) !void {
    if (bytes.len == 0) return;
    var encoded: std.ArrayList(u8) = .{};
    defer {
        if (encoded.capacity > 0) std.crypto.secureZero(u8, encoded.allocatedSlice());
        encoded.deinit(allocator);
    }
    const capacity = bytes.len * input_arbiter.encoded_expansion_factor +
        input_arbiter.encoded_framing_slack;
    try encoded.ensureTotalCapacity(allocator, capacity);
    try encoder.encoder().encode(allocator, bytes, .none, &encoded);
    try sink.arbiterSink().write(encoded.items);
}

/// The real terminal behind the neutral control plane's mutation seam. The
/// neutral plane deliberately owns no terminal, so without this binding its
/// resize handler has nothing to set and answers `unknown`.
///
/// It performs the SAME two-part mutation the production resize path does: the
/// PTY set with its post-set readback, and the shadow VT following the applied
/// window so later checkpoints carry the real geometry rather than the
/// create-time size (§23). Setting the PTY alone would leave the shadow behind
/// and make a restored checkpoint render at the wrong size.
const NeutralTerminalSource = struct {
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
    test_resize_columns_adjustment: u32 = 0,

    fn provider(self: *NeutralTerminalSource) neutral_control_plane.TerminalProvider {
        return .{ .context = self, .resizeFn = resize };
    }

    fn resize(
        context: *anyopaque,
        window: neutral_host.WindowSize,
        revision: u64,
    ) anyerror!neutral_control_plane.TerminalResize {
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

    /// The mutation has two halves and the PTY half lands first, so a failure
    /// in between leaves the shadow behind a terminal that has already moved.
    /// Reporting the terminal's order without repairing the shadow would let a
    /// retry be answered `applied` for a geometry the shadow does not hold, and
    /// a checkpoint taken afterwards would restore at the wrong size. So the
    /// shadow is brought into agreement here too, and if it cannot be, this
    /// reports nothing applied at all.
    fn current(self: *NeutralTerminalSource) !neutral_control_plane.AppliedResize {
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

    fn neutralWindow(geometry: pty_host.Geometry) neutral_host.WindowSize {
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

    fn provider(self: *NeutralLiveEvidenceSource) neutral_control_plane.EvidenceProvider {
        return .{ .context = self, .measureFn = measure };
    }

    fn measure(
        context: *anyopaque,
        allocator: std.mem.Allocator,
    ) !neutral_control_plane.LiveEvidence {
        const self: *NeutralLiveEvidenceSource = @ptrCast(@alignCast(context));
        var diagnostics: std.ArrayList([]const u8) = .{};
        const foreground_process_group_id: ?i32 = self.pty.foregroundProcessGroupId() catch null;
        var newest_checkpoint: ?neutral_control_plane.CheckpointSnapshot = null;
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
        var input_owner: ?neutral_control_plane.WireInputClaim = null;
        // Active claim first; otherwise the retained orphan still names the
        // input owner of record while the arbiter holds HUMAN_ORPHANED (#40).
        if (self.core.active_claim orelse self.core.orphaned_claim) |claim| {
            const kind = std.meta.stringToEnum(
                @FieldType(neutral_control_plane.WireInputClaim, "kind"),
                claim.kind,
            );
            if (kind) |value| {
                input_owner = .{
                    .token = try allocator.dupe(u8, claim.token),
                    .writer = try allocator.dupe(u8, claim.writer),
                    .kind = value,
                    .leaseExpiresAt = try allocator.dupe(u8, claim.lease_expires_at),
                };
            } else {
                try diagnostics.append(allocator, "input-owner-kind-invalid");
            }
        }
        return .{
            .foregroundProcessGroupId = foreground_process_group_id,
            .newestCheckpoint = newest_checkpoint,
            .inputOwner = input_owner,
            .diagnostics = try diagnostics.toOwnedSlice(allocator),
        };
    }
};

fn refreshNeutralRecord(
    registry: *neutral_host.Registry,
    session: neutral_host.SessionRef,
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
    operations: *neutral_control_plane.HostOperations,
    core: *HostCore,

    fn handler(self: *NeutralHostServing) neutral_host.OperationHandler {
        return .{ .context = self, .callFn = call };
    }

    fn call(
        context: *anyopaque,
        request: neutral_host.OperationRequest,
    ) !neutral_host.OperationResponse {
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
    endpoint: *neutral_host.HostEndpoint,
    stream: std.net.Stream,
    handler: neutral_host.OperationHandler,
    timeout_ms: u64,
) !void {
    defer stream.close();
    const flags = c.fcntl(stream.handle, c.F_GETFL);
    if (flags < 0 or
        c.fcntl(stream.handle, c.F_SETFL, flags & ~@as(c_int, c.O_NONBLOCK)) < 0)
        return error.SocketBlockingFailed;
    try setControlTimeoutMs(stream.handle, timeout_ms);
    try endpoint.serveAccepted(stream, handler);
}

fn runHostLoop(
    runtime: *HostRuntime,
    neutral_registry: *neutral_host.Registry,
    neutral_endpoint: *neutral_host.HostEndpoint,
    neutral_serving: *NeutralHostServing,
    core: *HostCore,
    timer: *std.time.Timer,
    pty: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
    persistence: *PersistenceCursor,
) !void {
    var attached: ?AttachedViewer = null;
    defer if (attached) |*viewer| {
        core.onViewerDetached(viewer.authorization.viewer_id, timer.read());
        viewer.close(core.allocator);
        attached = null;
    };
    while (!core.terminated) {
        refreshRegistration(core, state);
        const now_ns = timer.read();
        if (core.lease.expired(now_ns)) {
            try persistTerminalState(state, runtime.directory, persistence, .forced);
            refreshRegistration(core, state);
            _ = try core.enforceVisibilityExpiry(now_ns);
            break;
        }

        if (try runtime.accept()) |stream| {
            const connection_now_ns = timer.read();
            if (core.lease.expired(connection_now_ns)) {
                stream.close();
                try persistTerminalState(state, runtime.directory, persistence, .forced);
                refreshRegistration(core, state);
                _ = try core.enforceVisibilityExpiry(connection_now_ns);
                break;
            }
            // A per-connection setup failure — a peer that reset the socket
            // before setsockopt ran, or a momentary lease-timeout race — drops
            // THIS connection and keeps serving. It must never tear down the
            // host (a single client cannot kill the terminal). A genuine lease
            // expiry is caught by the top-of-loop and pre-accept checks above.
            if (!acceptedConnectionReady(core.lease, stream.handle, connection_now_ns)) {
                std.log.err("host connection setup refused; dropping connection", .{});
                stream.close();
                continue;
            }
            const accepted = serveSessionConnection(
                core.allocator,
                stream,
                core,
                state,
                timer,
            ) catch |err| blk: {
                std.log.err("host connection refused: {s}", .{@errorName(err)});
                break :blk null;
            };
            if (accepted) |viewer| {
                // §26 retarget: a later successful attach for this exact
                // generation supersedes the previous viewer connection.
                if (attached) |*old| {
                    // #40: supersede is an unclean drop for the prior viewer.
                    core.onViewerDetached(old.authorization.viewer_id, timer.read());
                    old.close(core.allocator);
                }
                attached = viewer;
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
                try leaseBoundControlTimeoutMs(core.lease, now_ns),
            ) catch |err| {
                // A timeout after any partial frame is fatal to this stream;
                // serveNeutralAccepted closes it; the next request is fresh.
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
                // Best-effort tail push: every journaled byte reaches the
                // attached viewer before the endpoint closes (§20 drain).
                pumpAttachedViewer(core.allocator, &attached, core, state, timer);
                const response = try core.terminateBound(.immediate, null);
                core.allocator.free(response);
                break;
            },
            else => return err,
        };
        if (output.bytes.len > 0) {
            try state.feedOutput(output.bytes);
            // Streaming batch: journal rewrite rides the §18 batch window;
            // checkpoints still persist the moment they verify.
            try persistTerminalState(state, runtime.directory, persistence, .batched);
            refreshRegistration(core, state);
        }
        pumpAttachedViewer(core.allocator, &attached, core, state, timer);
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

/// Entry point for the same executable's `host` role.
pub fn runHostRole(
    allocator: std.mem.Allocator,
    hive_home: []const u8,
) !void {
    const control: std.net.Stream = .{ .handle = inherited_control_fd };
    defer control.close();
    try setControlTimeout(control.handle);
    const control_file: std.fs.File = .{ .handle = control.handle };
    var boot = try readBootMessage(allocator, control_file.deprecatedReader());
    var boot_owned = true;
    defer if (boot_owned) boot.deinit(allocator);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.create_begin_payload,
        boot.spec_json,
    )) return error.InvalidCreateSpec;
    var spec = try std.json.parseFromSlice(WireCreateSpec, allocator, boot.spec_json, .{
        .ignore_unknown_fields = true,
        // The boot envelope is scrubbed once its input and adoption secret
        // have been transferred into their live owners.
        .allocate = .alloc_always,
    });
    defer spec.deinit();
    if (spec.value.schemaVersion != 1) return error.InvalidCreateSpec;
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
        hive_home,
        locator.session_id,
        boot.adoption_secret,
    );
    defer runtime.deinit();
    var timer = try std.time.Timer.start();
    var timer_clock: TimerClock = .{ .timer = &timer };
    const start_ns = timer.read();

    var pty = try pty_host.PtyHost.init(allocator);
    defer pty.deinit();

    // Production create runs through the neutral host, so a created session is
    // recorded in the registry the neutral control plane enumerates and is
    // covered by the create-idempotency ledger. The terminal itself is still
    // this process's `pty`; the neutral host borrows it.
    var neutral_runtime = try neutral_host.Runtime.open(allocator, hive_home);
    defer neutral_runtime.deinit();
    var neutral_registry = try neutral_host.Registry.open(allocator, &neutral_runtime);
    defer neutral_registry.deinit();
    var direct = neutral_host.DirectHost.init(allocator, &neutral_registry, &pty);
    defer direct.deinit();

    const created = try direct.host().create(.{
        // The neutral host never interprets the key; the Hive session id is
        // simply the opaque name the adapter above already chose.
        .key = locator.session_id,
        // The frozen create-begin payload carries no idempotency key, so it is
        // derived from the create attempt this boot envelope represents: a
        // respawned host replaying the same attempt replays the ledger entry
        // instead of launching a second child.
        .idempotencyKey = spec.value.visibility.openTerminalRevision,
        .command = .{
            .executable = spec.value.argv[0],
            .arguments = spec.value.argv[1..],
            .workingDirectory = spec.value.cwd,
            .completeEnvironment = try environmentEntries(a, spec.value.environment),
            .descriptorMap = &.{},
        },
        // Spelled out to preserve the behaviour of the bare spawn this
        // replaced, which passed no profile and so took the terminal layer's
        // defaults. The frozen spec carries no profile to honour yet.
        .terminalProfile = .{
            .inputMode = .literal,
            .echo = false,
            .signalCharacters = false,
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
    // Evidence the frozen create result does not carry, measured by the create.
    const launch_evidence = direct.launch_evidence orelse return error.ProviderExecFailed;
    var neutral_endpoint = try neutral_host.HostEndpoint.open(
        allocator,
        &neutral_runtime,
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
    const real_encoder = try RealInputEncoder.create(allocator, real_engine);
    defer real_encoder.deinit();
    var arbiter = input_arbiter.InputArbiter.init(
        allocator,
        sink.arbiterSink(),
        real_encoder.encoder(),
        real_encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    try queueInitialInput(allocator, real_encoder, &sink, boot.initial_input);
    var persistence: PersistenceCursor = .{};
    try persistTerminalState(&state, runtime.directory, &persistence, .forced);

    const host_identity = switch (process_inspector.observeProcess(c.getpid())) {
        .present => |identity| identity,
        .absent, .unobservable => return error.HostIdentityUnavailable,
    };
    var host_token_storage: [64]u8 = undefined;
    const host_token = try host_identity.start_token.format(&host_token_storage);
    // Already formatted by the create that measured it.
    const root_token = launch.child.startToken;
    // The CLOEXEC barrier above proves execve(spec.argv[0], ...) succeeded.
    // Verify the contract's resolved argv[0] identity, not a later proc_pidpath
    // sample: hardened or self-replacing providers can make that sample
    // unobservable even though this host remains their direct parent.
    const executable_verified = sameExecutableIdentity(
        allocator,
        spec.value.expectedExecutable,
        spec.value.argv[0],
    );
    const host_executable = host_identity.executablePath();
    if (host_executable.len == 0) return error.HostIdentityUnavailable;
    const host_build_id = try executableBuildHash(allocator, host_executable);
    defer allocator.free(host_build_id);
    var created_storage: [24]u8 = undefined;
    var expiry_storage: [24]u8 = undefined;
    const created_at = try broker.wallDeadline(&created_storage, 0);
    const expires_at = try broker.wallDeadline(
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
        .created_at = try a.dupe(u8, created_at),
        .checkpoint_available = state.checkpointAvailable(),
        .executable_verified = executable_verified,
        .complete = launch_evidence.rootSnapshotStatus == .stable,
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
    var neutral_evidence: NeutralLiveEvidenceSource = .{
        .core = &core,
        .pty = &pty,
        .state = &state,
    };
    var neutral_platform = process_inspector.RealPlatform.init();
    // Bound at construction: without a terminal the neutral resize handler has
    // nothing to set and every resize the shipped host receives is `unknown`.
    var neutral_terminal: NeutralTerminalSource = .{ .pty = &pty, .state = &state };
    var neutral_operations = try neutral_control_plane.HostOperations.initServingTerminal(
        allocator,
        &neutral_registry,
        neutral_endpoint.session,
        neutral_platform.platform(),
        neutral_evidence.provider(),
        neutral_control_plane.EvidenceClock.system(),
        neutral_terminal.provider(),
    );
    defer neutral_operations.deinit();
    var neutral_serving: NeutralHostServing = .{
        .operations = &neutral_operations,
        .core = &core,
    };
    boot.deinit(allocator);
    boot_owned = false;
    errdefer if (!core.terminated) {
        const response = core.terminateBound(.immediate, "HOST_START_FAILED") catch null;
        if (response) |bytes| allocator.free(bytes);
    };

    const broker_build_id = try serveRegistrationAfterBoot(
        allocator,
        control,
        core.registration,
        host_build_id,
        start_ns,
    );
    defer allocator.free(broker_build_id);
    core.broker_build_id = broker_build_id;
    try runHostLoop(
        &runtime,
        &neutral_registry,
        &neutral_endpoint,
        &neutral_serving,
        &core,
        &timer,
        &pty,
        &state,
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

    var runtime = try neutral_host.Runtime.open(std.testing.allocator, root);
    defer runtime.deinit();
    var registry = try neutral_host.Registry.open(std.testing.allocator, &runtime);
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
    var endpoint = try neutral_host.HostEndpoint.open(
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
            _: neutral_host.OperationRequest,
        ) !neutral_host.OperationResponse {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.called = true;
            return .{ .payload = "unexpected" };
        }

        fn handler(self: *@This()) neutral_host.OperationHandler {
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
    const welcome_engine_build_id = try broker.engineBuildIdHex();
    try requireEngineBuildId(&welcome_engine_build_id);
    var wrong = welcome_engine_build_id;
    wrong[0] = if (wrong[0] == '0') '1' else '0';
    try std.testing.expectError(error.EngineMismatch, requireEngineBuildId(&wrong));
}

test "host registration confirms a future lease bounded by fifteen seconds" {
    var valid_storage: [24]u8 = undefined;
    const valid = try broker.wallDeadline(
        &valid_storage,
        generated.limits.visibility_expiry_ms,
    );
    const remaining = try validatedHostLeaseRemaining(valid);
    try std.testing.expect(remaining > 0);
    try std.testing.expect(
        remaining <= generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
    );

    var unbounded_storage: [24]u8 = undefined;
    const unbounded = try broker.wallDeadline(
        &unbounded_storage,
        generated.limits.visibility_expiry_ms + 1_000,
    );
    try std.testing.expectError(
        error.InvalidTimestamp,
        validatedHostLeaseRemaining(unbounded),
    );
}

test "accepted broker sockets cannot outlive the visibility deadline" {
    const start_ns: u64 = 1_000;
    const lease = try VisibilityLease.initial("workspace-1", 7, start_ns);
    try std.testing.expectEqual(
        generated.limits.control_rpc_timeout_ms,
        try leaseBoundControlTimeoutMs(lease, start_ns),
    );
    try std.testing.expectEqual(
        @as(u64, 1),
        try leaseBoundControlTimeoutMs(lease, lease.expires_mono_ns - 1),
    );
    try std.testing.expectError(
        error.VisibilityExpired,
        leaseBoundControlTimeoutMs(lease, lease.expires_mono_ns),
    );
}

test "spawn strings reject C ABI truncation with a valid control" {
    const valid_argv = [_][]const u8{ "/bin/sh", "-c" };
    try validateSpawnStrings("/tmp", "/bin/sh", &valid_argv);

    const invalid_argv = [_][]const u8{"/bin/sh\x00ignored"};
    try std.testing.expectError(
        error.InvalidCreateSpec,
        validateSpawnStrings("/tmp", "/bin/sh", &invalid_argv),
    );
    try std.testing.expectError(
        error.InvalidCreateSpec,
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
    // Assert the exact options object handed to ghostty_terminal_new. A
    // literal 50_000 at the constructor call site must make this test red.
    const options = RealVtEngine.terminalOptions(80, 24);
    try std.testing.expectEqual(canonical_scrollback_bytes, options.max_scrollback);
    const TestClock = struct {
        fn now(_: *anyopaque) u64 {
            return 1;
        }
    };
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
        .{ .context = &clock_context, .nowFn = TestClock.now },
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
    // No real_engine.deinit(): TerminalState owns the injected engine and its
    // deferred deinit is the single destruction path.
}

test "48 MiB scrollback survives 500x500 streamed checkpoint and real lib-vt restore" {
    const allocator = std.testing.allocator;
    const real_engine = try RealVtEngine.create(allocator, 80, 24, null);

    var image_limit: u64 = 0;
    try std.testing.expectEqual(
        ghostty_c.GHOSTTY_SUCCESS,
        ghostty_c.ghostty_terminal_get(
            real_engine.terminal,
            ghostty_c.GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_STORAGE_LIMIT,
            &image_limit,
        ),
    );
    try std.testing.expectEqual(@as(u64, 16 * 1024 * 1024), image_limit);

    const line_count = 80_000;
    const columns = 79;
    const stride = columns + 2;
    const history = try allocator.alloc(u8, line_count * stride);
    defer allocator.free(history);
    for (0..line_count) |line| {
        const start = line * stride;
        @memset(history[start..][0..columns], 'x');
        history[start + columns] = '\r';
        history[start + columns + 1] = '\n';
    }
    try real_engine.engine().write(history);

    var total_rows_before: usize = 0;
    var scrollback_rows_before: usize = 0;
    try std.testing.expectEqual(
        ghostty_c.GHOSTTY_SUCCESS,
        ghostty_c.ghostty_terminal_get(
            real_engine.terminal,
            ghostty_c.GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
            &total_rows_before,
        ),
    );
    try std.testing.expectEqual(
        ghostty_c.GHOSTTY_SUCCESS,
        ghostty_c.ghostty_terminal_get(
            real_engine.terminal,
            ghostty_c.GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS,
            &scrollback_rows_before,
        ),
    );
    // Replacing the constructor's actual option with 50_000 bytes retains
    // about 800 rows and makes this direct behavioral proof fail.
    try std.testing.expectEqual(@as(usize, 71_727), total_rows_before);
    try std.testing.expectEqual(@as(usize, 71_703), scrollback_rows_before);

    const TestClock = struct {
        fn now(_: *anyopaque) u64 {
            return 1;
        }
    };
    var clock_context: u8 = 0;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const engine_build_id = try RealVtEngine.engineBuildId();
    var state = terminal_state.TerminalState.init(
        allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = TestClock.now },
        &engine_build_id,
        .{
            .columns = 80,
            .rows = 24,
            .cell_width_px_16_16 = 8 << 16,
            .cell_height_px_16_16 = 16 << 16,
        },
        temporary.dir,
    );
    defer state.deinit();
    try state.resize(.{
        .columns = 500,
        .rows = 500,
        .cell_width_px_16_16 = 8 << 16,
        .cell_height_px_16_16 = 16 << 16,
    });

    const checkpoint = state.newestCheckpoint() orelse return error.TestUnexpectedResult;
    // Mutation control: restoring the old 64 MiB allocating producer makes
    // this exact test fail before a checkpoint can be retained.
    try std.testing.expect(checkpoint.header.payload_length >
        terminal_state.checkpoint_contiguous_max_bytes);
    try std.testing.expectEqual(@as(u32, 309_929_873), checkpoint.header.payload_length);
    try std.testing.expect(checkpoint.header.payload_length <=
        terminal_state.checkpoint_max_bytes);
    try std.testing.expect(state.checkpointAvailable());

    const restored = try RealVtEngine.create(allocator, 80, 24, null);
    defer restored.engine().deinit();
    _ = try state.restoreInto(restored.engine());
    const live_digest = state.engine.digest();
    const restored_digest = restored.engine().digest();
    try std.testing.expectEqualSlices(u8, &live_digest, &restored_digest);

    var live_total_rows: usize = 0;
    var live_scrollback_rows: usize = 0;
    var restored_total_rows: usize = 0;
    var restored_scrollback_rows: usize = 0;
    for ([_]struct { terminal: ghostty_c.GhosttyTerminal, total: *usize, scrollback: *usize }{
        .{ .terminal = real_engine.terminal, .total = &live_total_rows, .scrollback = &live_scrollback_rows },
        .{ .terminal = restored.terminal, .total = &restored_total_rows, .scrollback = &restored_scrollback_rows },
    }) |measurement| {
        try std.testing.expectEqual(
            ghostty_c.GHOSTTY_SUCCESS,
            ghostty_c.ghostty_terminal_get(
                measurement.terminal,
                ghostty_c.GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
                measurement.total,
            ),
        );
        try std.testing.expectEqual(
            ghostty_c.GHOSTTY_SUCCESS,
            ghostty_c.ghostty_terminal_get(
                measurement.terminal,
                ghostty_c.GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS,
                measurement.scrollback,
            ),
        );
    }
    try std.testing.expectEqual(live_total_rows, restored_total_rows);
    try std.testing.expectEqual(live_scrollback_rows, restored_scrollback_rows);
    try std.testing.expectEqual(@as(usize, 71_727), live_total_rows);
    try std.testing.expectEqual(@as(usize, 71_227), live_scrollback_rows);
}

/// Reads every byte already buffered on `stream` without blocking.
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

// #91 regression: the host loop feeds PTY output and THEN pumps the attached
// viewer, so a checkpoint firing inside feedOutput evicted the journal ahead of
// the viewer's sent_seq; the pump's push then read an evicted range and the host
// detached a live pane every checkpoint interval. Drives the loop's exact order.
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
    var attached: ?AttachedViewer = .{
        .stream = sockets[0],
        .authorization = .{
            .viewer_id = try std.testing.allocator.dupe(u8, "viewer-a"),
            .operations = .{ .view = true },
            .geometry = fixtureRegistration().record.geometry,
            .after_seq = 0,
        },
        .sent_seq = 0,
        .acked_seq = 0,
    };
    defer if (attached) |*viewer| viewer.close(std.testing.allocator);

    var received: std.ArrayList(u8) = .{};
    defer received.deinit(std.testing.allocator);

    // Loop iteration one: feed, then pump. The pump's push publishes the
    // delivered high-water as the retention floor (production does the same on
    // the attach replay, from beginViewerStream).
    try state.feedOutput("first");
    pumpAttachedViewer(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expect(attached != null);
    try std.testing.expectEqual(@as(u64, 5), attached.?.sent_seq);
    try drainReadable(sockets[1], &received);
    try std.testing.expect(std.mem.indexOf(u8, received.items, "first") != null);

    // Loop iteration two: the 30s interval has elapsed, so feedOutput
    // checkpoints and evicts before the pump ever runs.
    clock.nanos += terminal_state.checkpoint_interval_ns;
    try state.feedOutput("second");
    try std.testing.expect(state.checkpointSeq() > 0);

    pumpAttachedViewer(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expect(attached != null);
    try std.testing.expectEqual(@as(u64, 11), attached.?.sent_seq);
    try std.testing.expect(state.retainedOutputStart() <= 5);
    try drainReadable(sockets[1], &received);
    try std.testing.expect(std.mem.indexOf(u8, received.items, "second") != null);

    // A viewer that is gone must release the floor, or retention would grow to
    // the journal bound behind a pane nobody is watching.
    peer_open = false;
    sockets[1].close();
    pumpAttachedViewer(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expect(attached == null);
    try std.testing.expect(state.viewer_floor_seq == null);
}

// The journal-pressure path deliberately evicts past the viewer floor, and the
// viewer it drops is by definition one whose unacknowledged window is full. If
// the pump tested backpressure first it would skip the cursor read forever: the
// lost range would never be observed, the socket would stay open, and the pane
// would freeze silently — which contract §6 forbids.
test "retention loss detaches a viewer whose unacknowledged window is full" {
    const StoppedClock = struct {
        fn now(_: *anyopaque) u64 {
            return 1;
        }
    };
    var clock_context: u8 = 0;

    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine_build_id = try RealVtEngine.engineBuildId();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var state = terminal_state.TerminalState.init(
        std.testing.allocator,
        real_engine.engine(),
        RealVtEngine.factory(),
        .{ .context = &clock_context, .nowFn = StoppedClock.now },
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

    // Exactly what the pressure path leaves behind: the journal has been
    // evicted past a viewer whose unacknowledged window is at the cap. Feeding
    // there for real costs 8 MiB of Debug libghostty-vt parsing (minutes — see
    // FreezeEEngine), so the cursors are set to that state directly.
    const window = generated.limits.viewer_queue_bytes;
    state.journal.start_seq = window + 1;
    state.output_seq = window + 1;
    var attached: ?AttachedViewer = .{
        .stream = sockets[0],
        .authorization = .{
            .viewer_id = try std.testing.allocator.dupe(u8, "viewer-b"),
            .operations = .{ .view = true },
            .geometry = fixtureRegistration().record.geometry,
            .after_seq = 0,
        },
        .sent_seq = window,
        .acked_seq = 0,
    };
    defer if (attached) |*viewer| viewer.close(std.testing.allocator);
    state.setViewerFloor(attached.?.sent_seq);
    // Precondition: the backpressure gate really is shut, so this test cannot
    // pass through the ordinary push-then-fail route.
    try std.testing.expect(attached.?.sent_seq - attached.?.acked_seq >= window);
    try std.testing.expect(state.retainedOutputStart() > attached.?.sent_seq);

    pumpAttachedViewer(std.testing.allocator, &attached, &core, &state, &timer);
    try std.testing.expect(attached == null);
    try std.testing.expect(state.viewer_floor_seq == null);

    // Peer-observable: EOF, not an open socket that never speaks again. The
    // wire cannot carry a typed failure here (ERROR is response-flagged and an
    // unsolicited request_id 0 is malformed), so the close IS the signal, and
    // the re-attach types the gap.
    var eof: [1]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), try std.posix.read(sockets[1].handle, &eof));
}

test "real input encoder uses terminal paste mode and separate Ghostty keys" {
    const real_engine = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    defer real_engine.engine().deinit();
    const encoder = try RealInputEncoder.create(std.testing.allocator, real_engine);
    defer encoder.deinit();
    var encoded: std.ArrayList(u8) = .{};
    defer {
        if (encoded.capacity > 0) std.crypto.secureZero(u8, encoded.allocatedSlice());
        encoded.deinit(std.testing.allocator);
    }
    try encoded.ensureTotalCapacity(std.testing.allocator, 256);

    try encoder.encoder().encode(
        std.testing.allocator,
        "hello\nunsafe\x1b",
        .none,
        &encoded,
    );
    try std.testing.expectEqualStrings("hello\runsafe ", encoded.items);

    encoded.clearRetainingCapacity();
    try real_engine.engine().write("\x1b[?2004h");
    try encoder.encoder().encode(
        std.testing.allocator,
        "body",
        .@"return",
        &encoded,
    );
    try std.testing.expect(std.mem.startsWith(u8, encoded.items, "\x1b[200~body\x1b[201~"));
    try std.testing.expectEqual(@as(u8, '\r'), encoded.items[encoded.items.len - 1]);

    encoded.clearRetainingCapacity();
    try encoder.cancelEncoder().encode(std.testing.allocator, &encoded);
    try std.testing.expectEqualStrings("\x03", encoded.items);
}

test "host runtime accepts the broker layout and rejects a public sessiond directory" {
    var path_storage: [96]u8 = undefined;
    const root = try std.fmt.bufPrint(
        &path_storage,
        "/tmp/h{x}",
        .{std.crypto.random.int(u32)},
    );
    try std.fs.makeDirAbsolute(root);
    defer std.fs.deleteTreeAbsolute(root) catch {};
    var broker_runtime = try broker.Runtime.open(std.testing.allocator, root);
    defer broker_runtime.deinit();
    const session_id = "ses_018f1e90-7b5a-7cc0-8000-0000000000a1";
    var directory = try broker_runtime.openHostDirectory(session_id, true);
    const secret = try broker.createAdoptionSecret(directory);
    directory.close();

    var home = try std.fs.openDirAbsolute(root, .{});
    defer home.close();
    var runtime_parent = try home.openDir("runtime", .{ .no_follow = true });
    defer runtime_parent.close();
    try runtime_parent.chmod(0o755);
    var host_runtime = try HostRuntime.open(
        std.testing.allocator,
        root,
        session_id,
        secret,
    );
    host_runtime.deinit();

    try broker_runtime.directory.chmod(0o755);
    try std.testing.expectError(
        error.DirectorySubstitution,
        HostRuntime.open(std.testing.allocator, root, session_id, secret),
    );
}

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
        .created_at = "2026-07-17T14:30:00.000Z",
        .checkpoint_available = false,
        .executable_verified = true,
        .complete = true,
    };
}

const TestIdentityEncoder = struct {
    context: u8 = 0,

    fn encoder(self: *TestIdentityEncoder) input_arbiter.Encoder {
        return .{ .context = self, .encodeFn = encode };
    }

    fn cancelEncoder(self: *TestIdentityEncoder) input_arbiter.CancelEncoder {
        return .{ .context = self, .encodeFn = cancel };
    }

    fn encode(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        body: []const u8,
        submit: input_arbiter.SubmitAction,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        _ = context;
        _ = submit;
        try out.appendSlice(allocator, body);
    }

    fn cancel(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        _ = context;
        _ = allocator;
        _ = out;
    }
};

test "HOST_REGISTER record and CREATED use generated strict schemas" {
    const registration = fixtureRegistration();
    const host_register = try encodeHostRegister(std.testing.allocator, registration);
    defer std.testing.allocator.free(host_register);
    const record = try encodeRecordJson(std.testing.allocator, registration);
    defer std.testing.allocator.free(record);
    const created = try encodeCreatedPayload(std.testing.allocator, registration);
    defer std.testing.allocator.free(created);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_register_payload,
        host_register,
    ));
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.host_record_v1,
        record,
    ));
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.created_payload,
        created,
    ));
}

const RegistrationThread = struct {
    stream: std.net.Stream,
    registration: HostRegistration,
    failure: ?anyerror = null,
    boot: ?BootMessage = null,

    fn run(self: *@This()) void {
        self.boot = serveInheritedRegistration(
            std.heap.c_allocator,
            self.stream,
            self.registration,
            self.registration.record.executable_build_hash,
            99,
        ) catch |err| {
            self.failure = err;
            return;
        };
    }
};

fn socketPair() ![2]std.net.Stream {
    var sockets: [2]c_int = .{ -1, -1 };
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, &sockets) != 0)
        return error.SocketPairFailed;
    return .{
        .{ .handle = sockets[0] },
        .{ .handle = sockets[1] },
    };
}

test "inherited control fd completes HELLO and HOST_REGISTER before publication" {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var expiry_storage: [24]u8 = undefined;
    var registration = fixtureRegistration();
    registration.expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    var host: RegistrationThread = .{
        .stream = sockets[1],
        .registration = registration,
    };
    const thread = try std.Thread.spawn(.{}, RegistrationThread.run, .{&host});
    var thread_joined = false;
    defer if (!thread_joined) {
        _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
        thread.join();
    };
    const secret: [32]u8 = @splat(0x5a);
    var parsed = try completeInheritedRegistration(
        std.testing.allocator,
        sockets[0],
        "{\"schemaVersion\":1}",
        "initial",
        secret,
        "broker-build-a",
        "instance-a",
    );
    defer parsed.deinit(std.testing.allocator);
    thread.join();
    thread_joined = true;
    try std.testing.expect(host.failure == null);
    var boot = &(host.boot orelse return error.MissingBootMessage);
    defer boot.deinit(std.heap.c_allocator);
    try std.testing.expectEqualStrings("initial", boot.initial_input);
    try std.testing.expectEqualSlices(u8, &secret, &boot.adoption_secret);
    try std.testing.expectEqualStrings(
        fixtureRegistration().record.locator.session_id,
        parsed.registration.record.locator.session_id,
    );
    try std.testing.expect(
        parsed.registration.record.visibility.expires_mono_ns > 0 and
            parsed.registration.record.visibility.expires_mono_ns <=
                generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
    );
}

test "pending HOST_REGISTER remains unpublished after a typed rejection" {
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var expiry_storage: [24]u8 = undefined;
    var registration = fixtureRegistration();
    registration.expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    var host: RegistrationThread = .{
        .stream = sockets[1],
        .registration = registration,
    };
    const thread = try std.Thread.spawn(.{}, RegistrationThread.run, .{&host});
    var thread_joined = false;
    defer if (!thread_joined) {
        _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);
        thread.join();
    };
    var pending = try beginInheritedRegistration(
        std.testing.allocator,
        sockets[0],
        "{\"schemaVersion\":1}",
        "initial",
        @splat(0x6b),
        "broker-build-a",
        "instance-a",
    );
    defer pending.parsed.deinit(std.testing.allocator);
    try writeHostFailure(
        std.testing.allocator,
        sockets[0],
        pending.request_header,
        .not_ready,
    );
    thread.join();
    thread_joined = true;
    const failure = host.failure orelse return error.MissingHostRejection;
    try std.testing.expectEqualStrings("HostRegistrationRefused", @errorName(failure));
    try std.testing.expect(host.boot == null);
}

test "HostLauncher positive control observes failed same-role exec" {
    var child = try spawnHostProcess(std.testing.allocator, "/definitely/not/hive-sessiond");
    defer child.stream.close();
    var status: c_int = 0;
    try std.testing.expectEqual(child.pid, c.waitpid(child.pid, &status, 0));
    const wait_status: u32 = @bitCast(status);
    try std.testing.expect(std.posix.W.IFEXITED(wait_status));
    try std.testing.expectEqual(@as(u32, 127), std.posix.W.EXITSTATUS(wait_status));
}

test "production launcher restores trusted executable evidence after frozen registration parse" {
    var expiry_storage: [24]u8 = undefined;
    var registration = fixtureRegistration();
    registration.expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    const register_payload = try encodeHostRegister(std.testing.allocator, registration);
    defer std.testing.allocator.free(register_payload);
    var parsed = try parseRegistration(std.testing.allocator, register_payload);
    defer parsed.deinit(std.testing.allocator);
    try std.testing.expect(!parsed.registration.executable_verified);

    const created_payload = try promoteTrustedExecutableEvidence(
        std.testing.allocator,
        registration.record.expected_executable,
        &.{registration.record.expected_executable},
        &parsed,
    );
    defer std.testing.allocator.free(created_payload);
    try std.testing.expect(parsed.registration.executable_verified);
    try std.testing.expect(std.mem.indexOf(
        u8,
        created_payload,
        "\"executableVerified\":true",
    ) != null);
}

test "admitted HOST_REGISTER write failure reaps and removes the launch client" {
    var sockets = try socketPair();
    var pending_stream_open = true;
    defer {
        if (pending_stream_open) sockets[0].close();
    }
    defer sockets[1].close();
    const no_sigpipe: c_int = 1;
    if (c.setsockopt(
        sockets[0].handle,
        c.SOL_SOCKET,
        c.SO_NOSIGPIPE,
        &no_sigpipe,
        @sizeOf(c_int),
    ) != 0 or c.shutdown(sockets[0].handle, c.SHUT_WR) != 0)
        return error.SocketWriteFailureUnavailable;

    const pid = c.fork();
    if (pid < 0) return error.HostForkFailed;
    if (pid == 0) {
        sockets[0].close();
        sockets[1].close();
        c._exit(0);
    }
    var child_reaped = false;
    defer if (!child_reaped) killAndWait(@intCast(pid));

    var expiry_storage: [24]u8 = undefined;
    var registration = fixtureRegistration();
    registration.record.host_pid = @intCast(pid);
    registration.expires_at = try broker.wallDeadline(
        &expiry_storage,
        generated.limits.visibility_expiry_ms,
    );
    const payload = try encodeHostRegister(std.testing.allocator, registration);
    defer std.testing.allocator.free(payload);
    var parsed = try parseRegistration(std.testing.allocator, payload);
    var parsed_owned = true;
    defer if (parsed_owned) parsed.deinit(std.testing.allocator);

    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var wire = try broker.WireHostClient.init(
        std.testing.allocator,
        temporary.dir,
        "/tmp/not-used-host.sock",
        .{ .device = 1, .inode = 2, .owner_uid = std.posix.getuid(), .mode = 0o600 },
        parsed.registration.record,
        "broker-build-a",
    );
    var wire_owned = true;
    defer if (wire_owned) wire.deinit();

    var launcher: ProductionHostLauncher = .{
        .allocator = std.testing.allocator,
        .canonical_home = try std.testing.allocator.dupe(u8, "/tmp"),
    };
    defer launcher.deinit();
    const client = try std.testing.allocator.create(LaunchClient);
    client.* = .{
        .allocator = std.testing.allocator,
        .parsed = parsed,
        .wire = wire,
        .host_pid = @intCast(pid),
        .adoption_secret = @splat(0),
        .pending_id = 1,
        .pending_stream = sockets[0],
        .pending_header = .{
            .minor = generated.protocol_minor,
            .type_code = generated.frame_type.host_register,
            .flags = 0,
            .payload_length = 0,
            .request_id = 2,
            .stream_seq = 0,
        },
    };
    try launcher.clients.append(std.testing.allocator, client);
    parsed_owned = false;
    wire_owned = false;
    pending_stream_open = false;

    try std.testing.expect(!try launcher.finalizeOne(1, .admitted));
    var status: c_int = 0;
    var waited = c.waitpid(pid, &status, c.WNOHANG);
    var attempts: u8 = 0;
    while (waited == 0 and attempts < 100) : (attempts += 1) {
        std.Thread.sleep(std.time.ns_per_ms);
        waited = c.waitpid(pid, &status, c.WNOHANG);
    }
    if (waited == pid or (waited < 0 and std.posix.errno(waited) == .CHILD))
        child_reaped = true;
    try std.testing.expect(waited < 0 and std.posix.errno(waited) == .CHILD);
    try std.testing.expectEqual(@as(usize, 0), launcher.clients.items.len);
}

test "HostLauncher child closes broker descriptors above inherited fd 3" {
    var pipe_fds: [2]c_int = undefined;
    if (c.pipe(&pipe_fds) != 0) return error.PipeFailed;
    defer _ = c.close(pipe_fds[0]);
    var write_fd = pipe_fds[1];
    defer {
        if (write_fd >= 0) _ = c.close(write_fd);
    }
    if (write_fd <= inherited_control_fd) {
        const duplicate = c.fcntl(write_fd, c.F_DUPFD, inherited_control_fd + 1);
        if (duplicate < 0) return error.DescriptorDuplicateFailed;
        _ = c.close(write_fd);
        write_fd = duplicate;
    }
    const pid = c.fork();
    if (pid < 0) return error.HostForkFailed;
    if (pid == 0) {
        _ = c.close(pipe_fds[0]);
        closeHostInheritedDescriptors(c.getdtablesize());
        const byte: u8 = 1;
        const wrote = c.write(write_fd, &byte, 1);
        c._exit(if (wrote < 0 and std.posix.errno(wrote) == .BADF) 0 else 1);
    }
    _ = c.close(write_fd);
    write_fd = -1;
    var status: c_int = 0;
    if (c.waitpid(pid, &status, 0) != pid) return error.ChildWaitFailed;
    const wait_status: u32 = @bitCast(status);
    try std.testing.expect(std.posix.W.IFEXITED(wait_status));
    try std.testing.expectEqual(@as(u32, 0), std.posix.W.EXITSTATUS(wait_status));
    var byte: [1]u8 = undefined;
    try std.testing.expectEqual(@as(isize, 0), c.read(pipe_fds[0], &byte, 1));
}

fn adoptionChallenge(
    allocator: std.mem.Allocator,
    locator: broker.Locator,
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
    now_ns: u64,
    failure: ?anyerror = null,

    fn run(self: *@This()) void {
        serveHostConnection(
            std.heap.c_allocator,
            self.stream,
            self.core,
            self.now_ns,
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

/// Runs one full broker-role adoption handshake over its own connection so
/// later RPC connections meet the privileged-RPC adoption precondition.
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

/// Serves one broker-role request on a fresh connection and returns the raw
/// response frame; the caller owns (and must deinit) the frame.
fn serveOneBrokerRequest(
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

    // GRANT_REGISTER pre-adoption: typed refusal, nothing stored.
    const grant_payload = try grantRegistrationPayload(
        std.testing.allocator,
        @splat(0x92),
        generated.limits.attach_grant_timeout_ms,
    );
    defer std.testing.allocator.free(grant_payload);
    var grant_response = try serveOneBrokerRequest(
        &core,
        registration,
        generated.frame_type.grant_register,
        grant_payload,
    );
    defer grant_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&grant_response);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);

    // VISIBILITY_RENEW pre-adoption: typed refusal, lease untouched.
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.MissingWorkspaceIdentity;
    var token_storage: [64]u8 = undefined;
    const token = try workspace.start_token.format(&token_storage);
    const renew_payload = try visibilityRenewPayload(
        std.testing.allocator,
        registration,
        c.getpid(),
        token,
        2,
    );
    defer std.testing.allocator.free(renew_payload);
    var renew_response = try serveOneBrokerRequest(
        &core,
        registration,
        generated.frame_type.visibility_renew,
        renew_payload,
    );
    defer renew_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&renew_response);
    try std.testing.expectEqual(@as(u64, 1), core.lease.open_terminal_revision);

    // TERMINATE pre-adoption: typed refusal, host still live.
    const terminate_payload = try terminationPayload(std.testing.allocator, registration, "immediate");
    defer std.testing.allocator.free(terminate_payload);
    var terminate_response = try serveOneBrokerRequest(
        &core,
        registration,
        generated.frame_type.terminate,
        terminate_payload,
    );
    defer terminate_response.deinit(std.testing.allocator);
    try expectUnauthenticatedRefusal(&terminate_response);
    try std.testing.expect(!core.terminated);

    // Positive control: after a real adoption handshake the same RPC serves.
    try adoptForTest(&core, registration, secret);
    var granted_response = try serveOneBrokerRequest(
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
    const lease = try VisibilityLease.initial("ws-fixture", 1, 0);
    var deadline = try ConnectionDeadline.init(&timer, lease, 1);
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
    // A ~250 ms residual lease shrinks the absolute budget; without the
    // deadline this partial HELLO would stall the loop for the full per-syscall
    // control_rpc_timeout_ms (and re-arm forever if dribbled).
    core.lease.expires_mono_ns = 1_000 + 250 * std.time.ns_per_ms;
    var sockets = try socketPair();
    defer sockets[0].close();
    defer sockets[1].close();
    var server: HostConnectionThread = .{
        .stream = sockets[1],
        .core = &core,
        .now_ns = 2_000,
    };
    const thread = try std.Thread.spawn(.{}, HostConnectionThread.run, .{&server});
    var timer = try std.time.Timer.start();
    // Dribble: fewer bytes than one frame header, then silence.
    const partial = [_]u8{0} ** 8;
    try sockets[0].writeAll(&partial);
    thread.join();
    const elapsed = timer.read();
    try std.testing.expect(server.failure != null);
    try std.testing.expect(elapsed < generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms);
    // The loop-side proof that renewal cannot be starved: the connection was
    // dropped within roughly the lease-bound budget, not the 10 s default.
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
        .claimToken = "claim-token",
        .transactionId = key,
        .idempotencyKey = key,
        .operation = .{ .kind = "hangup" },
    }, .{});
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
        // No termination binding: the receipt is "binding unavailable", but the
        // replay entry is still reserved — exactly the client-driven growth the
        // cap exists to bound.
        const applied = try core.submitInput(payload, "viewer-a", 2_000);
        defer core.allocator.free(applied);
        try std.testing.expect(core.input_replays.items.len <= max_replay_entries);
    }
    try std.testing.expectEqual(max_replay_entries, core.input_replays.items.len);
    // FIFO: the four oldest keys evicted, the window retains the newest.
    try std.testing.expectEqualStrings("input-key-4", core.input_replays.items[0].idempotency_key);
    var recent_storage: [32]u8 = undefined;
    const recent_key = try std.fmt.bufPrint(&recent_storage, "input-key-{d}", .{max_replay_entries + 3});
    // Recent-key idempotency still works: a replay hits the ledger (no append).
    const replay_payload = try inputSubmitPayload(std.testing.allocator, recent_key);
    defer std.testing.allocator.free(replay_payload);
    const replayed = try core.submitInput(replay_payload, "viewer-a", 2_000);
    defer core.allocator.free(replayed);
    try std.testing.expectEqual(max_replay_entries, core.input_replays.items.len);

    // The resize ledger shares the cap.
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

test "host child environment strips DYLD_ but keeps the rest" {
    if (c.setenv("DYLD_HIVE_SCRUB_TEST", "1", 1) != 0) return error.SetEnvironmentFailed;
    defer _ = c.unsetenv("DYLD_HIVE_SCRUB_TEST");
    if (c.setenv("HIVE_SCRUB_KEEP_TEST", "1", 1) != 0) return error.SetEnvironmentFailed;
    defer _ = c.unsetenv("HIVE_SCRUB_KEEP_TEST");
    const scrubbed = try scrubbedHostEnvironment(std.testing.allocator);
    defer std.testing.allocator.free(scrubbed);
    try std.testing.expect(scrubbed.len > 0);
    try std.testing.expect(scrubbed[scrubbed.len - 1] == null);
    var kept = false;
    for (scrubbed) |entry| {
        const text = std.mem.span(entry orelse break);
        try std.testing.expect(!std.mem.startsWith(u8, text, "DYLD_"));
        if (std.mem.startsWith(u8, text, "HIVE_SCRUB_KEEP_TEST=")) kept = true;
    }
    try std.testing.expect(kept);
}

test "null-sink VT effects retention fails closed at the journal ceiling" {
    const audit = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    defer audit.engine().deinit();
    // Simulate a verification engine that already retains the §18 journal
    // ceiling: one more PTY-effect byte must fail closed, not grow the
    // session-lifetime copy without bound.
    try audit.effects.ensureTotalCapacity(std.testing.allocator, terminal_state.journal_max_bytes);
    audit.effects.items.len = terminal_state.journal_max_bytes;
    const reply = "x";
    RealVtEngine.writePtyCallback(audit.terminal, audit, reply.ptr, reply.len);
    try std.testing.expect(audit.effect_failed);
    try std.testing.expectEqual(terminal_state.journal_max_bytes, audit.effects.items.len);
}

// The engine digest is a full checkpoint export of the whole terminal. Taking
// it on every write made each output chunk cost O(terminal state), which is
// what made a sustained-output run livelock; only tryCheckpoint reads it.
test "sustained output does not export a checkpoint per written chunk" {
    const real = try RealVtEngine.create(std.testing.allocator, 80, 24, null);
    const engine = real.engine();
    defer engine.deinit();

    const baseline = real.bridge_exports;
    var index: usize = 0;
    while (index < 16) : (index += 1) try engine.write("sustained output ");
    try std.testing.expectEqual(baseline, real.bridge_exports);

    // Deferring the measurement must not stale it: the first read pays for one
    // export, a repeat read pays for none, and a later write invalidates it.
    const measured = engine.digest();
    try std.testing.expectEqual(baseline + 1, real.bridge_exports);
    try std.testing.expectEqualSlices(u8, &measured, &engine.digest());
    try std.testing.expectEqual(baseline + 1, real.bridge_exports);

    try engine.write("and more output ");
    const after = engine.digest();
    try std.testing.expectEqual(baseline + 2, real.bridge_exports);
    try std.testing.expect(!std.mem.eql(u8, &measured, &after));
}

// Freeze case E producer size (`docs/contracts/terminal-host-v1.md`). An exact
/// multiple of `freeze_e_block_bytes`, so the expected byte at absolute offset
/// `o` is `block[o % freeze_e_block_bytes]`.
const freeze_e_target_bytes: usize = 100 * 1024 * 1024;
const freeze_e_block_bytes: usize = 64 * 1024;
/// Bytes read before the software stop is issued: far enough into the file that
/// the producer provably still has work left, cheap enough to reach quickly.
const freeze_e_stop_after_bytes: u64 = 8 * 1024 * 1024;

/// Minimal VT engine for freeze case E. libghostty-vt verifies page integrity
/// on every scroll in a Debug build, which puts 100 MiB of real parsing well
/// over an hour in the ordinary native suite; VT throughput and fidelity are
/// B1's qualification surface, not this case's. Everything freeze case E is
/// about — the PTY, software flow control, the journal, the checkpoint store,
/// eviction and the gap — stays real, and this double costs O(1) per chunk by
/// carrying a rolling hash of the bytes written instead of the bytes.
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

/// Drains a real PTY into the real journal exactly as the host loop does, while
/// recording the two facts freeze case E is about: the digest of every byte read
/// and the high-water of retained journal memory.
const FreezeEDrainer = struct {
    host: *pty_host.PtyHost,
    state: *terminal_state.TerminalState,
    digest: std.crypto.hash.sha2.Sha256 = std.crypto.hash.sha2.Sha256.init(.{}),
    total: u64 = 0,
    max_retained: usize = 0,

    /// Reads until `until` bytes have been consumed, or until `idle_budget`
    /// consecutive would-block polls prove the producer quiescent. Returns true
    /// only for the quiescent stop, so a caller can tell "stopped" from "done".
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

// Freeze case E: a 100 MiB producer with a stopped/resumed reader and software
// flow stop/start must keep byte integrity, bound retained memory, and report
// an explicit gap instead of a silently shortened replay. pty_host's SLO-04
// seed proves the read path alone; this drives the real journal, the real
// checkpoint store, and the real VT engine behind them.
test "freeze E: 100 MiB producer bounds retention, keeps byte integrity, and gaps explicitly" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    const allocator = std.testing.allocator;
    const block = try allocator.alloc(u8, freeze_e_block_bytes);
    defer allocator.free(block);
    // Printable ASCII only: a control byte would make the producer a VT fuzz
    // corpus (B1's subject), and OPOST|ONLCR would rewrite a bare newline into
    // CR LF so the bytes read would no longer be the bytes produced. Column
    // wrapping still drives the scrollback this case needs.
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

    // Positive control for the quiescence instrument: while the producer runs,
    // the same detector that must fire after XOFF must NOT fire here. Without
    // this, "quiescent" could just mean "the poll budget was too small".
    try std.testing.expect(!try drainer.drain(freeze_e_stop_after_bytes, 2_000));
    try std.testing.expectEqual(freeze_e_stop_after_bytes, drainer.total);

    var flow_transitions: u8 = 0;
    try freezeESendFlowByte(&host, 19); // stop_byte (^S)
    flow_transitions += 1;
    try std.testing.expect(try drainer.drain(freeze_e_target_bytes, 200));
    const stopped_total = drainer.total;
    try std.testing.expect(stopped_total < freeze_e_target_bytes);

    // The stop holds: a further quiet window yields no byte at all.
    std.Thread.sleep(100 * std.time.ns_per_ms);
    try std.testing.expect(try drainer.drain(freeze_e_target_bytes, 50));
    try std.testing.expectEqual(stopped_total, drainer.total);

    try freezeESendFlowByte(&host, 17); // start_byte (^Q)
    flow_transitions += 1;
    try std.testing.expect(!try drainer.drain(freeze_e_target_bytes, 5_000));
    try std.testing.expectEqual(@as(u8, 2), flow_transitions);

    // Byte integrity: every produced byte arrived exactly once, in order,
    // across the stop and the restart.
    var observed_digest: [32]u8 = undefined;
    drainer.digest.final(&observed_digest);
    try std.testing.expectEqual(@as(u64, freeze_e_target_bytes), drainer.total);
    try std.testing.expectEqualSlices(u8, &expected_digest, &observed_digest);
    try std.testing.expectEqual(@as(u64, freeze_e_target_bytes), state.outputSeq());

    // Bounded memory: 100 MiB flowed through a journal that never exceeded its
    // ceiling, and nothing outside the journal is retained on its behalf.
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

    // The gap boundary is exact and its checkpoint requirement is honest: when
    // a checkpoint is offered as the bridge, it must reach the retained start.
    const retained = try state.journal.sliceFrom(retained_start);
    try std.testing.expectEqual(freeze_e_target_bytes - retained_start, retained.len);
    if (state.checkpointAvailable()) {
        const checkpoint = state.newestCheckpoint() orelse return error.TestUnexpectedResult;
        try std.testing.expect(checkpoint.header.through_seq >= retained_start);
    }

    // Retained bytes are the exact source bytes at their absolute offsets, so
    // eviction moved the window without corrupting or resequencing the tail.
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
    const expires_at = try broker.wallDeadline(&expiry_storage, additional_ms);
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .grantTokenSha256 = tagged,
        .viewerId = "viewer-a",
        .operations = &[_][]const u8{ "view", "human-input" },
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
    locator: broker.Locator,
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

    // Positive control: a different HELLO capability neither authorizes nor
    // consumes the registered grant.
    try std.testing.expectError(
        error.InvalidViewerGrant,
        core.authorizeViewerAttach(attach_payload, "wrong-capability", 3_000),
    );
    try std.testing.expectEqual(@as(usize, 1), core.grants.items.len);

    var authorization = try core.authorizeViewerAttach(attach_payload, token, 3_000);
    defer authorization.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("viewer-a", authorization.viewer_id);
    try std.testing.expect(authorization.operations.view);
    try std.testing.expect(authorization.operations.human_input);
    try std.testing.expectEqual(@as(u64, 0), authorization.after_seq);
    try std.testing.expectEqual(@as(usize, 0), core.grants.items.len);
    try std.testing.expectError(
        error.InvalidViewerGrant,
        core.authorizeViewerAttach(attach_payload, token, 3_000),
    );
}

test "CLAIM_RESULT reports unknown without inventing an owner when the arbiter is unavailable" {
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
    const payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 1_000),
        .idempotencyKey = "claim-unknown",
    }, .{});
    defer std.testing.allocator.free(payload);
    const result = try core.claimInput(payload, "viewer-a", 2_000);
    defer std.testing.allocator.free(result);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.claim_result_payload,
        result,
    ));
    try std.testing.expect(std.mem.indexOf(u8, result, "\"state\":\"unknown\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"owner\"") == null);
}

// #40 RED control: after viewer-a is granted a human claim, a second viewer
// (or the same viewer after a drop without CLAIM_RELEASE) is denied while
// host `active_claim` is never cleared on stream close. Documents the orphan
// / permanent-input-death mechanism until onViewerDetached + claimRelease land.
test "CLAIM_ACQUIRE denied for second viewer while prior active_claim uncleared" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
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

    const first = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-a",
    }, .{});
    defer std.testing.allocator.free(first);
    const granted = try core.claimInput(first, "viewer-a", 2_000);
    defer std.testing.allocator.free(granted);
    try std.testing.expect(std.mem.indexOf(u8, granted, "\"state\":\"granted\"") != null);
    try std.testing.expect(core.active_claim != null);

    // Simulate drop without CLAIM_RELEASE / onViewerDetached (today's host loop).
    const second = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-b",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-b",
    }, .{});
    defer std.testing.allocator.free(second);
    const denied = try core.claimInput(second, "viewer-b", 3_000);
    defer std.testing.allocator.free(denied);
    try std.testing.expect(std.mem.indexOf(u8, denied, "\"state\":\"denied\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, denied, "input already claimed") != null);
    // Host still holds the first claim — second reattach cannot recover without detach.
    try std.testing.expect(core.active_claim != null);

    // Unclean drop path (#40 fix): onViewerDetached clears host claim + orphans arbiter.
    core.onViewerDetached("viewer-a", 3_500);
    try std.testing.expect(core.active_claim == null);
    try std.testing.expectEqual(input_arbiter.State.human_orphaned, arbiter.currentState());
    // The dropped claim is retained as the input owner of record for
    // inspection (real-host-golden inspects inputOwner after viewer detach).
    try std.testing.expect(core.orphaned_claim != null);
    try std.testing.expectEqualStrings("viewer-a", core.orphaned_claim.?.writer);
    try std.testing.expectEqualStrings("human", core.orphaned_claim.?.kind);
    try std.testing.expect(core.orphaned_claim.?.token.len > 0);
    try std.testing.expect(core.orphaned_claim.?.lease_expires_at.len > 0);

    // Never-steal mutation: automation still cannot take an orphaned human lease.
    const automation = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "automation-contender",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-auto",
    }, .{});
    defer std.testing.allocator.free(automation);
    const auto_denied = try core.claimInput(automation, "automation-contender", 3_500);
    defer std.testing.allocator.free(auto_denied);
    // Invariant must bite as a real denial — unknown/error paths do not count.
    try std.testing.expect(std.mem.indexOf(u8, auto_denied, "\"state\":\"denied\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, auto_denied, "HumanOrphaned") != null);
    try std.testing.expectEqual(input_arbiter.State.human_orphaned, arbiter.currentState());

    // Returning human (viewer-b as operator resume) is granted a new claim.
    const third = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-b",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-b-resume",
    }, .{});
    defer std.testing.allocator.free(third);
    const resumed = try core.claimInput(third, "viewer-b", 4_000);
    defer std.testing.allocator.free(resumed);
    try std.testing.expect(std.mem.indexOf(u8, resumed, "\"state\":\"granted\"") != null);
    try std.testing.expect(core.active_claim != null);
    // A grant resolves ownership: the retained orphan is gone.
    try std.testing.expect(core.orphaned_claim == null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());

    // Clean CLAIM_RELEASE → FREE; next human acquires without resume.
    const token = core.active_claim.?.token;
    const release_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = token,
        .kind = "cancel",
    }, .{});
    defer std.testing.allocator.free(release_payload);
    const released = try core.releaseInput(release_payload, "viewer-b", 5_000);
    defer std.testing.allocator.free(released);
    try std.testing.expect(core.active_claim == null);
    try std.testing.expectEqual(input_arbiter.State.free, arbiter.currentState());

    const fourth = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-c",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-c-clean",
    }, .{});
    defer std.testing.allocator.free(fourth);
    const clean = try core.claimInput(fourth, "viewer-c", 6_000);
    defer std.testing.allocator.free(clean);
    try std.testing.expect(std.mem.indexOf(u8, clean, "\"state\":\"granted\"") != null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());
}

test "human input ownership lasts until release or viewer detach" {
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
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
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

    // The frozen wire still carries a lease duration, but a connected viewer's
    // keyboard ownership is connection-scoped: idle time cannot revoke it.
    const claim_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 2_000),
        .idempotencyKey = "claim-connection-a",
    }, .{});
    defer std.testing.allocator.free(claim_payload);
    const granted = try core.claimInput(claim_payload, "viewer-a", 2_000);
    defer std.testing.allocator.free(granted);
    try std.testing.expect(std.mem.indexOf(u8, granted, "\"state\":\"granted\"") != null);
    const owner_token = try std.testing.allocator.dupe(u8, core.active_claim.?.token);
    defer std.testing.allocator.free(owner_token);

    // Submit after the advertised two-second timestamp. The same connected
    // viewer remains authoritative and its token is unchanged.
    const input = try a3BytesPayload(
        std.testing.allocator,
        registration,
        core.active_claim.?.token,
        "claim-connection-input",
        "claim-connection-input",
        "x",
    );
    defer std.testing.allocator.free(input);
    const applied = try core.submitInput(input, "viewer-a", 3_000 * std.time.ns_per_ms);
    defer std.testing.allocator.free(applied);
    try std.testing.expect(std.mem.indexOf(u8, applied, "\"stage\":\"written-to-terminal\"") != null);
    try std.testing.expectEqualStrings(owner_token, core.active_claim.?.token);

    // A second viewer is fenced until the owning connection detaches.
    const contender_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-b",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 2_000),
        .idempotencyKey = "claim-connection-b",
    }, .{});
    defer std.testing.allocator.free(contender_payload);
    const denied = try core.claimInput(
        contender_payload,
        "viewer-b",
        3_000 * std.time.ns_per_ms,
    );
    defer std.testing.allocator.free(denied);
    try std.testing.expect(std.mem.indexOf(u8, denied, "\"state\":\"denied\"") != null);

    core.onViewerDetached("viewer-a", 3_000 * std.time.ns_per_ms);
    const reacquired = try core.claimInput(
        contender_payload,
        "viewer-b",
        3_001 * std.time.ns_per_ms,
    );
    defer std.testing.allocator.free(reacquired);
    try std.testing.expect(std.mem.indexOf(u8, reacquired, "\"state\":\"granted\"") != null);
    try std.testing.expect(!std.mem.eql(u8, owner_token, core.active_claim.?.token));
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
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
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

    const claim_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 1_000),
        .idempotencyKey = "claim-hangup",
    }, .{});
    defer std.testing.allocator.free(claim_payload);
    const claim_result = try core.claimInput(claim_payload, "viewer-a", 2_000);
    defer std.testing.allocator.free(claim_result);
    const Granted = struct { result: struct { claim: struct { token: []const u8 } } };
    var granted = try std.json.parseFromSlice(Granted, std.testing.allocator, claim_result, .{
        .ignore_unknown_fields = true,
    });
    defer granted.deinit();
    const input_payload = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = granted.value.result.claim.token,
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
    // Privileged broker RPCs fail closed until adoption (the broker opens one
    // connection per RPC, so adoption runs on its own connection first).
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

fn orphanDiscardPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    mode: []const u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var root = std.json.ObjectMap.init(arena.allocator());
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("locator", try locatorValue(arena.allocator(), registration.record.locator));
    try root.put("mode", .{ .string = mode });
    return std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
}

// §22 / 2026-07-21 messaging regression. A human claim orphaned by an unclean
// viewer drop denied every automation claim forever, and operatorDiscard had no
// caller. INPUT_ORPHAN_DISCARD is that caller. This walks the whole deadlock:
// claim -> unclean drop -> automation DENIED -> discard -> automation GRANTED.
test "INPUT_ORPHAN_DISCARD ends the HumanOrphaned deadlock and automation is heard again" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
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

    const discard_payload = try orphanDiscardPayload(std.testing.allocator, registration, "orphaned");
    defer std.testing.allocator.free(discard_payload);
    const preempt_payload = try orphanDiscardPayload(std.testing.allocator, registration, "held");
    defer std.testing.allocator.free(preempt_payload);

    // POSITIVE CONTROL: a FREE arbiter is refused, in-band, naming its state.
    // Without this the typed discarded result below could be a constant.
    const free_refusal = try core.discardInputOrphan(discard_payload, 1_500);
    defer std.testing.allocator.free(free_refusal);
    try std.testing.expect(std.mem.indexOf(u8, free_refusal, "\"state\":\"refused\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, free_refusal, "free") != null);

    const human = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-a",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-a",
    }, .{});
    defer std.testing.allocator.free(human);
    const granted = try core.claimInput(human, "viewer-a", 2_000);
    defer std.testing.allocator.free(granted);
    try std.testing.expect(std.mem.indexOf(u8, granted, "\"state\":\"granted\"") != null);

    // NEVER-STEAL CONTROL: a LIVE human claim is refused too. This is the whole
    // #40 invariant; if this ever passes, the discard has become a steal.
    const live_refusal = try core.discardInputOrphan(discard_payload, 2_500);
    defer std.testing.allocator.free(live_refusal);
    try std.testing.expect(std.mem.indexOf(u8, live_refusal, "\"state\":\"refused\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, live_refusal, "human_owned") != null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());

    // M1 authorizes the delivery path to preempt a held human draft. Its
    // result is distinct from an orphan discard, so callers can show/audit it.
    const preempted = try core.discardInputOrphan(preempt_payload, 2_750);
    defer std.testing.allocator.free(preempted);
    try std.testing.expect(std.mem.indexOf(u8, preempted, "\"state\":\"preempted\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, preempted, "\"priorOwnerViewerId\":\"viewer-a\"") != null);
    try std.testing.expectEqual(input_arbiter.State.free, arbiter.currentState());
    try std.testing.expect(core.active_claim == null);

    const regranted = try core.claimInput(human, "viewer-a", 2_800);
    defer std.testing.allocator.free(regranted);
    try std.testing.expect(std.mem.indexOf(u8, regranted, "\"state\":\"granted\"") != null);

    // The arming condition: the viewer dies without releasing.
    core.onViewerDetached("viewer-a", 3_000);
    try std.testing.expectEqual(input_arbiter.State.human_orphaned, arbiter.currentState());

    const automation = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "hive-daemon",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-auto-1",
    }, .{});
    defer std.testing.allocator.free(automation);
    const deadlocked = try core.claimInput(automation, "hive-daemon", 3_000);
    defer std.testing.allocator.free(deadlocked);
    try std.testing.expect(std.mem.indexOf(u8, deadlocked, "\"state\":\"denied\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, deadlocked, "HumanOrphaned") != null);

    // The exit: discard reports the orphan's owner of record and frees input.
    const discarded = try core.discardInputOrphan(discard_payload, 123_003_000);
    defer std.testing.allocator.free(discarded);
    try std.testing.expect(std.mem.indexOf(u8, discarded, "\"state\":\"discarded\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, discarded, "\"priorOwnerViewerId\":\"viewer-a\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, discarded, "\"orphanAgeMilliseconds\":\"123\"") != null);
    try std.testing.expectEqual(input_arbiter.State.free, arbiter.currentState());
    try std.testing.expect(core.orphaned_claim == null);

    // Retry: the same automation claim the deadlock denied is now granted.
    const retry = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "hive-daemon",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 60_000),
        .idempotencyKey = "claim-auto-2",
    }, .{});
    defer std.testing.allocator.free(retry);
    const retried = try core.claimInput(retry, "hive-daemon", 4_000);
    defer std.testing.allocator.free(retried);
    try std.testing.expect(std.mem.indexOf(u8, retried, "\"state\":\"granted\"") != null);
}

fn a3BytesPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    claim_token: []const u8,
    transaction_id: []const u8,
    idempotency_key: []const u8,
    body: []const u8,
) ![]u8 {
    const encoded = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(body.len));
    defer allocator.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, body);
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = claim_token,
        .transactionId = transaction_id,
        .idempotencyKey = idempotency_key,
        .operation = .{ .kind = "bytes", .encoding = "base64", .bytes = encoded },
    }, .{});
}

test "A3 live drill: automation never writes inside a human composition" {
    const human_bytes = [_][]const u8{ "H1", "H2", "H3", "H4" };
    const composition = "H1H2H3H4";
    const automation = "AUTOMATION";

    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const output_name = "a3-interleaving.bin";
    const created = try tmp.dir.createFile(output_name, .{});
    created.close();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const output_path = try tmp.dir.realpath(output_name, &path_buf);
    switch (try pty.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "exec /bin/cat >> \"$1\"",
            "hive-a3-drill",
            output_path,
        },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
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

    const human_claim = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "viewer-human",
        .kind = "human",
        .leaseMilliseconds = @as(u64, 10_000),
        .idempotencyKey = "a3-human",
    }, .{});
    defer std.testing.allocator.free(human_claim);
    const human_granted = try core.claimInput(human_claim, "viewer-human", 2_000);
    defer std.testing.allocator.free(human_granted);
    try std.testing.expect(std.mem.indexOf(u8, human_granted, "\"state\":\"granted\"") != null);
    try std.testing.expectEqual(input_arbiter.State.human_owned, arbiter.currentState());
    const human_token = core.active_claim.?.token;

    // Contend at every transaction boundary: the active human claim denies
    // automation, and a submit attempted with a forged token is fenced by the
    // single host write path before it can reach the PTY.
    for (human_bytes, 0..) |body, index| {
        var id_storage: [48]u8 = undefined;
        const id = try std.fmt.bufPrint(&id_storage, "a3-human-{d}", .{index});
        const human_submit = try a3BytesPayload(
            std.testing.allocator,
            registration,
            human_token,
            id,
            id,
            body,
        );
        defer std.testing.allocator.free(human_submit);
        const human_applied = try core.submitInput(human_submit, "viewer-human", 3_000);
        defer std.testing.allocator.free(human_applied);
        try std.testing.expect(
            std.mem.indexOf(u8, human_applied, "\"stage\":\"written-to-terminal\"") != null,
        );

        var auto_id_storage: [48]u8 = undefined;
        const auto_id = try std.fmt.bufPrint(&auto_id_storage, "a3-auto-{d}", .{index});
        const auto_claim = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
            .schemaVersion = @as(u8, 1),
            .session = .{
                .key = registration.record.locator.session_id,
                .incarnation = "1",
            },
            .writer = "hive-daemon",
            .kind = "automation",
            .leaseMilliseconds = @as(u64, 10_000),
            .idempotencyKey = auto_id,
        }, .{});
        defer std.testing.allocator.free(auto_claim);
        const auto_denied = try core.claimInput(auto_claim, "hive-daemon", 3_000);
        defer std.testing.allocator.free(auto_denied);
        try std.testing.expect(std.mem.indexOf(u8, auto_denied, "\"state\":\"denied\"") != null);
        try std.testing.expect(std.mem.indexOf(u8, auto_denied, human_token) != null);

        const forced_submit = try a3BytesPayload(
            std.testing.allocator,
            registration,
            "forged-automation-claim",
            auto_id,
            auto_id,
            automation,
        );
        defer std.testing.allocator.free(forced_submit);
        const auto_refused = try core.submitInput(forced_submit, "hive-daemon", 3_000);
        defer std.testing.allocator.free(auto_refused);
        try std.testing.expect(std.mem.indexOf(u8, auto_refused, "\"stage\":\"rejected\"") != null);
        try std.testing.expect(std.mem.indexOf(u8, auto_refused, "input claim fenced") != null);
    }

    for (0..500) |_| {
        const file = try tmp.dir.openFile(output_name, .{});
        const size = try file.getEndPos();
        file.close();
        if (size >= composition.len) break;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    std.Thread.sleep(150 * std.time.ns_per_ms);
    const during_file = try tmp.dir.openFile(output_name, .{});
    defer during_file.close();
    const during = try during_file.readToEndAlloc(std.testing.allocator, 4096);
    defer std.testing.allocator.free(during);
    try std.testing.expectEqualStrings(composition, during);

    const release = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .claimToken = human_token,
        .kind = "submit",
    }, .{});
    defer std.testing.allocator.free(release);
    const released = try core.releaseInput(release, "viewer-human", 4_000);
    defer std.testing.allocator.free(released);
    try std.testing.expectEqual(input_arbiter.State.free, arbiter.currentState());

    // Positive control: the same automation path reaches the child immediately
    // after release, so its absence above is the human claim, not a dead path.
    const auto_claim = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .schemaVersion = @as(u8, 1),
        .session = .{
            .key = registration.record.locator.session_id,
            .incarnation = "1",
        },
        .writer = "hive-daemon",
        .kind = "automation",
        .leaseMilliseconds = @as(u64, 10_000),
        .idempotencyKey = "a3-auto-after-release",
    }, .{});
    defer std.testing.allocator.free(auto_claim);
    const auto_granted = try core.claimInput(auto_claim, "hive-daemon", 5_000);
    defer std.testing.allocator.free(auto_granted);
    try std.testing.expect(std.mem.indexOf(u8, auto_granted, "\"state\":\"granted\"") != null);
    const auto_submit = try a3BytesPayload(
        std.testing.allocator,
        registration,
        core.active_claim.?.token,
        "a3-auto-submit",
        "a3-auto-submit",
        automation,
    );
    defer std.testing.allocator.free(auto_submit);
    const auto_applied = try core.submitInput(auto_submit, "hive-daemon", 5_000);
    defer std.testing.allocator.free(auto_applied);
    try std.testing.expect(
        std.mem.indexOf(u8, auto_applied, "\"stage\":\"written-to-terminal\"") != null,
    );

    for (0..500) |_| {
        const file = try tmp.dir.openFile(output_name, .{});
        const size = try file.getEndPos();
        file.close();
        if (size >= composition.len + automation.len) break;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    std.Thread.sleep(150 * std.time.ns_per_ms);
    const final_file = try tmp.dir.openFile(output_name, .{});
    defer final_file.close();
    const recorded = try final_file.readToEndAlloc(std.testing.allocator, 4096);
    defer std.testing.allocator.free(recorded);
    try std.testing.expectEqualStrings(composition ++ automation, recorded);
}

test "INPUT_ORPHAN_DISCARD rejects a locator that is not this host's" {
    var pty = try pty_host.PtyHost.init(std.testing.allocator);
    defer pty.deinit();
    var sink: PtyQueueSink = .{ .pty = &pty };
    var encoder: TestIdentityEncoder = .{};
    var arbiter = input_arbiter.InputArbiter.init(
        std.testing.allocator,
        sink.arbiterSink(),
        encoder.encoder(),
        encoder.cancelEncoder(),
    );
    defer arbiter.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var registration = fixtureRegistration();
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

    registration.record.locator.generation = 2;
    const foreign = try orphanDiscardPayload(std.testing.allocator, registration, "orphaned");
    defer std.testing.allocator.free(foreign);
    try std.testing.expectError(error.InvalidOrphanDiscard, core.discardInputOrphan(foreign, 1_000));
}

fn visibilityRenewPayload(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
    workspace_pid: i32,
    workspace_start_token: []const u8,
    revision: u64,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var revision_storage: [32]u8 = undefined;
    const revision_text = try std.fmt.bufPrint(&revision_storage, "{d}", .{revision});
    var root = std.json.ObjectMap.init(arena.allocator());
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("locator", try locatorValue(arena.allocator(), registration.record.locator));
    try root.put("workspaceSessionId", .{ .string = registration.record.visibility.workspace_session_id });
    try root.put("workspacePid", .{ .integer = workspace_pid });
    try root.put("workspaceStartToken", .{ .string = workspace_start_token });
    try root.put("openTerminalRevision", .{ .string = try arena.allocator().dupe(u8, revision_text) });
    return std.json.Stringify.valueAlloc(
        allocator,
        std.json.Value{ .object = root },
        .{},
    );
}

test "host.sock VISIBILITY_RENEW verifies workspace identity and extends exact lease" {
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
    const workspace = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.MissingWorkspaceIdentity;
    var token_storage: [64]u8 = undefined;
    const token = try workspace.start_token.format(&token_storage);
    const payload = try visibilityRenewPayload(
        std.testing.allocator,
        registration,
        c.getpid(),
        token,
        2,
    );
    defer std.testing.allocator.free(payload);
    // Privileged broker RPCs fail closed until adoption.
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
    try writeTestHostRequest(sockets[0], generated.frame_type.visibility_renew, payload);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.renewed, response.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.renewed_payload,
        response.payload,
    ));
    try std.testing.expectEqual(@as(u64, 2), core.lease.open_terminal_revision);
    try std.testing.expectEqual(
        @as(u64, 2_000 + generated.limits.visibility_expiry_ms * std.time.ns_per_ms),
        core.lease.expires_mono_ns,
    );
}

test "VISIBILITY_RENEW positive control rejects a false workspace start token" {
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
    defer core.deinit();
    const payload = try visibilityRenewPayload(
        std.testing.allocator,
        registration,
        c.getpid(),
        "0:0",
        2,
    );
    defer std.testing.allocator.free(payload);
    try std.testing.expectError(
        error.InvalidWorkspaceIdentity,
        core.renewVisibility(payload, 2_000),
    );
    try std.testing.expectEqual(@as(u64, 1), core.lease.open_terminal_revision);
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
    // Trailing NL is intentional input; OPOST|ONLCR expands it to CRLF on the
    // master read path (same contract as the interactive shell).
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
    errdefer thread.join();
    errdefer _ = c.shutdown(sockets[0].handle, c.SHUT_RDWR);

    try writeTestBrokerHello(sockets[0], core.registration);
    try readTestWelcome(sockets[0]);
    try writeTestHostRequest(sockets[0], generated.frame_type.terminate, payload);
    var response = try readRequiredFrame(std.testing.allocator, sockets[0]);
    defer response.deinit(std.testing.allocator);
    thread.join();

    try std.testing.expect(server.failure == null);
    try std.testing.expectEqual(generated.frame_type.terminated, response.header.type_code);
    try std.testing.expect(protocol.validateControlPayload(
        std.testing.allocator,
        generated.wire_schema.terminated_payload,
        response.payload,
    ));
    try std.testing.expect(core.terminated);
    const final = try temporary.dir.readFileAlloc(
        std.testing.allocator,
        "final.json",
        generated.limits.control_json_bytes,
    );
    defer std.testing.allocator.free(final);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"state\":\"terminated\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"waitObserved\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, final, "\"outputSeq\":\"0\"") != null);
    try std.testing.expect(switch (process_inspector.observeProcess(sentinel)) {
        .present => true,
        .absent, .unobservable => false,
    });
}

test "visibility expiry self-terminates without a broker and records failure code" {
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
    const expiry = 1_000 + generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expect(!try core.enforceVisibilityExpiry(expiry - 1));
    try std.testing.expect(try core.enforceVisibilityExpiry(expiry));
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
    try std.testing.expect(std.mem.indexOf(u8, final, "VISIBILITY_EXPIRED") != null);
}

comptime {
    // Composition imports are deliberate even before every surface is wired.
    _ = broker;
    _ = input_arbiter;
    _ = process_inspector;
    _ = protocol;
    _ = pty_host;
}

/// A shadow VT whose resize can be made to fail on demand. Everything else is
/// inert: this case is about the two-part mutation's failure boundary, not
/// about VT fidelity.
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

    // The REAL production adapter over a REAL pseudo-terminal and a REAL
    // TerminalState. An earlier proof used a test-local terminal that held no
    // shadow at all, so nothing executed NeutralTerminalSource and neither half
    // of its two-part mutation was covered.
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
    const window: neutral_host.WindowSize = .{
        .columns = 100,
        .rows = 30,
        .widthPixels = 1000,
        .heightPixels = 600,
    };

    // Both halves land on a healthy path.
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

    // Mutation control for the old PTY-first ordering: fail the candidate's
    // post-resize export. Neither the PTY nor live renderer may move, and the
    // already verified base checkpoint must keep reattachability observable.
    live_shadow.fail_clone_export = true;
    const divergent: neutral_host.WindowSize = .{
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

    // Once export succeeds, the same revision commits both representations.
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
