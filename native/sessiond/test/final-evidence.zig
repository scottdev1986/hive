const std = @import("std");
const final_evidence = @import("final_evidence");

test "first final record is immutable" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const evidence: final_evidence.FinalEvidence = .{
        .state = "terminated",
        .exitCode = 0,
        .exitSignal = null,
        .waitObserved = true,
        .outputSeq = "12",
        .checkpointSeq = "8",
        .survivors = &.{},
        .errors = &.{},
        .failureCode = null,
    };
    try final_evidence.writeExclusive(std.testing.allocator, tmp.dir, evidence);
    try std.testing.expectError(
        error.PathAlreadyExists,
        final_evidence.writeExclusive(std.testing.allocator, tmp.dir, evidence),
    );
    const file = try tmp.dir.openFile("final.json", .{ .mode = .read_only });
    defer file.close();
    const contents = try file.readToEndAlloc(std.testing.allocator, 4096);
    defer std.testing.allocator.free(contents);
    try std.testing.expect(std.mem.indexOf(u8, contents, "\"waitObserved\":true") != null);
}
