const std = @import("std");
const c = @cImport({
    @cInclude("hive_ghostty_bridge.h");
});

fn assertExactType(comptime name: []const u8, comptime actual: type, comptime expected: type) void {
    if (actual != expected) @compileError(name ++ " signature or calling convention drifted");
}

comptime {
    if (@sizeOf(c.hive_ghostty_event_e) != @sizeOf(c_int)) @compileError("event enum size drifted");
    if (@alignOf(c.hive_ghostty_event_e) != @alignOf(c_int)) @compileError("event enum alignment drifted");
    if (@offsetOf(c.hive_ghostty_event_s, "type") != 0) @compileError("event type offset drifted");
    if (@offsetOf(c.hive_ghostty_event_s, "bytes") != @sizeOf(?*anyopaque)) @compileError("event bytes offset drifted");
    if (@offsetOf(c.hive_ghostty_event_s, "length") != 2 * @sizeOf(?*anyopaque)) @compileError("event length offset drifted");
    if (@sizeOf(c.hive_ghostty_event_s) != 3 * @sizeOf(?*anyopaque)) @compileError("event size drifted");
    if (@alignOf(c.hive_ghostty_event_s) != @alignOf(?*anyopaque)) @compileError("event alignment drifted");
    if (@sizeOf(c.hive_ghostty_terminal_reply_policy_e) != @sizeOf(u32)) @compileError("reply policy size drifted");
    if (@alignOf(c.hive_ghostty_terminal_reply_policy_e) != @alignOf(u32)) @compileError("reply policy alignment drifted");

    assertExactType(
        "hive_ghostty_write_fn",
        c.hive_ghostty_write_fn,
        ?*const fn (?*anyopaque, [*c]const u8, usize) callconv(.c) void,
    );
    assertExactType(
        "hive_ghostty_alloc_fn",
        c.hive_ghostty_alloc_fn,
        ?*const fn (?*anyopaque, usize, usize) callconv(.c) ?*anyopaque,
    );
    assertExactType(
        "hive_ghostty_event_fn",
        c.hive_ghostty_event_fn,
        ?*const fn (?*anyopaque, [*c]const c.hive_ghostty_event_s) callconv(.c) void,
    );
    assertExactType(
        "hive_ghostty_engine_build_id_v1",
        @TypeOf(c.hive_ghostty_engine_build_id_v1),
        fn () callconv(.c) [*c]const u8,
    );
    assertExactType(
        "hive_ghostty_surface_new_manual_v1",
        @TypeOf(c.hive_ghostty_surface_new_manual_v1),
        fn (
            c.ghostty_app_t,
            [*c]const c.ghostty_surface_config_s,
            c.hive_ghostty_terminal_reply_policy_e,
            c.hive_ghostty_write_fn,
            ?*anyopaque,
            c.hive_ghostty_event_fn,
            ?*anyopaque,
        ) callconv(.c) c.ghostty_surface_t,
    );
    assertExactType(
        "hive_ghostty_surface_process_output_v1",
        @TypeOf(c.hive_ghostty_surface_process_output_v1),
        fn (c.ghostty_surface_t, [*c]const u8, usize, u64) callconv(.c) c.ghostty_result_e,
    );
    assertExactType(
        "hive_ghostty_surface_restore_checkpoint_v1",
        @TypeOf(c.hive_ghostty_surface_restore_checkpoint_v1),
        fn (c.ghostty_surface_t, [*c]const u8, usize, u64) callconv(.c) c.ghostty_result_e,
    );
    assertExactType(
        "hive_ghostty_terminal_checkpoint_export_v1",
        @TypeOf(c.hive_ghostty_terminal_checkpoint_export_v1),
        fn (
            c.ghostty_terminal_t,
            c.hive_ghostty_alloc_fn,
            ?*anyopaque,
            [*c][*c]u8,
            [*c]usize,
        ) callconv(.c) c.ghostty_result_e,
    );
    assertExactType(
        "hive_ghostty_terminal_checkpoint_import_v1",
        @TypeOf(c.hive_ghostty_terminal_checkpoint_import_v1),
        fn (c.ghostty_terminal_t, [*c]const u8, usize) callconv(.c) c.ghostty_result_e,
    );
}

test "Hive bridge ABI values and layout" {
    try std.testing.expectEqual(@as(c_int, 0), c.GHOSTTY_SUCCESS);
    try std.testing.expectEqual(@as(c_int, -1), c.GHOSTTY_OUT_OF_MEMORY);
    try std.testing.expectEqual(@as(c_int, -2), c.GHOSTTY_INVALID_VALUE);
    try std.testing.expectEqual(@as(c_int, -3), c.GHOSTTY_OUT_OF_SPACE);
    try std.testing.expectEqual(@as(c_int, -4), c.GHOSTTY_NO_VALUE);
    try std.testing.expectEqual(@as(c_uint, 1), c.HIVE_GHOSTTY_EVENT_INVALIDATE);
    try std.testing.expectEqual(@as(c_uint, 2), c.HIVE_GHOSTTY_EVENT_TITLE);
    try std.testing.expectEqual(@as(c_uint, 3), c.HIVE_GHOSTTY_EVENT_PWD);
    try std.testing.expectEqual(@as(c_uint, 4), c.HIVE_GHOSTTY_EVENT_BELL);
    try std.testing.expectEqual(@as(c_uint, 5), c.HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED);
    try std.testing.expectEqual(@as(c_uint, 6), c.HIVE_GHOSTTY_EVENT_CLOSE_REQUEST);
    try std.testing.expectEqual(@as(c_uint, 0), c.HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED);
    try std.testing.expectEqual(@as(c_uint, 1), c.HIVE_GHOSTTY_TERMINAL_REPLIES_ENABLED);
    std.debug.print(
        "ZIG_ABI_OK pointer={} enum_size={} enum_align={} event_size={} event_align={} callconv=c symbols=6\n",
        .{
            @sizeOf(?*anyopaque),
            @sizeOf(c.hive_ghostty_event_e),
            @alignOf(c.hive_ghostty_event_e),
            @sizeOf(c.hive_ghostty_event_s),
            @alignOf(c.hive_ghostty_event_s),
        },
    );
}
