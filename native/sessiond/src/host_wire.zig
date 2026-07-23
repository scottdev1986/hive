const std = @import("std");
const generated = @import("session_protocol_generated");
const protocol = @import("protocol");

pub fn readRequiredFrame(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
) !protocol.Frame {
    const file: std.fs.File = .{ .handle = stream.handle };
    return switch (try protocol.readFrame(allocator, file.deprecatedReader())) {
        .frame => |frame| frame,
        else => error.InvalidRegistrationFrame,
    };
}

pub fn writeFailure(
    allocator: std.mem.Allocator,
    stream: std.net.Stream,
    request: protocol.Header,
    code_value: protocol.WireError,
) !void {
    var code_storage: [64]u8 = undefined;
    const tag = @tagName(code_value);
    const code = std.ascii.upperString(code_storage[0..tag.len], tag);
    const payload = try std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .code = code,
        .message = tag,
        .diagnosticId = @as(?[]const u8, null),
    }, .{});
    defer allocator.free(payload);
    if (!protocol.validateControlPayload(
        allocator,
        generated.wire_schema.error_payload,
        payload,
    )) return error.InvalidErrorPayload;
    const header: protocol.Header = .{
        .minor = if (protocol.minorSupported(request.minor))
            request.minor
        else
            generated.protocol_max_minor,
        .type_code = generated.frame_type.@"error",
        .flags = generated.frame_flag.response |
            generated.frame_flag.final |
            generated.frame_flag.error_flag,
        .payload_length = @intCast(payload.len),
        .request_id = request.request_id,
        .stream_seq = 0,
    };
    try protocol.writeFrame(stream, header, payload);
}
