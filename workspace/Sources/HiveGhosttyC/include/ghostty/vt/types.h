/* Minimal GhosttyResult/GhosttyTerminal for hive_ghostty_bridge.h.
 * ABI matches libghostty-vt types.h (result.zig enum(c_int)). */
#ifndef GHOSTTY_VT_TYPES_H
#define GHOSTTY_VT_TYPES_H
#include <stdint.h>
typedef enum {
    GHOSTTY_SUCCESS = 0,
    GHOSTTY_OUT_OF_MEMORY = -1,
    GHOSTTY_INVALID_VALUE = -2,
    GHOSTTY_OUT_OF_SPACE = -3,
    GHOSTTY_NO_VALUE = -4
} GhosttyResult;
typedef struct GhosttyTerminalImpl *GhosttyTerminal;
#endif
