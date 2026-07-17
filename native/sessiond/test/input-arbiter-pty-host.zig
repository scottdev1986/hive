const std = @import("std");
const input_arbiter = @import("input_arbiter");
const pty_host = @import("pty_host");

const HostSink = struct {
    host: *pty_host.PtyHost,
    calls: usize = 0,
    accepted: ?pty_host.ByteRange = null,

    fn sink(self: *HostSink) input_arbiter.WriteSink {
        return .{
            .context = self,
            .writeFn = write,
            .closeFn = close,
        };
    }

    fn write(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *HostSink = @ptrCast(@alignCast(context));
        self.calls += 1;
        self.accepted = try self.host.writeAccept(bytes);
    }

    fn close(context: *anyopaque) void {
        _ = context;
    }
};

const MaxExpansionEncoder = struct {
    fn encoder() input_arbiter.Encoder {
        return .{ .context = undefined, .encodeFn = encode };
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
        const framing = framingBytes();
        try out.appendSlice(allocator, &framing);
        for (0..input_arbiter.encoded_expansion_factor) |_| {
            try out.appendSlice(allocator, body);
        }
    }
};

const NoopCancelEncoder = struct {
    fn encoder() input_arbiter.CancelEncoder {
        return .{ .context = undefined, .encodeFn = encode };
    }

    fn encode(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        _ = context;
        _ = allocator;
        _ = out;
    }
};

fn framingBytes() [input_arbiter.encoded_framing_slack]u8 {
    var framing: [input_arbiter.encoded_framing_slack]u8 = undefined;
    for (&framing, 0..) |*byte, i| byte.* = @truncate(i * 17 + 3);
    return framing;
}

fn sha256(bytes: []const u8) [32]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return digest;
}

test "full 1 MiB automation transaction is atomically queued and drained in order" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    const allocator = std.testing.allocator;
    const encoded_len = input_arbiter.automated_message_max_bytes *
        input_arbiter.encoded_expansion_factor + input_arbiter.encoded_framing_slack;
    try std.testing.expectEqual(encoded_len, pty_host.write_queue_cap_bytes);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const output_name = "automation-encoded.bin";
    {
        const output = try tmp.dir.createFile(output_name, .{});
        output.close();
    }
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const output_path = try tmp.dir.realpath(output_name, &path_buf);

    var host = try pty_host.PtyHost.init(allocator);
    defer host.deinit();
    _ = try host.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "exec /bin/cat > \"$1\"",
            "hive-automation-test",
            output_path,
        },
        .geometry = .{ .columns = 80, .rows = 24 },
    });

    var body = try allocator.alloc(u8, input_arbiter.automated_message_max_bytes);
    defer allocator.free(body);
    for (body, 0..) |*byte, i| byte.* = @truncate(i * 29 + 11);
    const body_digest = sha256(body);

    var sink = HostSink{ .host = &host };
    var arbiter = input_arbiter.InputArbiter.init(
        allocator,
        sink.sink(),
        MaxExpansionEncoder.encoder(),
        NoopCancelEncoder.encoder(),
    );
    defer arbiter.deinit();

    try arbiter.automationBegin(.{
        .transaction_id = "txn_full_1mib",
        .idempotency_key = "idemp_full_1mib",
        .expected_len = body.len,
        .expected_digest = body_digest,
        .recipient_generation = 1,
        .capability_epoch = 0,
        .message_id = "msg_full_1mib",
        .locator = "ses_full_1mib",
        .provider_strategy = "paste",
        .submit = .none,
    });
    var offset: usize = 0;
    while (offset < body.len) {
        const end = @min(offset + pty_host.stream_chunk_max_bytes, body.len);
        _ = try arbiter.automationChunk(offset, body[offset..end]);
        offset = end;
    }

    const result = try arbiter.automationCommit(
        "txn_full_1mib",
        "idemp_full_1mib",
        body.len,
        body_digest,
        1,
        0,
        "msg_full_1mib",
        "ses_full_1mib",
        .none,
    );
    try std.testing.expectEqual(@as(usize, 1), sink.calls);
    const byte_range = result.byte_range.?;
    try std.testing.expectEqual(@as(u64, 0), byte_range.start);
    try std.testing.expectEqual(@as(u64, @intCast(encoded_len)), byte_range.end_exclusive);
    try std.testing.expectEqual(byte_range.start, sink.accepted.?.start);
    try std.testing.expectEqual(byte_range.end_exclusive, sink.accepted.?.end_exclusive);
    try std.testing.expectEqual(encoded_len, host.write_queue.items.len);

    var drain_calls: usize = 0;
    var drain_attempts: usize = 0;
    while (host.write_queue.items.len > 0 and drain_attempts < 100_000) : (drain_attempts += 1) {
        const drained = try host.writeDrain();
        try std.testing.expect(drained <= pty_host.stream_chunk_max_bytes);
        if (drained == 0) {
            std.Thread.sleep(100 * std.time.ns_per_us);
        } else {
            drain_calls += 1;
        }
    }
    try std.testing.expectEqual(@as(usize, 0), host.write_queue.items.len);
    try std.testing.expect(drain_calls > 1);

    var observed_len: u64 = 0;
    for (0..500) |_| {
        const output = try tmp.dir.openFile(output_name, .{});
        observed_len = try output.getEndPos();
        output.close();
        if (observed_len == encoded_len) break;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(u64, @intCast(encoded_len)), observed_len);

    var expected_hasher = std.crypto.hash.sha2.Sha256.init(.{});
    const framing = framingBytes();
    expected_hasher.update(&framing);
    for (0..input_arbiter.encoded_expansion_factor) |_| expected_hasher.update(body);
    var expected_digest: [32]u8 = undefined;
    expected_hasher.final(&expected_digest);

    var actual_hasher = std.crypto.hash.sha2.Sha256.init(.{});
    const output = try tmp.dir.openFile(output_name, .{});
    defer output.close();
    var read_buf: [pty_host.stream_chunk_max_bytes]u8 = undefined;
    while (true) {
        const read_len = try output.read(&read_buf);
        if (read_len == 0) break;
        actual_hasher.update(read_buf[0..read_len]);
    }
    var actual_digest: [32]u8 = undefined;
    actual_hasher.final(&actual_digest);
    try std.testing.expectEqualSlices(u8, &expected_digest, &actual_digest);
}
