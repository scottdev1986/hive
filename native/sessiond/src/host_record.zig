const std = @import("std");
const generated = @import("session_protocol_generated");
const protocol = @import("protocol");
const session_types = @import("session_types");

const WireSubject = struct {
    kind: []const u8,
    agentId: ?[]const u8 = null,
};

pub const WireLocator = struct {
    schemaVersion: u8,
    instanceId: []const u8,
    subject: WireSubject,
    generation: u64,
    sessionId: []const u8,
    hostKind: []const u8,
    engineBuildId: ?[]const u8,
};

pub const WireGeometry = generated.TerminalGeometry;

pub const HostRegistration = struct {
    record: session_types.HostRecord,
    expires_at: []const u8,
};

pub fn locatorValue(allocator: std.mem.Allocator, locator: session_types.Locator) !std.json.Value {
    var subject = std.json.ObjectMap.init(allocator);
    try subject.put("kind", .{ .string = @tagName(locator.subject) });
    switch (locator.subject) {
        .root => {},
        .agent => |agent_id| try subject.put("agentId", .{ .string = agent_id }),
    }
    var value = std.json.ObjectMap.init(allocator);
    try value.put("schemaVersion", .{ .integer = 1 });
    try value.put("instanceId", .{ .string = locator.instance_id });
    try value.put("subject", .{ .object = subject });
    try value.put("generation", .{ .integer = @intCast(locator.generation) });
    try value.put("sessionId", .{ .string = locator.session_id });
    try value.put("hostKind", .{ .string = @tagName(locator.host_kind) });
    try value.put("engineBuildId", if (locator.engine_build_id) |engine|
        .{ .string = engine }
    else
        .null);
    return .{ .object = value };
}

pub fn processRootValue(allocator: std.mem.Allocator, root: session_types.ProcessRoot) !std.json.Value {
    var value = std.json.ObjectMap.init(allocator);
    try value.put("pid", .{ .integer = root.pid });
    try value.put("startToken", .{ .string = root.start_token });
    try value.put("processGroupId", .{ .integer = root.process_group_id });
    return .{ .object = value };
}

pub fn geometryValue(allocator: std.mem.Allocator, geometry: session_types.Geometry) !std.json.Value {
    var value = std.json.ObjectMap.init(allocator);
    try value.put("columns", .{ .integer = geometry.columns });
    try value.put("rows", .{ .integer = geometry.rows });
    try value.put("widthPx", .{ .integer = geometry.width_px });
    try value.put("heightPx", .{ .integer = geometry.height_px });
    try value.put("cellWidthPx", .{ .float = geometry.cell_width_px });
    try value.put("cellHeightPx", .{ .float = geometry.cell_height_px });
    return .{ .object = value };
}

pub fn visibilityValue(
    allocator: std.mem.Allocator,
    visibility: session_types.Visibility,
    expires_at: []const u8,
) !std.json.Value {
    var revision_storage: [32]u8 = undefined;
    const revision = try std.fmt.bufPrint(&revision_storage, "{d}", .{
        visibility.open_terminal_revision,
    });
    var value = std.json.ObjectMap.init(allocator);
    try value.put("state", .{ .string = @tagName(visibility.state) });
    try value.put("workspaceSessionId", .{ .string = visibility.workspace_session_id });
    try value.put("openTerminalRevision", .{ .string = try allocator.dupe(u8, revision) });
    try value.put("expiresAt", .{ .string = expires_at });
    return .{ .object = value };
}

pub fn protocolValue(allocator: std.mem.Allocator, major: u8, minor: u8) !std.json.Value {
    var value = std.json.ObjectMap.init(allocator);
    try value.put("major", .{ .integer = major });
    try value.put("minor", .{ .integer = minor });
    return .{ .object = value };
}

fn projectionValue(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
) !std.json.Value {
    const record = registration.record;
    var output_storage: [32]u8 = undefined;
    var checkpoint_storage: [32]u8 = undefined;
    const output = try std.fmt.bufPrint(&output_storage, "{d}", .{record.output_seq});
    const checkpoint = try std.fmt.bufPrint(&checkpoint_storage, "{d}", .{record.checkpoint_seq});
    var value = std.json.ObjectMap.init(allocator);
    try value.put("locator", try locatorValue(allocator, record.locator));
    try value.put("hostPid", .{ .integer = record.host_pid });
    try value.put("hostStartToken", .{ .string = record.host_start_token });
    try value.put("processRoot", try processRootValue(allocator, record.process_root));
    try value.put("expectedExecutable", .{ .string = record.expected_executable });
    try value.put("executableBuildHash", .{ .string = record.executable_build_hash });
    try value.put("engineBuildId", .{ .string = record.engine_build_id });
    try value.put("protocol", try protocolValue(allocator, record.protocol_major, record.protocol_minor));
    try value.put("geometry", try geometryValue(allocator, record.geometry));
    try value.put("state", .{ .string = @tagName(record.state) });
    try value.put("visibility", try visibilityValue(allocator, record.visibility, registration.expires_at));
    try value.put("outputSeq", .{ .string = try allocator.dupe(u8, output) });
    try value.put("checkpointSeq", .{ .string = try allocator.dupe(u8, checkpoint) });
    return .{ .object = value };
}

pub fn encodeHostRegister(
    allocator: std.mem.Allocator,
    registration: HostRegistration,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var root = std.json.ObjectMap.init(arena.allocator());
    try root.put("schemaVersion", .{ .integer = 1 });
    try root.put("record", try projectionValue(arena.allocator(), registration));
    const json = try std.json.Stringify.valueAlloc(allocator, std.json.Value{ .object = root }, .{});
    errdefer allocator.free(json);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.host_register_payload,
        json,
    )) return error.InvalidHostRegister;
    return json;
}
