const std = @import("std");

pub const FinalState = enum { terminated, survivors, unknown };

pub const FinalSurvivor = struct {
    pid: i32,
    startToken: []const u8,
    reason: []const u8,
};

pub const FinalError = struct {
    phase: []const u8,
    code: []const u8,
};

pub const FinalEvidence = struct {
    schemaVersion: u8 = 1,
    state: []const u8,
    exitCode: ?u8,
    exitSignal: ?i32,
    waitObserved: bool,
    outputSeq: []const u8,
    checkpointSeq: []const u8,
    survivors: []const FinalSurvivor,
    errors: []const FinalError,
    failureCode: ?[]const u8,
};

pub fn writeExclusive(
    allocator: std.mem.Allocator,
    directory: std.fs.Dir,
    evidence: FinalEvidence,
) !void {
    const json = try std.json.Stringify.valueAlloc(allocator, evidence, .{});
    defer allocator.free(json);
    var file = try directory.createFile("final.json", .{
        .mode = 0o600,
        .exclusive = true,
    });
    errdefer directory.deleteFile("final.json") catch {};
    defer file.close();
    try file.chmod(0o600);
    try file.writeAll(json);
    try file.sync();
    try std.posix.fsync(directory.fd);
}
