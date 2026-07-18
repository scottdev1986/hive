#include <hive_ghostty_bridge.h>

#include <stddef.h>

typedef struct { char prefix; hive_ghostty_event_e value; } hive_event_align_probe;
typedef struct { char prefix; int value; } hive_int_align_probe;
typedef struct { char prefix; hive_ghostty_event_s value; } hive_event_struct_align_probe;
typedef struct { char prefix; hive_ghostty_semantic_row_s value; } hive_row_struct_align_probe;
typedef struct { char prefix; hive_ghostty_semantic_snapshot_s value; } hive_snapshot_struct_align_probe;
typedef struct { char prefix; void *value; } hive_pointer_align_probe;

/* Gate 4 (M1-B1): freeze every wire-visible value and layout of the
 * Hive-owned fork contract. These are the CONTRACT constants — Swift's
 * GhosttyBridgeResult raw values and BridgeEvent mapping assume them —
 * so an upstream or patch renumbering must fail this build, not silently
 * reinterpret checkpoints/results at runtime. (Divide-by-zero-on-false
 * idiom rather than _Static_assert: -Weverything's -Wpre-c11-compat
 * rejects the latter even under -std=c11.) */
enum {
  hive_result_success_is_0 = 1 / (GHOSTTY_SUCCESS == 0),
  hive_result_oom_is_m1 = 1 / (GHOSTTY_OUT_OF_MEMORY == -1),
  hive_result_invalid_is_m2 = 1 / (GHOSTTY_INVALID_VALUE == -2),
  hive_result_out_of_space_is_m3 = 1 / (GHOSTTY_OUT_OF_SPACE == -3),
  hive_result_no_value_is_m4 = 1 / (GHOSTTY_NO_VALUE == -4),

  hive_event_invalidate_is_1 = 1 / (HIVE_GHOSTTY_EVENT_INVALIDATE == 1),
  hive_event_title_is_2 = 1 / (HIVE_GHOSTTY_EVENT_TITLE == 2),
  hive_event_pwd_is_3 = 1 / (HIVE_GHOSTTY_EVENT_PWD == 3),
  hive_event_bell_is_4 = 1 / (HIVE_GHOSTTY_EVENT_BELL == 4),
  hive_event_clipboard_denied_is_5 = 1 / (HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED == 5),
  hive_event_close_request_is_6 = 1 / (HIVE_GHOSTTY_EVENT_CLOSE_REQUEST == 6),

  /* The enum's REPRESENTATION is ABI, not just its values: the Zig
   * trampoline writes this field as a c_int (4 bytes). The offset/size
   * asserts below cannot catch a representation drift on their own — with
   * an 8-byte enum, offsetof(bytes) == sizeof(void *) still holds and the
   * struct size is unchanged, but the type field would overlap what Zig
   * wrote as padding (cross-vendor review brenda, 2026-07-18). */
  hive_event_enum_is_c_int_sized = 1 / (sizeof(hive_ghostty_event_e) == 4),
  hive_event_enum_is_c_int_aligned =
      1 / (offsetof(hive_event_align_probe, value) ==
           offsetof(hive_int_align_probe, value)),

  /* Layout of the only aggregate Hive defines on the wire. Field order,
   * offsets, and the 4-byte enum→pointer padding are ABI: the Zig
   * trampoline writes this struct byte-for-byte (the check script passes
   * -Wno-padded because this padding is asserted here as contract). */
  hive_event_struct_type_first = 1 / (offsetof(hive_ghostty_event_s, type) == 0),
  hive_event_struct_padding_is_4 =
      1 / (offsetof(hive_ghostty_event_s, bytes) - sizeof(hive_ghostty_event_e) == 4),
  hive_event_struct_bytes_at_ptr = 1 / (offsetof(hive_ghostty_event_s, bytes) == sizeof(void *)),
  hive_event_struct_length_after = 1 / (offsetof(hive_ghostty_event_s, length) == 2 * sizeof(void *)),
  hive_event_struct_total_size = 1 / (sizeof(hive_ghostty_event_s) == 3 * sizeof(void *)),
  hive_event_struct_pointer_aligned =
      1 / (offsetof(hive_event_struct_align_probe, value) ==
           offsetof(hive_pointer_align_probe, value)),

  hive_row_utf8_offset_first =
      1 / (offsetof(hive_ghostty_semantic_row_s, utf8_offset) == 0),
  hive_row_utf8_length_at_8 =
      1 / (offsetof(hive_ghostty_semantic_row_s, utf8_length) == 8),
  hive_row_utf16_offset_at_16 =
      1 / (offsetof(hive_ghostty_semantic_row_s, utf16_offset) == 16),
  hive_row_utf16_length_at_24 =
      1 / (offsetof(hive_ghostty_semantic_row_s, utf16_length) == 24),
  hive_row_break8_at_32 =
      1 / (offsetof(hive_ghostty_semantic_row_s, line_break_utf8_length) == 32),
  hive_row_break16_at_36 =
      1 / (offsetof(hive_ghostty_semantic_row_s, line_break_utf16_length) == 36),
  hive_row_cell_map_at_40 =
      1 / (offsetof(hive_ghostty_semantic_row_s, cell_utf16_offset_index) == 40),
  hive_row_cell_count_at_44 =
      1 / (offsetof(hive_ghostty_semantic_row_s, cell_count) == 44),
  hive_row_size_is_48 =
      1 / (sizeof(hive_ghostty_semantic_row_s) == 48),
  hive_row_pointer_aligned =
      1 / (offsetof(hive_row_struct_align_probe, value) ==
           offsetof(hive_pointer_align_probe, value)),

