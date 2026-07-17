/**
 * @file types.h
 * Minimal GhosttyResult / GhosttyTerminal for hive_ghostty_bridge.h.
 *
 * Values are the libghostty-vt ABI (result.zig / ghostty/vt/types.h):
 *   GHOSTTY_SUCCESS=0, OUT_OF_MEMORY=-1, INVALID_VALUE=-2,
 *   OUT_OF_SPACE=-3, NO_VALUE=-4.
 *
 * HeaderParityTests asserts these constants equal the real libghostty-vt
 * types.h when the offline GhosttyKit artifact is present — do not invent
 * new result codes here.
 */
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
