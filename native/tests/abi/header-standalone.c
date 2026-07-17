#include <hive_ghostty_bridge.h>

enum {
  hive_event_invalidate_value_is_1 = 1 / (HIVE_GHOSTTY_EVENT_INVALIDATE == 1),
  hive_event_close_value_is_6 = 1 / (HIVE_GHOSTTY_EVENT_CLOSE_REQUEST == 6)
};

int main(void) {
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
  return 0;
}
