const std = @import("std");
const process_inspector = @import("process_inspector");

test "start token parsing and formatting round trip" {
    const token = try process_inspector.StartToken.parse("42:9001");
    try std.testing.expectEqual(@as(u64, 42), token.seconds);
    try std.testing.expectEqual(@as(u64, 9001), token.microseconds);

    var storage: [32]u8 = undefined;
    try std.testing.expectEqualStrings("42:9001", try token.format(&storage));
}

test "start token parsing rejects ambiguous separators" {
    for ([_][]const u8{ "", "1", ":1", "1:", "1:2:3" }) |value| {
        try std.testing.expectError(error.InvalidStartToken, process_inspector.StartToken.parse(value));
    }
}
