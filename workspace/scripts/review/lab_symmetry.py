#!/usr/bin/env python3
"""hadley: is the C1.2 pair 'authored together with symmetric lightness'?

Story acceptance criterion 4 (planning/story-m1-c1-beautiful-blank-terminal.md:272)
requires it; line 103 defines the method as Solarized's -- authored in CIELAB with
symmetric lightness across modes so PERCEIVED contrast survives the switch.

Two independent measures, both computed from the shipped source:
  1. CIELAB L* of each slot, and |dL*| from its own background.
     Symmetric => |dL*|(dark) ~= |dL*|(light) per slot.
  2. WCAG ratio symmetry per slot across modes.
Solarized's own realisation of this is the strong form: the SAME accent hex in
both modes, with only base tones swapped.
"""
import re
import sys
import pathlib

CONF = pathlib.Path(sys.argv[1])


def srgb_to_xyz(hexstr):
    ch = [int(hexstr[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in ch]
    r, g, b = lin
    return (0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
            0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
            0.0193339 * r + 0.1191920 * g + 0.9503041 * b)


def lab_L(hexstr):
    """CIE L* (D65). Only L* is needed: the claim is about lightness."""
    y = srgb_to_xyz(hexstr)[1] / 1.0
    f = y ** (1 / 3) if y > 216 / 24389 else (841 / 108) * y + 4 / 29
    return 116 * f - 16


def wcag(a, b):
    def rl(h):
        ch = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in ch]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    la, lb = rl(a), rl(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


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

print("Background L*:  dark %.1f   light %.1f" % (lab_L(D["bg"]), lab_L(L["bg"])))
print("(Solarized strong form: identical accent hex both modes -> dL* identical)\n")
print("%-13s %-16s %-16s %8s %8s %8s" %
      ("slot", "dark hex/L*", "light hex/L*", "|dL*|D", "|dL*|L", "asym"))

dl_gap, wc_gap, same_hex = [], [], 0
for i, name in enumerate(NAMES):
    dh, lh = D["ansi"][i], L["ansi"][i]
    if dh.lower() == lh.lower():
        same_hex += 1
    dL = abs(lab_L(dh) - lab_L(D["bg"]))
    lL = abs(lab_L(lh) - lab_L(L["bg"]))
    dl_gap.append(abs(dL - lL))
    wd, wl = wcag(dh, D["bg"]), wcag(lh, L["bg"])
    wc_gap.append(abs(wd - wl))
    print("%-13s %s/%5.1f      %s/%5.1f    %7.1f %7.1f %7.1f"
          % (name, dh, lab_L(dh), lh, lab_L(lh), dL, lL, abs(dL - lL)))

fdL = abs(lab_L(D["fg"]) - lab_L(D["bg"]))
flL = abs(lab_L(L["fg"]) - lab_L(L["bg"]))
print("%-13s %s/%5.1f      %s/%5.1f    %7.1f %7.1f %7.1f"
      % ("foreground", D["fg"], lab_L(D["fg"]), L["fg"], lab_L(L["fg"]),
         fdL, flL, abs(fdL - flL)))

print("\n=== VERDICT INPUTS ===")
print("  slots sharing identical hex across modes : %d/16 (Solarized strong form = 16/16)" % same_hex)
print("  mean |dL* asymmetry| over 16 slots       : %.1f L* units" % (sum(dl_gap) / 16))
print("  max  |dL* asymmetry|                     : %.1f L* units (%s)"
      % (max(dl_gap), NAMES[dl_gap.index(max(dl_gap))]))
print("  mean |WCAG ratio gap| over 16 slots      : %.2f" % (sum(wc_gap) / 16))
print("  max  |WCAG ratio gap|                    : %.2f (%s)"
      % (max(wc_gap), NAMES[wc_gap.index(max(wc_gap))]))
print("\n  A just-noticeable difference is ~1 L* unit; ~2-3 is clearly visible.")
print("  Symmetric-by-construction would show mean |dL* asym| near 0.")
