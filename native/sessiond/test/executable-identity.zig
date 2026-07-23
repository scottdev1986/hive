const std = @import("std");
const executable_identity = @import("executable_identity");

test "symlink aliases identify the same executable" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const target = try temporary.dir.createFile("provider", .{});
    target.close();
    try temporary.dir.symLink("provider", "provider-link", .{});

    var target_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const target_path = try temporary.dir.realpath("provider", &target_buffer);
    var directory_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const directory_path = try temporary.dir.realpath(".", &directory_buffer);
    const link_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ directory_path, "provider-link" },
    );
    defer std.testing.allocator.free(link_path);

    try std.testing.expect(executable_identity.sameFile(
        std.testing.allocator,
        target_path,
        link_path,
    ));
    try std.testing.expect(!executable_identity.sameFile(
        std.testing.allocator,
        target_path,
        "/bin/sh",
    ));
}
