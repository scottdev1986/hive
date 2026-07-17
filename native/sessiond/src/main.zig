const std = @import("std");
const broker = @import("broker");
const session_host = @import("session_host");

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();

    var args = std.process.args();
    _ = args.next();
    const role = args.next() orelse return error.MissingRole;
    if (args.next() != null) return error.UnexpectedArgument;
    const hive_home = std.process.getEnvVarOwned(allocator, "HIVE_HOME") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.MissingHiveHome,
        else => return err,
    };
    defer allocator.free(hive_home);
    if (std.mem.eql(u8, role, "serve")) {
        try broker.serve(allocator, hive_home);
    } else if (std.mem.eql(u8, role, "host")) {
        try session_host.runHostRole(allocator, hive_home);
    } else {
        return error.UnsupportedRole;
    }
}
