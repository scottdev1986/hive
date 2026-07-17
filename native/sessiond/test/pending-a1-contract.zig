const std = @import("std");
const pty_host = @import("pty_host");

const c = @cImport({
    @cInclude("errno.h");
    @cInclude("fcntl.h");
    @cInclude("sys/ioctl.h");
    @cInclude("unistd.h");
});

test "pending A1/B: launch failures carry layer and OS code evidence" {
    try std.testing.expect(@hasDecl(pty_host, "LaunchFailureEvidence"));
    if (@hasDecl(pty_host, "LaunchFailureEvidence")) {
        const Evidence = pty_host.LaunchFailureEvidence;
        try std.testing.expect(@hasField(Evidence, "layer"));
        try std.testing.expect(@hasField(Evidence, "os_code"));
    }
}

test "pending A1/B: failed exec reports the real errno and failing layer" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{"/tmp/hive-a1-no-such-executable-7f31c9"},
        .envp = &[_][]const u8{},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => return error.TestUnexpectedResult,
        .exec_failed => |failure| {
            try std.testing.expectEqual(pty_host.LaunchFailureLayer.exec_transition, failure.layer);
            try std.testing.expectEqual(@as(c_int, c.ENOENT), failure.os_code);
        },
    }
    try std.testing.expect(!host.spawned);
    try std.testing.expect(host.master_fd < 0);
    try std.testing.expect(host.pid <= 0);

    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const denied_name = "not-executable";
    {
        const denied = try temporary.dir.createFile(denied_name, .{ .mode = 0o644 });
        defer denied.close();
        try denied.writeAll("not an executable\n");
    }
    var denied_path_storage: [std.fs.max_path_bytes]u8 = undefined;
    const denied_path = try temporary.dir.realpath(denied_name, &denied_path_storage);
    var denied_host = try pty_host.PtyHost.init(std.testing.allocator);
    defer denied_host.deinit();
    const denied_outcome = try denied_host.spawn(.{
        .argv = &[_][]const u8{denied_path},
        .envp = &[_][]const u8{},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (denied_outcome) {
        .running => return error.TestUnexpectedResult,
        .exec_failed => |failure| {
            try std.testing.expectEqual(pty_host.LaunchFailureLayer.exec_transition, failure.layer);
            try std.testing.expectEqual(@as(c_int, c.EACCES), failure.os_code);
        },
    }
}

test "pending A1/C: spawn accepts an explicit transferable descriptor map" {
    try std.testing.expect(@hasField(pty_host.SpawnSpec, "descriptor_map"));
}

test "pending A1/C: a declared descriptor is transferred and the source stays caller-owned" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var transfer_pipe: [2]c_int = .{ -1, -1 };
    try std.testing.expectEqual(@as(c_int, 0), c.pipe(&transfer_pipe));
    defer {
        if (transfer_pipe[0] >= 0) _ = c.close(transfer_pipe[0]);
        if (transfer_pipe[1] >= 0) _ = c.close(transfer_pipe[1]);
    }
    const payload = "mapped-fd\n";
    try std.testing.expectEqual(
        @as(isize, @intCast(payload.len)),
        c.write(transfer_pipe[1], payload.ptr, payload.len),
    );
    _ = c.close(transfer_pipe[1]);
    transfer_pipe[1] = -1;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "IFS= read -r value <&9; if [ \"$value\" = mapped-fd ]; then result=0; else result=91; fi; /bin/sleep 0.2; exit \"$result\"",
        },
        .envp = &[_][]const u8{},
        .descriptor_map = &[_]pty_host.DescriptorMapping{.{
            .source_fd = transfer_pipe[0],
            .target_fd = 9,
        }},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }
    try std.testing.expect(c.fcntl(transfer_pipe[0], c.F_GETFD) >= 0);
    const exit = try host.waitExit(true);
    try std.testing.expect(exit.reaped);
    try std.testing.expectEqual(@as(?u8, 0), exit.exit_code);
}

test "pending A1/C: arbitrary inheritable descriptors do not survive replacement" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    const inherited = try std.posix.open("/dev/null", .{ .ACCMODE = .RDONLY }, 0);
    defer std.posix.close(inherited);
    const flags = c.fcntl(inherited, c.F_GETFD);
    try std.testing.expect(flags >= 0);
    try std.testing.expect(c.fcntl(inherited, c.F_SETFD, flags & ~c.FD_CLOEXEC) == 0);

    var descriptor_storage: [32]u8 = undefined;
    const descriptor = try std.fmt.bufPrint(&descriptor_storage, "{d}", .{inherited});
    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "if [ -e \"/dev/fd/$1\" ]; then result=99; else result=0; fi; /bin/sleep 0.2; exit \"$result\"",
            "pending-a1-c",
            descriptor,
        },
        .envp = &[_][]const u8{},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }
    const exit = try host.waitExit(true);
    try std.testing.expect(exit.reaped);
    try std.testing.expectEqual(@as(?u8, 0), exit.exit_code);
}

test "pending A1/D: resize receipt carries revision ordered position and readback" {
    try std.testing.expect(@hasDecl(pty_host, "ResizeReceipt"));
    if (@hasDecl(pty_host, "ResizeReceipt")) {
        const Receipt = pty_host.ResizeReceipt;
        try std.testing.expect(@hasField(Receipt, "revision"));
        try std.testing.expect(@hasField(Receipt, "ordered_at"));
        try std.testing.expect(@hasField(Receipt, "readback"));
    }
}

test "pending A1/D: resize receipt matches independent TIOCGWINSZ readback" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sleep", "1" },
        .envp = &[_][]const u8{},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    const requested: pty_host.Geometry = .{
        .columns = 111,
        .rows = 37,
        .width_px = 1776,
        .height_px = 999,
    };
    const receipt = try host.resize(requested, 41);
    var kernel: c.struct_winsize = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.ioctl(host.master_fd, c.TIOCGWINSZ, &kernel));
    try std.testing.expectEqual(@as(u64, 41), receipt.revision);
    try std.testing.expect(receipt.ordered_at > 0);
    try std.testing.expect(receipt.readback.eql(requested));
    try std.testing.expectEqual(receipt.readback.rows, @as(u32, kernel.ws_row));
    try std.testing.expectEqual(receipt.readback.columns, @as(u32, kernel.ws_col));
    try std.testing.expectEqual(receipt.readback.width_px, @as(u32, kernel.ws_xpixel));
    try std.testing.expectEqual(receipt.readback.height_px, @as(u32, kernel.ws_ypixel));

    _ = try host.writeAccept("ordered-before-resize");
    const next = try host.resize(.{ .columns = 112, .rows = 38 }, 42);
    try std.testing.expect(next.ordered_at > receipt.ordered_at);
    try std.testing.expectError(
        error.StaleResizeRevision,
        host.resize(.{ .columns = 113, .rows = 39 }, 42),
    );
}
