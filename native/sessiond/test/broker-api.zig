const std = @import("std");
const broker = @import("broker");

test "locator equality covers every identity field" {
    const base: broker.Locator = .{
        .instance_id = "instance",
        .session_id = "session",
        .generation = 7,
        .engine_build_id = "engine",
    };
    try std.testing.expect(base.eql(base));

    var changed = base;
    changed.instance_id = "other";
    try std.testing.expect(!base.eql(changed));

    changed = base;
    changed.session_id = "other";
    try std.testing.expect(!base.eql(changed));

    changed = base;
    changed.generation += 1;
    try std.testing.expect(!base.eql(changed));

    changed = base;
    changed.subject = .{ .agent = "agent" };
    try std.testing.expect(!base.eql(changed));

    const same_agent: broker.Locator = .{
        .instance_id = "instance",
        .session_id = "session",
        .generation = 7,
        .subject = .{ .agent = "agent" },
        .engine_build_id = "engine",
    };
    changed = same_agent;
    changed.subject = .{ .agent = "other" };
    try std.testing.expect(!same_agent.eql(changed));

    changed = base;
    changed.host_kind = .tmux;
    try std.testing.expect(!base.eql(changed));

    changed = base;
    changed.engine_build_id = null;
    try std.testing.expect(!base.eql(changed));
}
