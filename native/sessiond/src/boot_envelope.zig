//! Private broker↔host bootstrap codec for `hive-sessiond host`.
//!
//! This is not a §20 endpoint protocol. It is the single byte-level authority
//! for the bounded inherited-fd handoff used before the child's READY result.

const std = @import("std");
const generated = @import("session_protocol_generated");

test {
    std.testing.refAllDecls(@This());
}

/// Fixed descriptor inherited by `hive-sessiond host`. The descriptor number
/// is not secret; every sensitive launch byte travels inside the socketpair.
pub const inherited_control_fd: std.posix.fd_t = 3;

/// Fixed 48-byte HVB1 header:
///   0..4   ASCII "HVB1" (magic and version)
///   4..8   big-endian u32 CREATE_BEGIN JSON byte length
///   8..12  big-endian u32 initial-input byte length
///   12..16 reserved zero bytes (nonzero fails closed)
///   16..48 raw 32-byte adoption secret
/// The exact JSON bytes and then exact opaque input bytes follow immediately,
/// without a terminator, padding, or trailer. The next bytes on the same
/// SOCK_STREAM are the generated broker HELLO frame.
const magic = "HVB1";
const header_bytes: usize = 48;

pub const Message = struct {
    spec_json: []u8,
    initial_input: []u8,
    adoption_secret: [32]u8,

    pub fn deinit(self: *Message, allocator: std.mem.Allocator) void {
        allocator.free(self.spec_json);
        std.crypto.secureZero(u8, self.initial_input);
        allocator.free(self.initial_input);
        std.crypto.secureZero(u8, &self.adoption_secret);
        self.* = undefined;
    }
};

pub fn write(
    writer: anytype,
    spec_json: []const u8,
    initial_input: []const u8,
    adoption_secret: [32]u8,
) !void {
    if (spec_json.len > generated.limits.control_json_bytes)
        return error.SpecTooLarge;
    if (initial_input.len > generated.limits.automated_message_bytes)
        return error.InitialInputTooLarge;

    var header: [header_bytes]u8 = @splat(0);
    defer std.crypto.secureZero(u8, header[16..48]);
    @memcpy(header[0..magic.len], magic);
    std.mem.writeInt(u32, header[4..8], @intCast(spec_json.len), .big);
    std.mem.writeInt(u32, header[8..12], @intCast(initial_input.len), .big);
    @memcpy(header[16..48], &adoption_secret);
    try writer.writeAll(&header);
    try writer.writeAll(spec_json);
    try writer.writeAll(initial_input);
}

pub fn read(allocator: std.mem.Allocator, reader: anytype) !Message {
    var header: [header_bytes]u8 = undefined;
    defer std.crypto.secureZero(u8, header[16..48]);
    try reader.readNoEof(&header);
    if (!std.mem.eql(u8, header[0..magic.len], magic) or
        !std.mem.allEqual(u8, header[12..16], 0))
        return error.InvalidBootMessage;

    const spec_len = std.mem.readInt(u32, header[4..8], .big);
    const input_len = std.mem.readInt(u32, header[8..12], .big);
    if (spec_len > generated.limits.control_json_bytes or
        input_len > generated.limits.automated_message_bytes)
        return error.InvalidBootMessage;

    const spec = try allocator.alloc(u8, spec_len);
    errdefer allocator.free(spec);
    const input = try allocator.alloc(u8, input_len);
    errdefer {
        std.crypto.secureZero(u8, input);
        allocator.free(input);
    }
    try reader.readNoEof(spec);
    try reader.readNoEof(input);
    return .{
        .spec_json = spec,
        .initial_input = input,
        .adoption_secret = header[16..48].*,
    };
}

test "HVB1 round trip preserves spec input and raw adoption secret" {
    var bytes: std.ArrayList(u8) = .{};
    defer bytes.deinit(std.testing.allocator);
    const secret: [32]u8 = @splat(0xa5);
    try write(
        bytes.writer(std.testing.allocator),
        "{\"schemaVersion\":1}",
        "initial",
        secret,
    );

    var stream = std.io.fixedBufferStream(bytes.items);
    var decoded = try read(std.testing.allocator, stream.reader());
    defer decoded.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("{\"schemaVersion\":1}", decoded.spec_json);
    try std.testing.expectEqualStrings("initial", decoded.initial_input);
    try std.testing.expectEqualSlices(u8, &secret, &decoded.adoption_secret);
}

test "HVB1 positive controls reject bad magic and nonzero reserved bytes" {
    var header: [header_bytes]u8 = @splat(0);
    @memcpy(header[0..4], "NOPE");
    var bad_magic = std.io.fixedBufferStream(&header);
    try std.testing.expectError(
        error.InvalidBootMessage,
        read(std.testing.allocator, bad_magic.reader()),
    );

    @memcpy(header[0..4], magic);
    header[12] = 1;
    var bad_reserved = std.io.fixedBufferStream(&header);
    try std.testing.expectError(
        error.InvalidBootMessage,
        read(std.testing.allocator, bad_reserved.reader()),
    );
}
