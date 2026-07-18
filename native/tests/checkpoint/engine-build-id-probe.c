#include <stdio.h>

extern const char *hive_ghostty_engine_build_id_v1(void);

int main(void) {
  const char *build_id = hive_ghostty_engine_build_id_v1();
  if (build_id == NULL || build_id[0] == '\0') return 1;
  return puts(build_id) < 0 ? 1 : 0;
}
