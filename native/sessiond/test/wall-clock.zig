const std = @import("std");
const wall_clock = @import("wall_clock");

test "RFC3339 millisecond timestamps parse at calendar boundaries" {
    try std.testing.expectEqual(@as(u64, 0), try wall_clock.parseMillis("1970-01-01T00:00:00.000Z"));
    try std.testing.expectEqual(
        @as(u64, 951_782_400_001),
        try wall_clock.parseMillis("2000-02-29T00:00:00.001Z"),
    );
    try std.testing.expectEqual(
        @as(u64, 4_102_444_799_999),
        try wall_clock.parseMillis("2099-12-31T23:59:59.999Z"),
    );
}

test "RFC3339 millisecond timestamps reject invalid dates and shapes" {
    for ([_][]const u8{
        "1969-12-31T23:59:59.999Z",
        "2001-02-29T00:00:00.000Z",
        "2000-13-01T00:00:00.000Z",
        "2000-01-01 00:00:00.000Z",
        "2000-01-01T00:00:00Z",
    }) |value| {
        try std.testing.expectError(error.InvalidTimestamp, wall_clock.parseMillis(value));
    }
}

test "deadline produces the canonical shape and a parseable instant" {
    const before = std.time.milliTimestamp();
    try std.testing.expect(before >= 0);
    var storage: [24]u8 = undefined;
    const value = try wall_clock.deadline(&storage, 1_000);
    const after = std.time.milliTimestamp();
    try std.testing.expect(after >= 0);
    try std.testing.expectEqual(@as(usize, 24), value.len);
    const parsed = try wall_clock.parseMillis(value);
    try std.testing.expect(parsed >= @as(u64, @intCast(before)) + 1_000);
    try std.testing.expect(parsed <= @as(u64, @intCast(after)) + 1_000);
}
