const std = @import("std");

pub const WriteSink = struct {
    context: *anyopaque,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,
    closeFn: *const fn (context: *anyopaque) void,

    pub fn write(self: WriteSink, bytes: []const u8) anyerror!void {
        return self.writeFn(self.context, bytes);
    }

    pub fn close(self: WriteSink) void {
        self.closeFn(self.context);
    }
};

pub const Error = error{
    PayloadTooLarge,
    Closed,
    Internal,
    SinkWriteFailed,
};

pub const ByteRange = struct {
    start: u64,
    end_exclusive: u64,
};

pub const InputResult = struct {
    byte_range: ByteRange,
};

pub const user_input_max_bytes: usize = 128 * 1024;

pub const InputArbiter = struct {
    sink: WriteSink,
    closed: bool = false,
    write_high_water: u64 = 0,

    pub fn init(sink: WriteSink) InputArbiter {
        return .{ .sink = sink };
    }

    pub fn deinit(self: *InputArbiter) void {
        self.* = undefined;
    }

    pub fn submit(self: *InputArbiter, bytes: []const u8) Error!InputResult {
        if (self.closed) return error.Closed;
        if (bytes.len > user_input_max_bytes) return error.PayloadTooLarge;
        const start = self.write_high_water;
        const end = std.math.add(u64, start, bytes.len) catch return error.Internal;
        self.sink.write(bytes) catch return error.SinkWriteFailed;
        self.write_high_water = end;
        return .{ .byte_range = .{ .start = start, .end_exclusive = end } };
    }

    pub fn terminate(self: *InputArbiter) Error!void {
        if (self.closed) return error.Closed;
        self.sink.close();
        self.closed = true;
    }
};

const TestSink = struct {
    bytes: std.ArrayList(u8) = .{},
    closed: bool = false,

    fn sink(self: *TestSink) WriteSink {
        return .{ .context = self, .writeFn = write, .closeFn = close };
    }

    fn write(context: *anyopaque, bytes: []const u8) !void {
        const self: *TestSink = @ptrCast(@alignCast(context));
        try self.bytes.appendSlice(std.testing.allocator, bytes);
    }

    fn close(context: *anyopaque) void {
        const self: *TestSink = @ptrCast(@alignCast(context));
        self.closed = true;
    }
};

test "user input reaches the terminal byte-exact and in order" {
    var sink: TestSink = .{};
    defer sink.bytes.deinit(std.testing.allocator);
    var arbiter = InputArbiter.init(sink.sink());
    defer arbiter.deinit();

    const first = "\x1b[3;5h";
    const second = "h\xc3\xa9llo\r";
    const one = try arbiter.submit(first);
    const two = try arbiter.submit(second);

    try std.testing.expectEqualStrings(first ++ second, sink.bytes.items);
    try std.testing.expectEqual(@as(u64, 0), one.byte_range.start);
    try std.testing.expectEqual(@as(u64, first.len), one.byte_range.end_exclusive);
    try std.testing.expectEqual(one.byte_range.end_exclusive, two.byte_range.start);
    try std.testing.expectEqual(
        @as(u64, first.len + second.len),
        two.byte_range.end_exclusive,
    );
}

test "input past the user cap is refused before a byte is written" {
    var sink: TestSink = .{};
    defer sink.bytes.deinit(std.testing.allocator);
    var arbiter = InputArbiter.init(sink.sink());
    defer arbiter.deinit();

    const body = try std.testing.allocator.alloc(u8, user_input_max_bytes + 1);
    defer std.testing.allocator.free(body);
    @memset(body, 'x');

    const accepted = try arbiter.submit(body[0..user_input_max_bytes]);
    try std.testing.expectEqual(
        @as(u64, user_input_max_bytes),
        accepted.byte_range.end_exclusive,
    );
    try std.testing.expectError(error.PayloadTooLarge, arbiter.submit(body));
    try std.testing.expectEqual(@as(usize, user_input_max_bytes), sink.bytes.items.len);
}

test "terminate closes the sink and later writes are refused" {
    var sink: TestSink = .{};
    defer sink.bytes.deinit(std.testing.allocator);
    var arbiter = InputArbiter.init(sink.sink());
    defer arbiter.deinit();

    _ = try arbiter.submit("partial");
    try arbiter.terminate();
    try std.testing.expect(sink.closed);
    try std.testing.expectError(error.Closed, arbiter.submit("more"));
    try std.testing.expectError(error.Closed, arbiter.terminate());
    try std.testing.expectEqualStrings("partial", sink.bytes.items);
}
