#include <hive_ghostty_bridge.h>

#include <stddef.h>

typedef struct { char prefix; hive_ghostty_event_e value; } hive_event_align_probe;
typedef struct { char prefix; int value; } hive_int_align_probe;
typedef struct { char prefix; hive_ghostty_event_s value; } hive_event_struct_align_probe;
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
    ghostty_app_t, const ghostty_surface_config_s *, hive_ghostty_write_fn,
    void *, hive_ghostty_event_fn, void *) = hive_ghostty_surface_new_manual_v1;
  ghostty_result_e (*process_output)(
    ghostty_surface_t, const uint8_t *, size_t, uint64_t) =
    hive_ghostty_surface_process_output_v1;
  ghostty_result_e (*restore_surface)(
    ghostty_surface_t, const uint8_t *, size_t, uint64_t) =
    hive_ghostty_surface_restore_checkpoint_v1;
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
  (void)export_terminal;
  (void)import_terminal;
  (void)write_callback;
  (void)alloc_callback;
  (void)event_callback;
  return 0;
}
