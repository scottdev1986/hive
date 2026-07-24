const std = @import("std");
const boot_envelope = @import("boot_envelope");
const broker = @import("broker");
const executable_identity = @import("executable_identity");
const generated = @import("session_protocol_generated");
const host_record = @import("host_record");
const protocol = @import("protocol");
const wall_clock = @import("wall_clock");

const BootMessage = boot_envelope.Message;
const readBootMessage = boot_envelope.read;
const writeBootMessage = boot_envelope.write;
const HostRegistration = host_record.HostRegistration;
const WireLocator = host_record.WireLocator;
const WireHostRegisterRequest = host_record.WireHostRegisterRequest;
const encodeHostRegister = host_record.encodeHostRegister;
const encodeRecordJson = host_record.encodeRecordJson;
const encodeCreatedPayload = host_record.encodeCreatedPayload;

/// HELLO remains the authentication preface for ordinary host.sock
/// connections and broker-restart adoption. Fresh-child fd 3 does not use it.
pub const WireHello = struct {
    schemaVersion: u8,
    buildId: []const u8,
    instanceId: []const u8,
    protocol: struct { major: u8, minMinor: u8, maxMinor: u8 },
    clientRole: []const u8,
    grantToken: ?[]const u8 = null,
};

const host_wire = @import("host_wire");
const readRequiredFrame = host_wire.readRequiredFrame;

pub fn writeHostWelcome(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request: protocol.Header,
    registration: HostRegistration,
    build_id: []const u8,
    server_epoch: u64,
) !void {
    var connection_storage: [32]u8 = undefined;
    var epoch_storage: [32]u8 = undefined;
    const connection = try std.fmt.bufPrint(&connection_storage, "{d}", .{
        std.crypto.random.int(u64),
    });
    const epoch = try std.fmt.bufPrint(&epoch_storage, "{d}", .{server_epoch});
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .protocol = .{ .major = generated.protocol_major, .minor = generated.protocol_minor },
        .instanceId = registration.record.locator.instance_id,
        .endpointRole = "host",
        .buildId = build_id,
        .engineBuildId = registration.record.engine_build_id,
        .connectionId = connection,
        .serverEpoch = epoch,
        .limits = .{
            .controlFrameMaxBytes = generated.limits.control_json_bytes,
            .maxInputTransactionBytes = generated.limits.input_transaction_bytes,
            .streamChunkMaxBytes = generated.limits.stream_chunk_bytes,
            .automatedMessageMaxBytes = generated.limits.automated_message_bytes,
            .viewerQueueMaxBytes = generated.limits.viewer_queue_bytes,
        },
    }, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.welcome_payload,
        payload,
    )) return error.InvalidWelcome;
    try protocol.writeFrame(
        stream,
        request.response(generated.frame_type.welcome, payload.len),
        payload,
    );
}

/// Host side of fresh-child startup: receive the private boot envelope, then
/// publish one READY registration after the provider has crossed exec.
pub fn serveInheritedRegistration(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    registration: HostRegistration,
) !BootMessage {
    const file: std.fs.File = .{ .handle = stream.handle };
    var boot = try readBootMessage(allocator, file.deprecatedReader());
    errdefer boot.deinit(allocator);
    try sendReadyAfterBoot(
        allocator,
        stream,
        registration,
    );
    try waitForReadyAcknowledgement(allocator, stream);
    return boot;
}

/// The one fresh-child response. Registry admission and recovery adoption are
/// broker concerns; the child does not wait for an acceptance round trip.
pub fn sendReadyAfterBoot(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    registration: HostRegistration,
) !void {
    const register = try encodeHostRegister(allocator, registration);
    defer allocator.free(register);
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.host_register,
        .flags = 0,
        .payload_length = @intCast(register.len),
        .request_id = 2,
        .stream_seq = 0,
    }, register);
}

pub fn sendStartupFailure(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    startup_error: anyerror,
) !void {
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .code = "NOT_READY",
        .message = @errorName(startup_error),
        .diagnosticId = @as(?[]const u8, null),
    }, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.error_payload,
        payload,
    )) return error.InvalidStartupFailure;
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.@"error",
        .flags = generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        .payload_length = @intCast(payload.len),
        .request_id = 2,
        .stream_seq = 0,
    }, payload);
}

