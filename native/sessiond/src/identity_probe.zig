const std = @import("std");
const daemon_identity = @import("daemon_identity");

pub fn main() !void {
    var args = std.process.args();
    _ = args.next();
    const pid_text = args.next() orelse return error.MissingPid;
    if (args.next() != null) return error.UnexpectedArgument;

    const process = try daemon_identity.inspectProcess(try std.fmt.parseInt(i32, pid_text, 10));
    var token_storage: [64]u8 = undefined;
    const token = try daemon_identity.formatStartToken(process.start_token, &token_storage);
    const stdout = std.fs.File.stdout();
    try stdout.writeAll(token);
    try stdout.writeAll("\n");
    try stdout.writeAll(process.executablePath());
    try stdout.writeAll("\n");
}
