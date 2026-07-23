const std = @import("std");

pub fn sameFile(
    allocator: std.mem.Allocator,
    expected: []const u8,
    observed: []const u8,
) bool {
    if (std.mem.eql(u8, expected, observed)) return true;
    const resolved_expected = std.fs.cwd().realpathAlloc(allocator, expected) catch
        return false;
    defer allocator.free(resolved_expected);
    const resolved_observed = std.fs.cwd().realpathAlloc(allocator, observed) catch
        return false;
    defer allocator.free(resolved_observed);
    return std.mem.eql(u8, resolved_expected, resolved_observed);
}