pub fn waitForReadyAcknowledgement(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
) !void {
    var frame = try readRequiredFrame(allocator, stream);
    defer frame.deinit(allocator);
    if (frame.header.type_code != generated.frame_type.host_register or
        frame.header.request_id != 2 or
        frame.header.flags != (generated.frame_flag.response | generated.frame_flag.final) or
        !protocol.validateControlPayload(
            allocator,
            generated.wire_schema.host_register_payload,
            frame.payload,
        )) return error.HostRegistrationRefused;
    const Acknowledgement = struct { schemaVersion: u8, accepted: bool };
    var parsed = try std.json.parseFromSlice(
        Acknowledgement,
        allocator,
        frame.payload,
        .{},
    );
    defer parsed.deinit();
    if (parsed.value.schemaVersion != 1 or !parsed.value.accepted)
        return error.HostRegistrationRefused;
}

pub const ParsedRegistration = struct {
    arena: std.heap.ArenaAllocator,
    registration: HostRegistration,
    record_json: []u8,
    created_payload: []u8,

    pub fn deinit(self: *ParsedRegistration, allocator: std.mem.Allocator) void {
        allocator.free(self.record_json);
        allocator.free(self.created_payload);
        self.arena.deinit();
        self.* = undefined;
    }
};

pub fn promoteTrustedExecutableEvidence(
    allocator: std.mem.Allocator,
    expected_executable: []const u8,
    argv: []const []const u8,
    parsed: *ParsedRegistration,
) ![]u8 {
    if (!std.mem.eql(
        u8,
        parsed.registration.record.expected_executable,
        expected_executable,
    )) return error.HostIdentityMismatch;
    parsed.registration.executable_verified = argv.len > 0 and
        executable_identity.sameFile(allocator, expected_executable, argv[0]);
    return encodeCreatedPayload(allocator, parsed.registration);
}

pub fn parseLocator(allocator: std.mem.Allocator, wire: WireLocator) !broker.Locator {
    const subject: @FieldType(broker.Locator, "subject") = if (std.mem.eql(u8, wire.subject.kind, "root")) blk: {
        if (wire.subject.agentId != null) return error.InvalidHostRegister;
        break :blk .root;
    } else if (std.mem.eql(u8, wire.subject.kind, "agent"))
        .{ .agent = try allocator.dupe(u8, wire.subject.agentId orelse return error.InvalidHostRegister) }
    else
        return error.InvalidHostRegister;
    return .{
        .instance_id = try allocator.dupe(u8, wire.instanceId),
        .session_id = try allocator.dupe(u8, wire.sessionId),
        .generation = wire.generation,
        .subject = subject,
        .host_kind = std.meta.stringToEnum(@FieldType(broker.Locator, "host_kind"), wire.hostKind) orelse
            return error.InvalidHostRegister,
        .engine_build_id = if (wire.engineBuildId) |engine| try allocator.dupe(u8, engine) else null,
    };
}

