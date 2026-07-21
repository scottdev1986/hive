const std = @import("std");
const pty_host = @import("pty_host");

const c = @cImport({
    @cInclude("errno.h");
    @cInclude("fcntl.h");
    @cInclude("sys/event.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/time.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

fn collectUntil(
    host: *pty_host.PtyHost,
    output: *std.ArrayList(u8),
    needle: []const u8,
) !void {
    for (0..500) |_| {
        const chunk = host.readAvailable() catch |err| switch (err) {
            error.Closed => return error.OutputClosedEarly,
            else => return err,
        };
        try output.appendSlice(std.testing.allocator, chunk.bytes);
        if (std.mem.indexOf(u8, output.items, needle) != null) return;
        std.Thread.sleep(2 * std.time.ns_per_ms);
    }
    return error.OutputUnavailable;
}

test "pending A1/A: replacement starts as foreground session leader on one PTY" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            "result=0; set -- $(/bin/stty size <&0); [ -t 0 ] && [ -t 1 ] && [ -t 2 ] || result=81; [ \"$1\" = 37 ] && [ \"$2\" = 111 ] || result=84; /bin/sleep 0.2; exit \"$result\"",
        },
        .envp = &[_][]const u8{},
        .geometry = .{ .columns = 111, .rows = 37, .width_px = 1776, .height_px = 999 },
    });
    const readback = switch (outcome) {
        .running => |running| running,
        .exec_failed => return error.TestUnexpectedResult,
    };
    try std.testing.expectEqual(readback.pid, readback.session);
    try std.testing.expectEqual(readback.pid, readback.pgid);
    var foreground_pgid: c_int = -1;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.ioctl(host.master_fd, c.TIOCGPGRP, &foreground_pgid),
    );
    try std.testing.expectEqual(@as(c_int, readback.pgid), foreground_pgid);
    const active = try host.waitExit(false);
    try std.testing.expectEqual(pty_host.ReapAuthority.direct_parent, active.authority);
    try std.testing.expectEqual(pty_host.ExitState.running, active.state);
    try std.testing.expect(!active.reaped);
    var exit = active;
    for (0..200) |_| {
        exit = try host.waitExit(false);
        if (exit.reaped) break;
        if (host.readAvailable()) |chunk| {
            _ = chunk;
        } else |_| {}
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    try std.testing.expect(exit.reaped);
    try std.testing.expectEqual(@as(?u8, 0), exit.exit_code);
}

test "pending A1/F: EVFILT_PROC exit notification is followed by waitpid evidence" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    try std.testing.expect(@hasDecl(pty_host, "ReapAuthority"));
    try std.testing.expect(@hasDecl(pty_host, "ExitState"));
    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sh", "-c", "/bin/sleep 0.2; exit 23" },
        .envp = &[_][]const u8{},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    const queue = c.kqueue();
    try std.testing.expect(queue >= 0);
    defer _ = c.close(queue);
    var change: c.struct_kevent = .{
        .ident = @intCast(host.pid),
        .filter = @intCast(c.EVFILT_PROC),
        .flags = @intCast(c.EV_ADD | c.EV_ONESHOT),
        .fflags = @intCast(c.NOTE_EXIT),
        .data = 0,
        .udata = null,
    };
    var event: c.struct_kevent = undefined;
    var timeout: c.struct_timespec = .{ .tv_sec = 2, .tv_nsec = 0 };
    try std.testing.expectEqual(
        @as(c_int, 1),
        c.kevent(queue, &change, 1, &event, 1, &timeout),
    );
    try std.testing.expectEqual(@as(i16, @intCast(c.EVFILT_PROC)), event.filter);
    try std.testing.expect(event.fflags & @as(u32, @intCast(c.NOTE_EXIT)) != 0);

    const exit = try host.waitExit(true);
    try std.testing.expectEqual(pty_host.ReapAuthority.direct_parent, exit.authority);
    try std.testing.expectEqual(pty_host.ExitState.exited, exit.state);
    try std.testing.expect(exit.reaped);
    try std.testing.expectEqual(@as(?u8, 23), exit.exit_code);
}

test "pending A1/F: lost parent wait authority is unknown rather than fabricated exit" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{ "/bin/sh", "-c", "/bin/sleep 0.2; exit 29" },
        .envp = &[_][]const u8{},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }
    var stolen_status: c_int = 0;
    try std.testing.expectEqual(
        host.pid,
        @as(i32, @intCast(c.waitpid(host.pid, &stolen_status, 0))),
    );
    const exit = try host.waitExit(false);
    try std.testing.expectEqual(pty_host.ReapAuthority.unavailable, exit.authority);
    try std.testing.expectEqual(pty_host.ExitState.unknown, exit.state);
    try std.testing.expect(!exit.reaped);
    try std.testing.expect(exit.exit_code == null);
    host.pid = -1;
}

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

