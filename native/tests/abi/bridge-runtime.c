#include <hive_ghostty_bridge.h>

#include <stddef.h>
#include <stdio.h>

#define CHECK(condition) do { if (!(condition)) return 1; } while (0)

int main(void) {
  CHECK(GHOSTTY_SUCCESS == 0);
  CHECK(GHOSTTY_OUT_OF_MEMORY == -1);
  CHECK(GHOSTTY_INVALID_VALUE == -2);
  CHECK(GHOSTTY_OUT_OF_SPACE == -3);
  CHECK(GHOSTTY_NO_VALUE == -4);
  CHECK(HIVE_GHOSTTY_EVENT_INVALIDATE == 1);
  CHECK(HIVE_GHOSTTY_EVENT_TITLE == 2);
  CHECK(HIVE_GHOSTTY_EVENT_PWD == 3);
  CHECK(HIVE_GHOSTTY_EVENT_BELL == 4);
  CHECK(HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED == 5);
  CHECK(HIVE_GHOSTTY_EVENT_CLOSE_REQUEST == 6);
  CHECK(sizeof(hive_ghostty_event_e) == sizeof(int));
  CHECK(_Alignof(hive_ghostty_event_e) == _Alignof(int));
  CHECK(offsetof(hive_ghostty_event_s, type) == 0);
  CHECK(offsetof(hive_ghostty_event_s, bytes) == sizeof(void *));
  CHECK(offsetof(hive_ghostty_event_s, length) == 2 * sizeof(void *));
  CHECK(sizeof(hive_ghostty_event_s) == 3 * sizeof(void *));
  CHECK(_Alignof(hive_ghostty_event_s) == _Alignof(void *));
  printf(
    "C_ABI_OK pointer=%zu enum_size=%zu enum_align=%zu event_size=%zu event_align=%zu\n",
    sizeof(void *), sizeof(hive_ghostty_event_e), _Alignof(hive_ghostty_event_e),
    sizeof(hive_ghostty_event_s), _Alignof(hive_ghostty_event_s));
  return 0;
}
