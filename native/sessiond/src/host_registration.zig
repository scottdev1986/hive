const std = @import("std");
const generated = @import("session_protocol_generated");
const host_record = @import("host_record");
const protocol = @import("protocol");
const session_types = @import("session_types");

const HostRegistration = host_record.HostRegistration;
const WireLocator = host_record.WireLocator;
const encodeHostRegister = host_record.encodeHostRegister;

/// HELLO remains the authentication preface for ordinary host.sock connections. Fresh-child control streams do not use it.
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

pub fn parseLocator(allocator: std.mem.Allocator, wire: WireLocator) !session_types.Locator {
    const subject: @FieldType(session_types.Locator, "subject") = if (std.mem.eql(u8, wire.subject.kind, "root")) blk: {
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
        .host_kind = std.meta.stringToEnum(@FieldType(session_types.Locator, "host_kind"), wire.hostKind) orelse
            return error.InvalidHostRegister,
        .engine_build_id = if (wire.engineBuildId) |engine| try allocator.dupe(u8, engine) else null,
    };
}
