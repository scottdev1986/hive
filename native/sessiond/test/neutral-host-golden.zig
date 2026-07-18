const std = @import("std");
const neutral_host = @import("neutral_host");

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    try neutral_host.proveLiveLifecycle(debug_allocator.allocator());
}
