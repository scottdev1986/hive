const std = @import("std");
const pty_host = @import("pty_host");

const c = @cImport({
    @cInclude("fcntl.h");
});

test "pending A1/B: launch failures carry layer and OS code evidence" {
    try std.testing.expect(@hasDecl(pty_host, "LaunchFailureEvidence"));
    if (@hasDecl(pty_host, "LaunchFailureEvidence")) {
        const Evidence = pty_host.LaunchFailureEvidence;
        try std.testing.expect(@hasField(Evidence, "layer"));
        try std.testing.expect(@hasField(Evidence, "os_code"));
    }
}

test "pending A1/C: spawn accepts an explicit transferable descriptor map" {
    try std.testing.expect(@hasField(pty_host.SpawnSpec, "descriptor_map"));
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
    _ = try host.spawn(.{
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
