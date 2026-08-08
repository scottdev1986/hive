const std = @import("std");
const daemon_identity = @import("daemon_identity");

extern fn hive_ghostty_engine_build_id_v1() [*:0]const u8;

pub fn engineBuildIdHex() ![64]u8 {
    const value = std.mem.span(hive_ghostty_engine_build_id_v1());
    if (value.len != 64) return error.InvalidEngineBuildId;
    var digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&digest, value);
    return std.fmt.bytesToHex(digest, .lower);
}

pub const Locator = struct {
    instance_id: []const u8,
    session_id: []const u8,
    generation: u64,
    subject: union(enum) {
        root,
        agent: []const u8,
    } = .root,
    host_kind: enum { sessiond } = .sessiond,
    engine_build_id: ?[]const u8 = null,

    pub fn eql(self: Locator, other: Locator) bool {
        return self.generation == other.generation and
            std.mem.eql(u8, self.instance_id, other.instance_id) and
            std.mem.eql(u8, self.session_id, other.session_id) and
            std.meta.activeTag(self.subject) == std.meta.activeTag(other.subject) and
            switch (self.subject) {
                .root => true,
                .agent => |agent_id| std.mem.eql(u8, agent_id, other.subject.agent),
            } and
            self.host_kind == other.host_kind and
            daemon_identity.equalOptionalString(self.engine_build_id, other.engine_build_id);
    }
};

pub const ProcessRoot = struct {
    pid: i32,
    start_token: []const u8,
    process_group_id: i32,
};

pub const Geometry = struct {
    columns: u16,
    rows: u16,
    width_px: u32,
    height_px: u32,
    cell_width_px: f64,
    cell_height_px: f64,
};

pub const Visibility = struct {
    state: enum { attaching, visible, reconnecting, expired },
    workspace_session_id: []const u8,
    open_terminal_revision: u64,
    expires_mono_ns: u64,
};

pub const HostRecord = struct {
    locator: Locator,
    host_pid: i32,
    host_start_token: []const u8,
    process_root: ProcessRoot,
    expected_executable: []const u8,
    executable_build_hash: []const u8,
    engine_build_id: []const u8,
    protocol_major: u8,
    protocol_minor: u8,
    geometry: Geometry,
    state: enum { starting, live, exited, unknown },
    visibility: Visibility,
    output_seq: u64,
    checkpoint_seq: u64,
};

test "locator equality covers every identity field" {
    const base: Locator = .{
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

    const same_agent: Locator = .{
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
    changed.engine_build_id = null;
    try std.testing.expect(!base.eql(changed));
}
