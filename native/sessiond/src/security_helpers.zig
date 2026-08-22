const std = @import("std");

const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/time.h");
    @cInclude("unistd.h");
});

/// How a private directory is validated after open.
pub const DirectoryPosture = enum {
    /// Assert uid ownership and directory type; optional mode must already match.
    assert,
    /// Assert ownership, force mode 0700, then re-fstat so a substituted node cannot keep a looser mode.
    harden,
};

/// Validate that `directory` is owned by the current uid and is a directory.
/// `mode`, when set, must match the low 9 permission bits under `.assert`.
/// Under `.harden`, mode is forced to 0700 after the ownership check and re-verified.
pub fn requireOwnedDirectory(directory: std.fs.Dir, mode: ?u16, posture: DirectoryPosture) !void {
    const stat = try std.posix.fstat(directory.fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR)
        return error.DirectorySubstitution;
    switch (posture) {
        .assert => {
            if (mode) |expected| if (stat.mode & 0o777 != expected)
                return error.DirectorySubstitution;
        },
        .harden => {
            // harden ignores a prior mode argument: the durable private mode is always 0700.
            try directory.chmod(0o700);
            const secured = try std.posix.fstat(directory.fd);
            if (secured.mode & 0o777 != 0o700) return error.DirectorySubstitution;
        },
    }
}

/// Assert-only root directory ownership (uid + IFDIR). Used for caller-supplied roots that
/// must not be rewritten to 0700.
pub fn requireOwnedRoot(directory: std.fs.Dir) !void {
    try requireOwnedDirectory(directory, null, .assert);
}

/// Owner-uid + regular-file + mode 0600 check on an already-open fd.
/// Returns `substitution_error` when the node fails the check so call sites keep their
/// domain error names (SecretSubstitution, LockSubstitution, ControlSubstitution, ...).
pub fn requireOwnedPrivateFile(fd: std.posix.fd_t, comptime substitution_error: anyerror) !void {
    const stat = try std.posix.fstat(fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFREG or
        stat.mode & 0o777 != 0o600)
        return substitution_error;
}

/// Install SO_RCVTIMEO/SO_SNDTIMEO on a connected or listening socket.
/// Shared by host control paths and neutral connection paths (formerly setControlTimeoutMs /
/// setConnectionTimeoutMs with identical bodies and diverging error names).
pub fn setSocketTimeoutMs(fd: std.posix.fd_t, timeout_ms: u64) !void {
    if (timeout_ms == 0) return error.InvalidSocketTimeout;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(timeout_ms / std.time.ms_per_s),
        .tv_usec = @intCast(
            (timeout_ms % std.time.ms_per_s) * std.time.us_per_ms,
        ),
    };
    if (c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0 or
        c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &timeout, @sizeOf(c.struct_timeval)) != 0)
        return error.SocketTimeoutUnavailable;
}

/// Set O_NONBLOCK on an fd. Returns a call-site error on fcntl failure.
pub fn setNonBlocking(fd: std.posix.fd_t, comptime failure: anyerror) !void {
    const flags = c.fcntl(fd, c.F_GETFL);
    if (flags < 0 or c.fcntl(fd, c.F_SETFL, flags | c.O_NONBLOCK) < 0)
        return failure;
}

/// Clear O_NONBLOCK on an fd. Returns a call-site error on fcntl failure.
pub fn setBlocking(fd: std.posix.fd_t, comptime failure: anyerror) !void {
    const flags = c.fcntl(fd, c.F_GETFL);
    if (flags < 0 or c.fcntl(fd, c.F_SETFL, flags & ~@as(c_int, c.O_NONBLOCK)) < 0)
        return failure;
}

/// The two roots a session host writes under. They are separate because their lifetimes and their
/// length budgets are separate: `socket` holds nothing but bound AF_UNIX rendezvous nodes, and every
/// byte of it is spent against the 103-byte `sun_path` ceiling, while `state` holds the durable
/// per-session record, journal, checkpoints and capabilities under no length limit at all. One root
/// cannot serve both — short enough to bind is too short to keep. The launcher resolves both and
/// passes them in, so the launcher and the host can never disagree about where either tree is.
pub const Roots = struct { socket: []const u8, state: []const u8 };

