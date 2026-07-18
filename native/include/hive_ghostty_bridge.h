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

ghostty_result_e hive_ghostty_terminal_checkpoint_export_v1(
  ghostty_terminal_t, hive_ghostty_alloc_fn, void *context,
  uint8_t **payload, size_t *length);
ghostty_result_e hive_ghostty_terminal_checkpoint_import_v1(
  ghostty_terminal_t, const uint8_t *payload, size_t length);

#endif
