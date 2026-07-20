#!/usr/bin/env python3
"""Independent WCAG 2.2 contrast re-derivation for hadley's review of C1.2.

Written from the WCAG 2.2 normative text, NOT from hollis2's WCAGContrast.swift:
  relative luminance L = 0.2126*R + 0.7152*G + 0.0722*B
  where for each channel c_srgb = c8/255:
      c = c_srgb/12.92                      if c_srgb <= 0.03928
      c = ((c_srgb + 0.055)/1.055) ** 2.4   otherwise
  contrast ratio = (L_lighter + 0.05) / (L_darker + 0.05)

Palettes are parsed OUT OF THE SOURCE FILE at the pin, so the numbers are
bound to the shipped colors rather than to any table.
"""
import re
import sys
import pathlib

CONF = pathlib.Path(sys.argv[1])


def lum(hexstr):
    if not re.fullmatch(r"[0-9a-fA-F]{6}", hexstr):
        raise ValueError("malformed hex: %r" % hexstr)
    ch = [int(hexstr[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in ch]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def ratio(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


# --- parse the four palettes straight out of the Swift source at the pin ---
text = CONF.read_text()
themes = {}
for m in re.finditer(
    r'static let (\w+) = HiveTerminalTheme\(\s*identifier: "([\w-]+)".*?'
    r'background: "([0-9a-f]{6})",\s*foreground: "([0-9a-f]{6})",\s*'
    r'ansi: \[(.*?)\]',
    text, re.S
):
    _var, ident, bg, fg, ansi_blob = m.groups()
    ansi = re.findall(r'"([0-9a-fA-F]{6})"', ansi_blob)
    themes[ident] = {"bg": bg, "fg": fg, "ansi": ansi}

if len(themes) != 4:
    sys.exit("PARSE FAILURE: expected 4 themes, parsed %d (%s)"
             % (len(themes), list(themes)))
for ident, t in themes.items():
    if len(t["ansi"]) != 16:
        sys.exit("PARSE FAILURE: %s has %d ansi entries" % (ident, len(t["ansi"])))

NAMES = ["0 black", "1 red", "2 green", "3 yellow", "4 blue", "5 magenta",
         "6 cyan", "7 white", "8 br.black", "9 br.red", "10 br.green",
         "11 br.yellow", "12 br.blue", "13 br.magenta", "14 br.cyan",
         "15 br.white"]
DE_EMPHASIS = {0, 8}
ORDER = ["hive-dark", "hive-light", "hive-dark-high-contrast",
         "hive-light-high-contrast"]

print("=== INDEPENDENTLY COMPUTED (hadley, from WCAG 2.2 text) ===")
print("%-14s %10s %10s %10s %10s" % ("Entry", *ORDER))
rows = {}
for ident in ORDER:
    t = themes[ident]
    rows[ident] = {"foreground": ratio(t["fg"], t["bg"])}
    for i, c in enumerate(t["ansi"]):
        rows[ident][NAMES[i]] = ratio(c, t["bg"])

for key in ["foreground"] + NAMES:
    print("%-14s %10.2f %10.2f %10.2f %10.2f"
          % (key, *[rows[i][key] for i in ORDER]))

# --- floor check, re-derived independently ---
print("\n=== FLOOR CHECK (fg >= 7:1, de-emphasis 0/8 >= 3:1, rest >= 4.5:1) ===")
viol = []
for ident in ORDER:
    if rows[ident]["foreground"] < 7:
        viol.append("%s foreground %.2f < 7" % (ident, rows[ident]["foreground"]))
    for i, name in enumerate(NAMES):
        floor = 3.0 if i in DE_EMPHASIS else 4.5
        if rows[ident][name] < floor:
            viol.append("%s %s %.2f < %.1f" % (ident, name, rows[ident][name], floor))
print("VIOLATIONS: %s" % (viol if viol else "NONE"))

# --- the Apple case: HC must dominate its base ENTRY-FOR-ENTRY ---
print("\n=== APPLE CASE: does each HC variant dominate its base entry-for-entry? ===")
regress = []
for base, hc in (("hive-dark", "hive-dark-high-contrast"),
                 ("hive-light", "hive-light-high-contrast")):
    for key in ["foreground"] + NAMES:
        b, h = rows[base][key], rows[hc][key]
        if h <= b:
            regress.append("%s -> %s  %s: %.2f -> %.2f (NOT raised)"
                           % (base, hc, key, b, h))
    print("  %s -> %s : %s" % (base, hc,
          "dominates on all 17 entries" if not any(base in r for r in regress)
          else "REGRESSIONS FOUND"))
print("REGRESSIONS: %s" % (regress if regress else "NONE"))

# --- negative control: prove this instrument can actually FAIL ---
print("\n=== NEGATIVE CONTROL (the instrument must be able to report failure) ===")
print("  ratio('808080','7f7f7f') = %.4f  (expect ~1.01, near-invisible)"
      % ratio("808080", "7f7f7f"))
print("  ratio('000000','ffffff') = %.4f  (expect exactly 21.00)"
      % ratio("000000", "ffffff"))
try:
    lum("6e footer")
    print("  MALFORMED HEX ACCEPTED -- instrument is lenient, DO NOT TRUST")
except ValueError as e:
    print("  malformed hex rejected: %s" % e)