/// Every socket bound under a socket root is named `<8 hex>.s`, and nothing else is ever written
/// there. The eight hex digits are the leading bytes of the same identity digest that names the
/// session's state directory, so a peer derives the name from the session it already holds instead
/// of being told it. Both socket kinds — a session host and its neutral endpoint — take this one
/// spelling, which is what lets a single preflight bound both trees.
pub const socket_name_length = "0123abcd.s".len;

pub fn socketName(digest: [32]u8) [socket_name_length]u8 {
    var result: [socket_name_length]u8 = undefined;
    const hex = std.fmt.bytesToHex(digest[0..4].*, .lower);
    @memcpy(result[0..hex.len], &hex);
    @memcpy(result[hex.len..], ".s");
    return result;
}

/// Refuses a socket root that cannot safely hold a bound socket, before anything is created under
/// it. Two conditions, both fail-closed:
///
/// The path must fit. Every name under this root is exactly `socket_name_length` bytes, so the
/// longest bindable path is measured here rather than estimated. A bind past `sun_path` surfaces as
/// a bare NameTooLong deep inside a host's boot, naming nothing.
///
/// The root must be private enough to bind in. A socket named directly under this root has no
/// per-session directory left to stand behind, so this root is the node that keeps another writer
/// from unlinking a live socket and leaving its own in place. Ownership plus no group or other write
/// bit is the whole requirement; the socket's own 0600 mode refuses connections from anyone else.
/// What was found at a socket name that already existed.
pub const SocketReclaim = enum { vacant, reclaimed };

/// Decides whether a socket name that is already taken may be bound again, for the only names where
/// that question can arise: the derived ones, which the same session reproduces on recovery or
/// adoption. A socket root under the home is never swept — `/tmp` used to lose these at reboot and
/// nothing does now — so a host killed hard enough to skip its own cleanup leaves an inode that
/// would otherwise block its session from ever being created again.
///
/// The probe is CONNECT, not stat. An existing inode says a name is taken; it cannot say whether
/// anyone is behind it, and only the second fact decides anything. A refused connection means no
/// listener — the inode is a corpse and is unlinked. A connection that SUCCEEDS means a live owner
/// holds the address, and the caller is refused: unlinking there would take a working session's
/// address away from it and hand it to a second host, turning a loud failure into two processes
/// that each believe they own one session. That is why a blind unlink before bind is not an option
/// no matter how much simpler it reads.
///
/// The probe reaches a live host to learn that it IS live, so learning must not disturb it. Both
/// ends of that were measured, not assumed: a peer that connects and sends nothing is served as a
/// no-op, and a per-connection setup failure drops that connection instead of the host.
///
/// Nothing is unlinked that is not provably this user's own private socket, checked before the
/// probe rather than after: a regular file, another user's node, or a loosened mode is a
/// substitution, and the answer to a substitution is to refuse, never to delete.
pub fn reclaimDeadSocket(
    directory: std.fs.Dir,
    name: []const u8,
    path: []const u8,
) !SocketReclaim {
    const stat = std.posix.fstatat(directory.fd, name, std.posix.AT.SYMLINK_NOFOLLOW) catch |err| switch (err) {
        error.FileNotFound => return .vacant,
        else => return error.SocketSubstitution,
    };
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFSOCK or
        stat.mode & 0o777 != 0o600)
        return error.SocketSubstitution;
    if (std.net.connectUnixSocket(path)) |stream| {
        stream.close();
        return error.SocketAddressHeldByLiveHost;
    } else |err| switch (err) {
        error.ConnectionRefused => {},
        else => return err,
    }
    directory.deleteFile(name) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
    return .reclaimed;
}

pub fn requireBindableSocketRoot(
    allocator: std.mem.Allocator,
    directory: std.fs.Dir,
    canonical_root: []const u8,
) !void {
    const stat = try std.posix.fstat(directory.fd);
    if (stat.uid != std.posix.getuid() or
        stat.mode & std.posix.S.IFMT != std.posix.S.IFDIR or
        stat.mode & 0o022 != 0)
        return error.DirectorySubstitution;
    const longest_name: [socket_name_length]u8 = @splat('x');
    const socket_path = try std.fs.path.join(allocator, &.{ canonical_root, &longest_name });
    defer allocator.free(socket_path);
    _ = std.net.Address.initUnix(socket_path) catch |err| switch (err) {
        error.NameTooLong => return error.SocketPathTooLong,
        else => return err,
    };
}
