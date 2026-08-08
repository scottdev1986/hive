const std = @import("std");
const builtin = @import("builtin");
const session_host = @import("session_host");
const session_types = @import("session_types");

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    const allocator = if (builtin.mode == .Debug)
        debug_allocator.allocator()
    else
        std.heap.c_allocator;

    var args = std.process.args();
    _ = args.next();
    const role = args.next() orelse return error.MissingRole;
    if (args.next() != null) return error.UnexpectedArgument;
    // The engine build id belongs to the linked VT engine, not to this executable, so a launcher cannot derive it by hashing anything — it has to ask. A host refuses a create whose locator names a different engine, so the launcher needs this one query. It reads no state and answers before HIVE_HOME is required.
    if (std.mem.eql(u8, role, "engine-build-id")) {
        const hex = try session_types.engineBuildIdHex();
        var out: [65]u8 = undefined;
        @memcpy(out[0..64], &hex);
        out[64] = '\n';
        try std.fs.File.stdout().writeAll(&out);
        return;
    }
    // A host writes under exactly two roots and nowhere else, so these two paths are the only ones it is told. They are split by lifetime: the socket root holds nothing but bound AF_UNIX rendezvous nodes and must stay short, because macOS caps `sun_path` at 103 bytes; the state root holds the durable record, journal, checkpoints and capabilities, and is free to sit under a home long enough to be worth keeping. The launcher resolves both and passes them here rather than letting the host derive either, so the two can never disagree about where anything is.
    const socket_root = std.process.getEnvVarOwned(allocator, "HIVE_SESSIOND_ROOT") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.MissingSessiondRoot,
        else => return err,
    };
    defer allocator.free(socket_root);
    const state_root = std.process.getEnvVarOwned(allocator, "HIVE_SESSIOND_STATE_ROOT") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.MissingSessiondStateRoot,
        else => return err,
    };
    defer allocator.free(state_root);
    // There is no `serve` role. Hive launches each terminal host itself and speaks to it on the host's own sockets, so no broker process stands between them: the broker is not in the terminal data path, and one process relaying every launch and every inspect caps concurrent width.
    if (std.mem.eql(u8, role, "host")) {
        session_host.runHostRole(allocator, .{
            .socket = socket_root,
            .state = state_root,
        }) catch |err| {
            // This stderr is inherited by the launcher. Preserve the host's actual boot failure instead of only surfacing a rejected launch.
            std.log.err("sessiond host startup failed: {s}", .{@errorName(err)});
            return err;
        };
    } else {
        return error.UnsupportedRole;
    }
}
