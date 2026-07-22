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
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "utf8_offset") != 0) @compileError("row UTF-8 offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "utf8_length") != 8) @compileError("row UTF-8 length drifted");
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "utf16_offset") != 16) @compileError("row UTF-16 offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "utf16_length") != 24) @compileError("row UTF-16 length drifted");
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "line_break_utf8_length") != 32) @compileError("row line-break offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "line_break_utf16_length") != 36) @compileError("row UTF-16 line-break offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "cell_utf16_offset_index") != 40) @compileError("row cell-map offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_row_s, "cell_count") != 44) @compileError("row cell count drifted");
    if (@sizeOf(c.hive_ghostty_semantic_row_s) != 48) @compileError("row size drifted");
    if (@alignOf(c.hive_ghostty_semantic_row_s) != @alignOf(?*anyopaque)) @compileError("row alignment drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "generation") != 0) @compileError("snapshot generation drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "text") != 8) @compileError("snapshot text drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "text_length") != 16) @compileError("snapshot text length drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "text_utf16_length") != 24) @compileError("snapshot UTF-16 length drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "visible_rows") != 32) @compileError("snapshot rows offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "visible_row_count") != 40) @compileError("snapshot row count drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cell_utf16_offsets") != 48) @compileError("snapshot cell-map offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cell_utf16_offset_count") != 56) @compileError("snapshot cell-map count drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "selected_text") != 64) @compileError("snapshot selected text offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "selected_text_length") != 72) @compileError("snapshot selected text length drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "selection_utf16_offset") != 80) @compileError("snapshot selection offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "selection_utf16_length") != 88) @compileError("snapshot selection length drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_utf16_offset") != 96) @compileError("snapshot cursor offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_line") != 104) @compileError("snapshot cursor line drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "scroll_total") != 112) @compileError("snapshot scroll offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "scroll_offset") != 120) @compileError("snapshot scroll position drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "scroll_length") != 128) @compileError("snapshot scroll length drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "columns") != 136) @compileError("snapshot geometry offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "rows") != 140) @compileError("snapshot rows geometry drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "width_px") != 144) @compileError("snapshot width drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "height_px") != 148) @compileError("snapshot height drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cell_width_px") != 152) @compileError("snapshot cell width drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cell_height_px") != 156) @compileError("snapshot cell height drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "padding_top_px") != 160) @compileError("snapshot top padding drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "padding_bottom_px") != 164) @compileError("snapshot bottom padding drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "padding_right_px") != 168) @compileError("snapshot right padding drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "padding_left_px") != 172) @compileError("snapshot left padding drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_column") != 176) @compileError("snapshot cursor geometry offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_row") != 180) @compileError("snapshot cursor row drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_x_px") != 184) @compileError("snapshot cursor x drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_y_px") != 188) @compileError("snapshot cursor y drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_width_px") != 192) @compileError("snapshot cursor width drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_height_px") != 196) @compileError("snapshot cursor height drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "has_selection") != 200) @compileError("snapshot flags offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "selection_is_rectangular") != 201) @compileError("snapshot rectangle flag drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "selection_range_clipped") != 202) @compileError("snapshot clipped flag drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_visible") != 203) @compileError("snapshot cursor-visible flag drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "cursor_pending_wrap") != 204) @compileError("snapshot pending-wrap flag drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "viewport_follows_bottom") != 205) @compileError("snapshot follows-bottom flag drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "reserved") != 206) @compileError("snapshot reserved bytes drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "allocation") != 208) @compileError("snapshot allocation offset drifted");
    if (@offsetOf(c.hive_ghostty_semantic_snapshot_s, "allocation_length") != 216) @compileError("snapshot allocation length drifted");
    if (@sizeOf(c.hive_ghostty_semantic_snapshot_s) != 224) @compileError("snapshot size drifted");
    if (@alignOf(c.hive_ghostty_semantic_snapshot_s) != @alignOf(?*anyopaque)) @compileError("snapshot alignment drifted");

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
        "hive_ghostty_surface_semantic_snapshot_v1",
        @TypeOf(c.hive_ghostty_surface_semantic_snapshot_v1),
        fn (
            c.ghostty_surface_t,
            c.hive_ghostty_alloc_fn,
            ?*anyopaque,
            [*c]c.hive_ghostty_semantic_snapshot_s,
        ) callconv(.c) c.ghostty_result_e,
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
        "hive_ghostty_checkpoint_write_fn",
        c.hive_ghostty_checkpoint_write_fn,
        ?*const fn (?*anyopaque, [*c]const u8, usize) callconv(.c) c.ghostty_result_e,
    );
    assertExactType(
        "hive_ghostty_terminal_checkpoint_export_stream_v1",
        @TypeOf(c.hive_ghostty_terminal_checkpoint_export_stream_v1),
        fn (
            c.ghostty_terminal_t,
            c.hive_ghostty_checkpoint_write_fn,
            ?*anyopaque,
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
        "ZIG_ABI_OK pointer={} enum_size={} enum_align={} event_size={} event_align={} row_size={} snapshot_size={} callconv=c symbols=8\n",
        .{
            @sizeOf(?*anyopaque),
            @sizeOf(c.hive_ghostty_event_e),
            @alignOf(c.hive_ghostty_event_e),
            @sizeOf(c.hive_ghostty_event_s),
            @alignOf(c.hive_ghostty_event_s),
            @sizeOf(c.hive_ghostty_semantic_row_s),
            @sizeOf(c.hive_ghostty_semantic_snapshot_s),
        },
    );
}
