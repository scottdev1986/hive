const std = @import("std");
const builtin = @import("builtin");
const generated = @import("session_protocol_generated");

const c = @cImport({
    @cInclude("sys/socket.h");
    @cInclude("sys/time.h");
});

pub fn setTransportReadTimeout(socket: std.posix.fd_t) !void {
    const millis = generated.limits.connection_ping_interval_ms;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(millis / std.time.ms_per_s),
        .tv_usec = @intCast((millis % std.time.ms_per_s) * std.time.us_per_ms),
    };
    if (c.setsockopt(socket, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0)
        return error.SocketTimeoutFailed;
}

/// SO_RCVTIMEO bounds only a single read() syscall, so a peer dribbling one
/// byte per sub-timeout interval would pin the serialized accept loop
/// indefinitely (pre-auth, before verifyDaemonPeer) while never tripping any
/// per-syscall timeout. Every frame read therefore runs under one absolute
/// monotonic deadline — a total assembly budget shared across all read()
/// syscalls of that frame — so dribbling cannot exceed it. The budget is the
/// standard control-RPC bound; a loopback frame assembles in microseconds, so
/// only a stalling peer ever approaches it. The test-build budget keeps the
/// dribble regression test fast without weakening production.
pub const frame_read_budget_ns: u64 = if (builtin.is_test)
    500 * std.time.ns_per_ms
else
    generated.limits.control_rpc_timeout_ms * std.time.ns_per_ms;

/// readNoEof-compatible reader that enforces frame_read_budget_ns as one
/// absolute monotonic deadline across the whole frame assembly. Each read()
/// is preceded by a poll bounded by the REMAINING budget, so a dribbling peer
/// is cut at the deadline instead of at a per-syscall timeout it keeps
/// resetting; expiry, EOF, and transport errors all fail closed identically.
pub const FrameDeadlineReader = struct {
    file: std.fs.File,
    timer: *std.time.Timer,
    deadline_ns: u64,

    pub fn init(handle: std.posix.fd_t, timer: *std.time.Timer) ?FrameDeadlineReader {
        const deadline_ns = std.math.add(u64, timer.read(), frame_read_budget_ns) catch
            return null;
        return .{
            .file = .{ .handle = handle },
            .timer = timer,
            .deadline_ns = deadline_ns,
        };
    }

    pub fn readNoEof(self: *FrameDeadlineReader, buffer: []u8) !void {
        var filled: usize = 0;
        while (filled < buffer.len) {
            const now_ns = self.timer.read();
            if (now_ns >= self.deadline_ns) return error.ConnectionDeadlineExceeded;
            const remaining_ms = std.math.divCeil(
                u64,
                self.deadline_ns - now_ns,
                std.time.ns_per_ms,
            ) catch return error.ConnectionDeadlineExceeded;
            var poll_fds = [_]std.posix.pollfd{.{
                .fd = self.file.handle,
                .events = std.posix.POLL.IN,
                .revents = 0,
            }};
            _ = try std.posix.poll(&poll_fds, std.math.cast(i32, remaining_ms) orelse
                std.math.maxInt(i32));
            if (poll_fds[0].revents & std.posix.POLL.IN == 0) {
                // Pure timeout means the budget expired; HUP/ERR without
                // readable bytes is EOF-equivalent. Both fail closed.
                if (self.timer.read() >= self.deadline_ns) return error.ConnectionDeadlineExceeded;
                return error.EndOfStream;
            }
            const count = try self.file.read(buffer[filled..]);
            if (count == 0) return error.EndOfStream;
            filled += count;
        }
    }
};
