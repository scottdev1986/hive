#!/usr/bin/env python3
"""hadley: does mirroring actually CLEAR the floors, or did I assert a direction?

I told hollis2 that light L* = 100 - dark L* moves every tight light entry AWAY
from its floor, and they are now propagating that into the C1.2b brief as a
design constraint. A direction is not a number. This computes the mirrored
lightness per slot and asks what contrast it actually yields on the light
background -- and whether the background itself has to move.

Method: for each slot, take dark-mode L*, mirror it (100 - L*), convert that L*
to a luminance Y, and compute the WCAG ratio against the light background. Hue
is irrelevant here: WCAG ratio depends only on relative luminance, and L* fixes
Y exactly. So this is the ratio ANY hue at that lightness would give -- an exact
answer for the mirrored design, not an approximation.
"""
import re
import sys
import pathlib

CONF = pathlib.Path(sys.argv[1])


def srgb_Y(hexstr):
    ch = [int(hexstr[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in ch]
    return 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.0721750 * lin[2]


def Y_to_L(y):
    return 116 * (y ** (1 / 3)) - 16 if y > 216 / 24389 else (24389 / 27) * y


def L_to_Y(L):
    return ((L + 16) / 116) ** 3 if L > 8 else L * 27 / 24389


def wcag_from_Y(y1, y2):
    return (max(y1, y2) + 0.05) / (min(y1, y2) + 0.05)


text = CONF.read_text()
themes = {}
for m in re.finditer(
    r'static let \w+ = HiveTerminalTheme\(\s*identifier: "([\w-]+)".*?'
    r'background: "([0-9a-f]{6})",\s*foreground: "([0-9a-f]{6})",\s*ansi: \[(.*?)\]',
    text, re.S
):
    ident, bg, fg, blob = m.groups()
    themes[ident] = {"bg": bg, "fg": fg,
                     "ansi": re.findall(r'"([0-9a-fA-F]{6})"', blob)}

D, L = themes["hive-dark"], themes["hive-light"]
NAMES = ["0 black", "1 red", "2 green", "3 yellow", "4 blue", "5 magenta",
         "6 cyan", "7 white", "8 br.black", "9 br.red", "10 br.green",
         "11 br.yellow", "12 br.blue", "13 br.magenta", "14 br.cyan",
         "15 br.white"]
DE_EMPH = {0, 8}

bgY = srgb_Y(L["bg"])
print("light background %s  L*=%.1f\n" % (L["bg"], Y_to_L(bgY)))
print("%-13s %7s %8s %9s %9s %7s %s" %
      ("slot", "darkL*", "mirrorL*", "now", "mirrored", "floor", "verdict"))

fails, gains = [], []
for i, name in enumerate(NAMES):
    dL = Y_to_L(srgb_Y(D["ansi"][i]))
    mirrored_L = 100 - dL
    now = wcag_from_Y(srgb_Y(L["ansi"][i]), bgY)
    mirr = wcag_from_Y(L_to_Y(mirrored_L), bgY)
    floor = 3.0 if i in DE_EMPH else 4.5
    ok = mirr >= floor
    if not ok:
        fails.append((name, mirr, floor))
    gains.append(mirr - now)
    print("%-13s %7.1f %8.1f %9.2f %9.2f %7.1f %s"
          % (name, dL, mirrored_L, now, mirr, floor,
             "OK" if ok else "*** BELOW FLOOR ***"))

# foreground pair
fdL = Y_to_L(srgb_Y(D["fg"]))
fmirr = wcag_from_Y(L_to_Y(100 - fdL), bgY)
fnow = wcag_from_Y(srgb_Y(L["fg"]), bgY)
print("%-13s %7.1f %8.1f %9.2f %9.2f %7.1f %s"
      % ("foreground", fdL, 100 - fdL, fnow, fmirr, 7.0,
         "OK" if fmirr >= 7 else "*** BELOW FLOOR ***"))

print("\n=== DOES MY CLAIM TO hollis2 HOLD? ===")
print("  entries below floor under mirroring : %d" % len(fails))
for n, r, f in fails:
    print("      %s %.2f < %.1f" % (n, r, f))
print("  entries whose ratio IMPROVES        : %d/16" % sum(1 for g in gains if g > 0))
print("  mean ratio change                   : %+.2f" % (sum(gains) / 16))
print("  background f7f9fc must move?        : %s"
      % ("NO -- every mirrored entry clears its floor on the existing background"
         if not fails else "YES -- see failures above"))
print("\n  Tight entries specifically:")
for i in (2, 3, 8):
    dL = Y_to_L(srgb_Y(D["ansi"][i]))
    print("    %-12s %.2f -> %.2f" % (
        NAMES[i], wcag_from_Y(srgb_Y(L["ansi"][i]), bgY),
        wcag_from_Y(L_to_Y(100 - dL), bgY)))
