const std = @import("std");
const generated = @import("session_protocol_generated");
const protocol = @import("protocol");

test "response headers preserve request correlation" {
    const request: protocol.Header = .{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.ping,
        .flags = 0,
        .payload_length = 0,
        .request_id = 42,
        .stream_seq = 0,
    };
    try std.testing.expectEqualDeep(protocol.Header{
        .minor = generated.protocol_minor,
        .type_code = generated.frame_type.pong,
        .flags = generated.frame_flag.response | generated.frame_flag.final,
        .payload_length = 12,
        .request_id = 42,
        .stream_seq = 0,
    }, request.response(generated.frame_type.pong, 12));
}
