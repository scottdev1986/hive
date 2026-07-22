// include/hive_ghostty_bridge.h — versioned, C-callable, no Swift layout types
#ifndef HIVE_GHOSTTY_BRIDGE_H
#define HIVE_GHOSTTY_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#include <ghostty/vt/types.h>
#include <ghostty.h>

typedef GhosttyResult ghostty_result_e;
typedef GhosttyTerminal ghostty_terminal_t;

typedef void (*hive_ghostty_write_fn)(
  void *context, const uint8_t *bytes, size_t length);
typedef void *(*hive_ghostty_alloc_fn)(
  void *context, size_t length, size_t alignment);
typedef enum hive_ghostty_event_e {
  HIVE_GHOSTTY_EVENT_INVALIDATE = 1,
  HIVE_GHOSTTY_EVENT_TITLE = 2,
  HIVE_GHOSTTY_EVENT_PWD = 3,
  HIVE_GHOSTTY_EVENT_BELL = 4,
  HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED = 5,
  HIVE_GHOSTTY_EVENT_CLOSE_REQUEST = 6
} hive_ghostty_event_e;
typedef struct hive_ghostty_event_s {
  hive_ghostty_event_e type;
  const uint8_t *bytes; size_t length; // callback-lifetime only; UTF-8 where applicable
} hive_ghostty_event_s;
typedef void (*hive_ghostty_event_fn)(
  void *context, const hive_ghostty_event_s *event);
typedef uint32_t hive_ghostty_terminal_reply_policy_e;
enum {
  HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED = 0,
  HIVE_GHOSTTY_TERMINAL_REPLIES_ENABLED = 1
};

/* UTF-8/UTF-16 ranges for one visible terminal display row. The row's text
 * excludes its trailing hard line break; line_break_* is either zero or one.
 * Offsets address the snapshot's text buffers, never terminal cells.
 * cell_utf16_offsets contains cell_count + 1 boundaries for each row, starting
 * at cell_utf16_offset_index. Empty, trimmed, and wide-continuation cells may
 * share a boundary. */
typedef struct hive_ghostty_semantic_row_s {
  uint64_t utf8_offset;
  uint64_t utf8_length;
  uint64_t utf16_offset;
  uint64_t utf16_length;
  uint32_t line_break_utf8_length;
  uint32_t line_break_utf16_length;
  uint32_t cell_utf16_offset_index;
  uint32_t cell_count;
} hive_ghostty_semantic_row_s;

/* One internally consistent, viewport-bounded manual-surface semantic
 * snapshot. Every field, including grid and pixel geometry, is captured from
 * the Terminal under one renderer-state mutex acquisition. UINT64_MAX means
 * that a range/index is not present in the visible UTF-16 text coordinate
 * space. A rectangular selection has exact selected_text but no fabricated
 * contiguous range. selection_range_clipped marks a non-rectangular range
 * clipped to the viewport. cursor_visible requires both terminal cursor
 * visibility and a cursor mapped into the viewport. Padding is zero because
 * renderer padding is not part of the locked Terminal commit. allocation is
 * the single block returned by the caller's allocator; the caller owns and
 * frees it after copying all pointer-backed fields. */
typedef struct hive_ghostty_semantic_snapshot_s {
  uint64_t generation;
  const uint8_t *text;
  uint64_t text_length;
  uint64_t text_utf16_length;
  const hive_ghostty_semantic_row_s *visible_rows;
  uint64_t visible_row_count;
  const uint64_t *cell_utf16_offsets;
  uint64_t cell_utf16_offset_count;
  const uint8_t *selected_text;
  uint64_t selected_text_length;
  uint64_t selection_utf16_offset;
  uint64_t selection_utf16_length;
  uint64_t cursor_utf16_offset;
  uint64_t cursor_line;
  uint64_t scroll_total;
  uint64_t scroll_offset;
  uint64_t scroll_length;
  uint32_t columns;
  uint32_t rows;
  uint32_t width_px;
  uint32_t height_px;
  uint32_t cell_width_px;
  uint32_t cell_height_px;
  uint32_t padding_top_px;
  uint32_t padding_bottom_px;
  uint32_t padding_right_px;
  uint32_t padding_left_px;
  uint32_t cursor_column;
  uint32_t cursor_row;
  uint32_t cursor_x_px;
  uint32_t cursor_y_px;
  uint32_t cursor_width_px;
  uint32_t cursor_height_px;
  uint8_t has_selection;
  uint8_t selection_is_rectangular;
  uint8_t selection_range_clipped;
  uint8_t cursor_visible;
  uint8_t cursor_pending_wrap;
  uint8_t viewport_follows_bottom;
  uint8_t reserved[2];
  void *allocation;
  uint64_t allocation_length;
} hive_ghostty_semantic_snapshot_s;

/* Hive fork contract v1. The returned lowercase hexadecimal identity binds
 * checkpoints and attach/replay to one engine build and architecture. */
const char *hive_ghostty_engine_build_id_v1(void);

/* Manual creation uses platform/userdata/scale/font fields from config but
 * deliberately ignores working_directory, command, env_vars, env_var_count,
 * initial_input, and wait_after_command. It creates no child, shell, or PTY.
 * In manual mode the stock process queries are unsupported sentinels:
 * process_exited=false, foreground_pid=0, and tty_name empty. */
ghostty_surface_t hive_ghostty_surface_new_manual_v1(
  ghostty_app_t, const ghostty_surface_config_s *,
  hive_ghostty_terminal_reply_policy_e,
  hive_ghostty_write_fn, void *write_context,
  hive_ghostty_event_fn, void *event_context);

/* The only remote-output mutation entry point. stream_seq is the byte offset
 * of this ordered range. Terminal-generated host bytes leave only through the
 * write callback supplied at manual creation. */
ghostty_result_e hive_ghostty_surface_process_output_v1(
  ghostty_surface_t, const uint8_t *bytes, size_t length, uint64_t stream_seq);
ghostty_result_e hive_ghostty_surface_restore_checkpoint_v1(
  ghostty_surface_t, const uint8_t *payload, size_t length, uint64_t through_seq);

/* Manual surfaces only. The caller must be admitted on the surface's main
 * thread and must not call from a Ghostty callback or reentrant Ghostty stack.
 * Variable data is returned in one caller-owned block; alloc is invoked
 * exactly once after the atomic native capture succeeds. */
ghostty_result_e hive_ghostty_surface_semantic_snapshot_v1(
  ghostty_surface_t, hive_ghostty_alloc_fn, void *context,
  hive_ghostty_semantic_snapshot_s *snapshot);

ghostty_result_e hive_ghostty_terminal_checkpoint_export_v1(
  ghostty_terminal_t, hive_ghostty_alloc_fn, void *context,
  uint8_t **payload, size_t *length);
/* Streams the byte-identical HVGCP001 payload in chunks no larger than 64 KiB.
 * The callback returns GHOSTTY_SUCCESS to continue or another result to abort;
 * length is set only after the complete payload has been written. */
typedef ghostty_result_e (*hive_ghostty_checkpoint_write_fn)(
  void *context, const uint8_t *bytes, size_t length);
ghostty_result_e hive_ghostty_terminal_checkpoint_export_stream_v1(
  ghostty_terminal_t, hive_ghostty_checkpoint_write_fn, void *context,
  size_t *length);
ghostty_result_e hive_ghostty_terminal_checkpoint_import_v1(
  ghostty_terminal_t, const uint8_t *payload, size_t length);

#endif
