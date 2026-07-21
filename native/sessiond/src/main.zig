const std = @import("std");
const builtin = @import("builtin");
const broker = @import("broker");
const session_host = @import("session_host");

pub fn main() !void {
    // Allocator by optimize mode: DebugAllocator (leak detection on deinit) in
    // Debug only. Release builds of this long-running daemon use c_allocator —
    // DebugAllocator adds per-allocation metadata, slowdown, and leak
    // diagnostics carrying stack addresses to stderr. libc is linked for this
    // module, matching the c_allocator use throughout session_host.zig.
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
    const hive_home = std.process.getEnvVarOwned(allocator, "HIVE_HOME") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.MissingHiveHome,
        else => return err,
    };
    defer allocator.free(hive_home);
    if (std.mem.eql(u8, role, "serve")) {
        var launcher = try session_host.ProductionHostLauncher.init(allocator, hive_home);
        defer launcher.deinit();
        try broker.serve(allocator, hive_home, launcher.launcher());
    } else if (std.mem.eql(u8, role, "host")) {
        try session_host.runHostRole(allocator, hive_home);
    } else {
        return error.UnsupportedRole;
    }
}