  hive_snapshot_generation_first =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, generation) == 0),
  hive_snapshot_text_at_8 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, text) == 8),
  hive_snapshot_text_length_at_16 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, text_length) == 16),
  hive_snapshot_text_utf16_length_at_24 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, text_utf16_length) == 24),
  hive_snapshot_rows_at_32 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, visible_rows) == 32),
  hive_snapshot_row_count_at_40 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, visible_row_count) == 40),
  hive_snapshot_cell_map_at_48 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cell_utf16_offsets) == 48),
  hive_snapshot_cell_map_count_at_56 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cell_utf16_offset_count) == 56),
  hive_snapshot_selected_text_at_64 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, selected_text) == 64),
  hive_snapshot_selected_text_length_at_72 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, selected_text_length) == 72),
  hive_snapshot_selection_offset_at_80 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, selection_utf16_offset) == 80),
  hive_snapshot_selection_length_at_88 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, selection_utf16_length) == 88),
  hive_snapshot_cursor_offset_at_96 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_utf16_offset) == 96),
  hive_snapshot_cursor_line_at_104 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_line) == 104),
  hive_snapshot_scroll_total_at_112 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, scroll_total) == 112),
  hive_snapshot_scroll_offset_at_120 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, scroll_offset) == 120),
  hive_snapshot_scroll_length_at_128 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, scroll_length) == 128),
  hive_snapshot_columns_at_136 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, columns) == 136),
  hive_snapshot_rows_geometry_at_140 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, rows) == 140),
  hive_snapshot_width_at_144 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, width_px) == 144),
  hive_snapshot_height_at_148 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, height_px) == 148),
  hive_snapshot_cell_width_at_152 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cell_width_px) == 152),
  hive_snapshot_cell_height_at_156 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cell_height_px) == 156),
  hive_snapshot_padding_top_at_160 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, padding_top_px) == 160),
  hive_snapshot_padding_bottom_at_164 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, padding_bottom_px) == 164),
  hive_snapshot_padding_right_at_168 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, padding_right_px) == 168),
  hive_snapshot_padding_left_at_172 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, padding_left_px) == 172),
  hive_snapshot_cursor_column_at_176 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_column) == 176),
  hive_snapshot_cursor_row_at_180 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_row) == 180),
  hive_snapshot_cursor_x_at_184 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_x_px) == 184),
  hive_snapshot_cursor_y_at_188 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_y_px) == 188),
  hive_snapshot_cursor_width_at_192 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_width_px) == 192),
  hive_snapshot_cursor_height_at_196 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_height_px) == 196),
  hive_snapshot_flags_at_200 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, has_selection) == 200),
  hive_snapshot_rectangle_at_201 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, selection_is_rectangular) == 201),
  hive_snapshot_clipped_at_202 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, selection_range_clipped) == 202),
  hive_snapshot_cursor_visible_at_203 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_visible) == 203),
  hive_snapshot_pending_wrap_at_204 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, cursor_pending_wrap) == 204),
  hive_snapshot_follows_bottom_at_205 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, viewport_follows_bottom) == 205),
  hive_snapshot_reserved_at_206 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, reserved) == 206),
  hive_snapshot_allocation_at_208 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, allocation) == 208),
  hive_snapshot_allocation_length_at_216 =
      1 / (offsetof(hive_ghostty_semantic_snapshot_s, allocation_length) == 216),
  hive_snapshot_size_is_224 =
      1 / (sizeof(hive_ghostty_semantic_snapshot_s) == 224),
  hive_snapshot_pointer_aligned =
      1 / (offsetof(hive_snapshot_struct_align_probe, value) ==
           offsetof(hive_pointer_align_probe, value))
};

static void test_write(void *context, const uint8_t *bytes, size_t length) {
  (void)context;
  (void)bytes;
  (void)length;
}

static void *test_alloc(void *context, size_t length, size_t alignment) {
  (void)context;
  (void)length;
  (void)alignment;
  return NULL;
}

static void test_event(void *context, const hive_ghostty_event_s *event) {
  (void)context;
  (void)event;
}

int main(void) {
  hive_ghostty_write_fn write_callback = test_write;
  hive_ghostty_alloc_fn alloc_callback = test_alloc;
  hive_ghostty_event_fn event_callback = test_event;
  const char *(*build_id)(void) = hive_ghostty_engine_build_id_v1;
  ghostty_surface_t (*new_manual)(
    ghostty_app_t, const ghostty_surface_config_s *,
    hive_ghostty_terminal_reply_policy_e, hive_ghostty_write_fn,
    void *, hive_ghostty_event_fn, void *) = hive_ghostty_surface_new_manual_v1;
  ghostty_result_e (*process_output)(
    ghostty_surface_t, const uint8_t *, size_t, uint64_t) =
    hive_ghostty_surface_process_output_v1;
  ghostty_result_e (*restore_surface)(
    ghostty_surface_t, const uint8_t *, size_t, uint64_t) =
    hive_ghostty_surface_restore_checkpoint_v1;
  ghostty_result_e (*semantic_snapshot)(
    ghostty_surface_t, hive_ghostty_alloc_fn, void *,
    hive_ghostty_semantic_snapshot_s *) =
    hive_ghostty_surface_semantic_snapshot_v1;
  ghostty_result_e (*export_terminal)(
    ghostty_terminal_t, hive_ghostty_alloc_fn, void *, uint8_t **, size_t *) =
    hive_ghostty_terminal_checkpoint_export_v1;
  ghostty_result_e (*import_terminal)(
    ghostty_terminal_t, const uint8_t *, size_t) =
    hive_ghostty_terminal_checkpoint_import_v1;

  (void)build_id;
  (void)new_manual;
  (void)process_output;
  (void)restore_surface;
  (void)semantic_snapshot;
  (void)export_terminal;
  (void)import_terminal;
  (void)write_callback;
  (void)alloc_callback;
  (void)event_callback;
  return 0;
}