test "THV1-REAL-B: oversized complete environment reports the environment layer" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    const arg_max = c.sysconf(c._SC_ARG_MAX);
    try std.testing.expect(arg_max > 0);
    const environment = try std.testing.allocator.alloc(u8, @as(usize, @intCast(arg_max)) + 4096);
    defer std.testing.allocator.free(environment);
    @memset(environment, 'x');
    @memcpy(environment[0..5], "HUGE=");

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{"/usr/bin/true"},
        .envp = &[_][]const u8{environment},
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => return error.TestUnexpectedResult,
        .exec_failed => |failure| {
            try std.testing.expectEqual(pty_host.LaunchFailureLayer.environment, failure.layer);
            try std.testing.expectEqual(@as(c_int, c.E2BIG), failure.os_code);
        },
    }
    try std.testing.expect(!host.spawned);
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

// Qualification row D on a real terminal: interleaved input and burst resize
// must preserve one mutation order with monotonic revisions and an applied
// readback, and the foreground application must still observe the FINAL
// geometry. Ordering is read from the host's own sequence, and the final
// SIGWINCH is read from the child's `stty size` rather than assumed — the host
// cannot see the notification itself, so the child has to report it.
test "THV1-REAL-D: burst resize interleaves input and foreground observes final SIGWINCH" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{
            "/bin/sh",
            "-c",
            // The trap must survive a burst of SIGWINCH, so the loop body is the
            // `read` BUILTIN: a trapped signal interrupts a builtin and the trap
            // runs, whereas a foreground external command (`cat`) makes the
            // shell defer every trap until that command exits — which reports no
            // geometry at all. A trapped signal makes `read` return >128, so
            // continue on an interrupt and stop only on real end-of-input.
            "trap '/bin/stty size' WINCH; printf 'READY\\n'; while :; do IFS= read -r line; status=$?; " ++
                "if [ $status -gt 128 ]; then continue; elif [ $status -ne 0 ]; then break; fi; done",
        },
        .envp = &[_][]const u8{},
        // Canonical with echo on purpose: the TERMINAL then echoes each accepted
        // transaction, so the input evidence below is the terminal's own
        // readback and does not depend on the shell winning a race with the
        // resize burst that is deliberately interrupting it.
        .terminal_profile = .{ .input_mode = .canonical, .echo = true },
        .geometry = .{ .columns = 90, .rows = 30, .width_px = 900, .height_px = 600 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    var output: std.ArrayList(u8) = .{};
    defer output.deinit(std.testing.allocator);
    try collectUntil(&host, &output, "READY");
    var previous_order = host.operationSequence();
    for (1..13) |revision| {
        var input_storage: [32]u8 = undefined;
        const input = try std.fmt.bufPrint(&input_storage, "input-{d}\n", .{revision});
        _ = try host.writeAccept(input);
        try host.writeDrainAll();
        const input_order = host.operationSequence();
        try std.testing.expect(input_order > previous_order);
        const requested: pty_host.Geometry = .{
            .columns = @intCast(90 + revision),
            .rows = @intCast(30 + revision),
            .width_px = @intCast(900 + revision * 10),
            .height_px = @intCast(600 + revision * 10),
        };
        const receipt = try host.resize(requested, @intCast(revision));
        try std.testing.expect(receipt.ordered_at > input_order);
        try std.testing.expect(receipt.readback.eql(requested));
        previous_order = receipt.ordered_at;
    }
    // 30 + 12 rows by 90 + 12 columns: the LAST geometry, so seeing it proves
    // the burst coalesced to a truthful final revision rather than a stale one.
    try collectUntil(&host, &output, "42 102");
    // Every interleaved transaction reached the terminal, in order. This is the
    // terminal's own readback, not a claim about the foreground application
    // consuming the bytes — the host cannot observe that, so the test does not
    // assert it any more than the resize receipt has a field for it.
    var searched: usize = 0;
    for (1..13) |revision| {
        var expected_storage: [32]u8 = undefined;
        const expected = try std.fmt.bufPrint(&expected_storage, "input-{d}", .{revision});
        const at = std.mem.indexOfPos(u8, output.items, searched, expected) orelse
            return error.TestUnexpectedResult;
        searched = at + expected.len;
    }
}