pub fn parseRegistration(
    allocator: std.mem.Allocator,
    payload: []const u8,
) !ParsedRegistration {
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.host_register_payload,
        payload,
    )) return error.InvalidHostRegister;
    var parsed = try std.json.parseFromSlice(WireHostRegisterRequest, allocator, payload, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (parsed.value.schemaVersion != 1) return error.InvalidHostRegister;

    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const wire = parsed.value.record;
    // HostLaunchReadback uses this field as a validated remaining duration.
    // The broker replaces it with its own absolute monotonic deadline only
    // after Registry admission.
    const lease_remaining_ns = try validatedLeaseRemaining(wire.visibility.expiresAt);
    var registration: HostRegistration = .{
        .record = .{
            .locator = try parseLocator(a, wire.locator),
            .host_pid = wire.hostPid,
            .host_start_token = try a.dupe(u8, wire.hostStartToken),
            .process_root = .{
                .pid = wire.processRoot.pid,
                .start_token = try a.dupe(u8, wire.processRoot.startToken),
                .process_group_id = wire.processRoot.processGroupId,
            },
            .expected_executable = try a.dupe(u8, wire.expectedExecutable),
            .executable_build_hash = try a.dupe(u8, wire.executableBuildHash),
            .engine_build_id = try a.dupe(u8, wire.engineBuildId),
            .protocol_major = wire.protocol.major,
            .protocol_minor = wire.protocol.minor,
            .geometry = .{
                .columns = @intCast(wire.geometry.columns),
                .rows = @intCast(wire.geometry.rows),
                .width_px = wire.geometry.widthPx,
                .height_px = wire.geometry.heightPx,
                .cell_width_px = wire.geometry.cellWidthPx,
                .cell_height_px = wire.geometry.cellHeightPx,
            },
            .state = std.meta.stringToEnum(@FieldType(broker.HostRecord, "state"), wire.state) orelse
                return error.InvalidHostRegister,
            .visibility = .{
                .state = std.meta.stringToEnum(@FieldType(broker.Visibility, "state"), wire.visibility.state) orelse
                    return error.InvalidHostRegister,
                .workspace_session_id = try a.dupe(u8, wire.visibility.workspaceSessionId),
                .open_terminal_revision = try std.fmt.parseInt(
                    u64,
                    wire.visibility.openTerminalRevision,
                    10,
                ),
                .expires_mono_ns = lease_remaining_ns,
            },
            .output_seq = try std.fmt.parseInt(u64, wire.outputSeq, 10),
            .checkpoint_seq = try std.fmt.parseInt(u64, wire.checkpointSeq, 10),
        },
        .expires_at = try a.dupe(u8, wire.visibility.expiresAt),
        .created_at = try a.dupe(u8, wire.visibility.expiresAt),
        .checkpoint_available = false,
        .executable_verified = false,
        .complete = false,
    };
    var created_storage: [32]u8 = undefined;
    const created_at = try broker.wallDeadline(&created_storage, 0);
    registration.created_at = try a.dupe(u8, created_at);
    const record_json = try encodeRecordJson(allocator, registration);
    errdefer allocator.free(record_json);
    const created_payload = try encodeCreatedPayload(allocator, registration);
    return .{
        .arena = arena,
        .registration = registration,
        .record_json = record_json,
        .created_payload = created_payload,
    };
}

pub const FreshChildReady = struct {
    parsed: ParsedRegistration,
    request_header: protocol.Header,
};

/// Sends the private launch data and reads the fresh child's one READY frame.
pub fn launchFreshChild(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    spec_json: []const u8,
    initial_input: []const u8,
    adoption_secret: [32]u8,
    broker_build_id: []const u8,
    instance_id: []const u8,
) !FreshChildReady {
    try writeBootMessage(stream, spec_json, initial_input, adoption_secret);

    var register_frame = try readRequiredFrame(allocator, stream);
    defer register_frame.deinit(allocator);
    if (register_frame.header.type_code == generated.frame_type.@"error") {
        const Failure = struct { message: []const u8 };
        var failure = std.json.parseFromSlice(
            Failure,
            allocator,
            register_frame.payload,
            .{ .ignore_unknown_fields = true },
        ) catch return error.FreshChildFailed;
        defer failure.deinit();
        std.log.warn("fresh terminal child failed before READY: {s}", .{
            failure.value.message,
        });
        return error.FreshChildFailed;
    }
    if (register_frame.header.type_code != generated.frame_type.host_register or
        register_frame.header.flags != 0)
        return error.InvalidHostRegister;
    var result = try parseRegistration(allocator, register_frame.payload);
    errdefer result.deinit(allocator);
    if (!std.mem.eql(u8, result.registration.record.locator.instance_id, instance_id) or
        !std.mem.eql(u8, result.registration.record.executable_build_hash, broker_build_id) or
        result.registration.record.locator.engine_build_id == null or
        !std.mem.eql(
            u8,
            result.registration.record.engine_build_id,
            result.registration.record.locator.engine_build_id.?,
        ))
        return error.InvalidHostRegister;

    return .{
        .parsed = result,
        .request_header = register_frame.header,
    };
}

pub fn acknowledgeFreshChild(
    stream: std.net.Stream,
    request_header: protocol.Header,
) !void {
    const acknowledgement = "{\"schemaVersion\":1,\"accepted\":true}";
    try protocol.writeFrame(
        stream,
        request_header.response(
            generated.frame_type.host_register,
            acknowledgement.len,
        ),
        acknowledgement,
    );
}

pub fn validatedLeaseRemaining(expires_at: []const u8) !u64 {
    return wall_clock.expiryToMonotonic(
        expires_at,
        0,
        generated.limits.visibility_expiry_ms,
    );
}
