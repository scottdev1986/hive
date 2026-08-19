const std = @import("std");
const input_arbiter = @import("input_arbiter");
const pty_host = @import("pty_host");

const HostSink = struct {
    host: *pty_host.PtyHost,
    calls: usize = 0,

    fn sink(self: *HostSink) input_arbiter.WriteSink {
        return .{ .context = self, .writeFn = write, .closeFn = close };
    }

    fn write(context: *anyopaque, bytes: []const u8) !void {
        const self: *HostSink = @ptrCast(@alignCast(context));
        self.calls += 1;
        _ = try self.host.writeAccept(bytes);
    }

    fn close(_: *anyopaque) void {}
};

fn drain(host: *pty_host.PtyHost) !void {
    var attempts: usize = 0;
    while (host.write_queue.items.len > 0 and attempts < 100_000) : (attempts += 1) {
        if (try host.writeDrain() == 0) std.Thread.sleep(100 * std.time.ns_per_us);
    }
    try std.testing.expectEqual(@as(usize, 0), host.write_queue.items.len);
}

test "user input reaches the PTY byte-exact and in submission order" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const output_name = "ordered-input.bin";
    (try tmp.dir.createFile(output_name, .{})).close();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const output_path = try tmp.dir.realpath(output_name, &path_buf);

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    switch (try host.spawn(.{
        .argv = &.{ "/bin/sh", "-c", "exec /bin/cat > \"$1\"", "hive-input-test", output_path },
        .terminal_profile = .{
            .input_mode = .literal,
            .echo = false,
            .signal_characters = false,
        },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    var sink: HostSink = .{ .host = &host };
    var arbiter = input_arbiter.InputArbiter.init(sink.sink());
    defer arbiter.deinit();

    _ = try arbiter.submit("draft");
    _ = try arbiter.submit("\x1b[A\r");
    try std.testing.expectEqual(@as(usize, 2), sink.calls);
    try drain(&host);

    var observed: [64]u8 = undefined;
    var count: usize = 0;
    for (0..500) |_| {
        const output = try tmp.dir.openFile(output_name, .{});
        count = try output.readAll(&observed);
        output.close();
        if (count == "draft\x1b[A\r".len) break;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    try std.testing.expectEqualStrings("draft\x1b[A\r", observed[0..count]);
    try std.testing.expectEqual(@as(usize, 2), sink.calls);
}

test "maximum user body is accepted as one PTY queue write" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    switch (try host.spawn(.{
        .argv = &.{ "/bin/sh", "-c", "exec /bin/cat >/dev/null" },
        .terminal_profile = .{
            .input_mode = .literal,
            .echo = false,
            .signal_characters = false,
        },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }
    var sink: HostSink = .{ .host = &host };
    var arbiter = input_arbiter.InputArbiter.init(sink.sink());
    defer arbiter.deinit();
    const body = try std.testing.allocator.alloc(u8, input_arbiter.user_input_max_bytes);
    defer std.testing.allocator.free(body);
    @memset(body, 'x');

    const result = try arbiter.submit(body);
    try std.testing.expectEqual(@as(usize, 1), sink.calls);
    try std.testing.expectEqual(@as(u64, body.len), result.byte_range.end_exclusive);
    try drain(&host);
}