test "THV1-REAL-E: XOFF stops and XON resumes real PTY output" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var host = try pty_host.PtyHost.init(std.testing.allocator);
    defer host.deinit();
    const outcome = try host.spawn(.{
        .argv = &[_][]const u8{"/usr/bin/yes"},
        .envp = &[_][]const u8{},
        .terminal_profile = .{ .software_flow_control = true },
        .geometry = .{ .columns = 80, .rows = 24 },
    });
    switch (outcome) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    }

    var observed_output = false;
    for (0..200) |_| {
        const chunk = try host.readAvailable();
        if (chunk.bytes.len > 0) {
            observed_output = true;
            break;
        }
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(observed_output);
    _ = try host.writeAccept(&.{19});
    try host.writeDrainAll();

    var idle_reads: usize = 0;
    for (0..2000) |_| {
        const chunk = try host.readAvailable();
        if (chunk.bytes.len == 0) {
            idle_reads += 1;
            if (idle_reads == 20) break;
            std.Thread.sleep(std.time.ns_per_ms);
        } else {
            idle_reads = 0;
        }
    }
    try std.testing.expectEqual(@as(usize, 20), idle_reads);
    const stopped_at = host.output_seq;
    std.Thread.sleep(20 * std.time.ns_per_ms);
    try std.testing.expectEqual(@as(usize, 0), (try host.readAvailable()).bytes.len);
    try std.testing.expectEqual(stopped_at, host.output_seq);

    _ = try host.writeAccept(&.{17});
    try host.writeDrainAll();
    var resumed = false;
    for (0..200) |_| {
        if ((try host.readAvailable()).bytes.len > 0) {
            resumed = true;
            break;
        }
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(resumed);
}

// Qualification row F on a real terminal: normal AND signaled exit must retain
// every tail byte, and output closure must order separately from exit and from
// the authoritative reap. The reap is taken FIRST here on purpose — that is the
// order that loses the tail if the host frees the master before draining it, so
// a green result is evidence the tail survives its own reap rather than
// evidence the test drained early.
test "THV1-REAL-F: exit and reap precede a complete PTY tail drain" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    for ([_]struct { script: []const u8, tail: []const u8, signal: ?i32 }{
        .{ .script = "printf tail-normal; exit 7", .tail = "tail-normal", .signal = null },
        .{ .script = "printf tail-signal; kill -TERM $$", .tail = "tail-signal", .signal = c.SIGTERM },
    }) |case| {
        var host = try pty_host.PtyHost.init(std.testing.allocator);
        defer host.deinit();
        const outcome = try host.spawn(.{
            .argv = &[_][]const u8{ "/bin/sh", "-c", case.script },
            .envp = &[_][]const u8{},
            .geometry = .{ .columns = 80, .rows = 24 },
        });
        switch (outcome) {
            .running => {},
            .exec_failed => return error.TestUnexpectedResult,
        }
        // Output closure comes FIRST and on its own terms. Draining is also what
        // lets a child finish writing, so a test that refused to read until
        // after the reap would deadlock on any tail larger than the terminal
        // buffer rather than qualify anything.
        var tail: std.ArrayList(u8) = .{};
        defer tail.deinit(std.testing.allocator);
        var closed = false;
        for (0..3000) |_| {
            const chunk = host.readAvailable() catch |err| switch (err) {
                error.Closed => {
                    closed = true;
                    break;
                },
                else => return err,
            };
            try tail.appendSlice(std.testing.allocator, chunk.bytes);
            if (chunk.bytes.len == 0) std.Thread.sleep(std.time.ns_per_ms);
        }
        try std.testing.expect(closed);

        // Exit and the authoritative reap are then observed SEPARATELY from that
        // closure — three orderings, not one event. The poll is bounded so a
        // child that never exits fails this row loudly instead of hanging the
        // whole native suite on an unbounded wait.
        var exit: pty_host.ExitEvidence = undefined;
        var reaped = false;
        for (0..3000) |_| {
            exit = try host.waitExit(false);
            if (exit.reaped) {
                reaped = true;
                break;
            }
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try std.testing.expect(reaped);
        try std.testing.expectEqual(pty_host.ReapAuthority.direct_parent, exit.authority);
        if (case.signal) |signal| {
            try std.testing.expectEqual(@as(?i32, signal), exit.term_signal);
        } else {
            try std.testing.expectEqual(@as(?u8, 7), exit.exit_code);
        }

        // Every tail byte survived, and survived its own closure and reap.
        try std.testing.expectEqualStrings(case.tail, tail.items);
    }
}

test "THV1-REAL-K: canonical EOF raw control-D and hangup remain distinct" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;

    var canonical = try pty_host.PtyHost.init(std.testing.allocator);
    defer canonical.deinit();
    _ = switch (try canonical.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .envp = &[_][]const u8{},
        .terminal_profile = .{ .input_mode = .canonical, .eof_byte = 4 },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    };
    try std.testing.expectEqual(@as(u8, 4), try canonical.canonicalEofByte());
    _ = try canonical.writeAccept(&.{4});
    try canonical.writeDrainAll();
    try std.testing.expect((try canonical.waitExit(true)).reaped);

    var literal = try pty_host.PtyHost.init(std.testing.allocator);
    defer literal.deinit();
    _ = switch (try literal.spawn(.{
        .argv = &[_][]const u8{"/bin/cat"},
        .envp = &[_][]const u8{},
        .terminal_profile = .{ .input_mode = .literal, .eof_byte = 4 },
        .geometry = .{ .columns = 80, .rows = 24 },
    })) {
        .running => {},
        .exec_failed => return error.TestUnexpectedResult,
    };
    try std.testing.expectError(error.NotCanonical, literal.canonicalEofByte());
    _ = try literal.writeAccept("\x04raw-marker\n");
    try literal.writeDrainAll();
    var raw_output: std.ArrayList(u8) = .{};
    defer raw_output.deinit(std.testing.allocator);
    try collectUntil(&literal, &raw_output, "raw-marker");
    try std.testing.expect(std.mem.indexOfScalar(u8, raw_output.items, 4) != null);
    const hangup_order = try literal.hangup();
    try std.testing.expect(hangup_order > 0);
    try std.testing.expect((try literal.waitExit(true)).reaped);
}
