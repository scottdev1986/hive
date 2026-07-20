// hadley: independent re-derivation of hollis2's C1.2 deferral justification.
//
// Her claim (HiveAppearancePreferences.swift:74-79):
//   "NSAppearance(named: .accessibilityHighContrastAqua) reports its own name
//    as plain NSAppearanceNameAqua, and bestMatch maps every high-contrast name
//    onto its base, so no appearance read can recover it. The only reader is
//    NSWorkspace."
//
// If that is false -- if ANY appearance read recovers the HC bit -- then the
// deferral to C1.4 is unjustified and the increasedContrast:false hardcode is
// hiding an available signal behind a Gate 9 excuse.

import AppKit

let hcNames: [NSAppearance.Name] = [
    .accessibilityHighContrastAqua,
    .accessibilityHighContrastDarkAqua,
    .accessibilityHighContrastVibrantLight,
    .accessibilityHighContrastVibrantDark,
]
let baseNames: [NSAppearance.Name] = [.aqua, .darkAqua, .vibrantLight, .vibrantDark]

print("=== CLAIM 1: does an HC appearance report its own name back? ===")
for n in hcNames {
    guard let a = NSAppearance(named: n) else { print("  \(n.rawValue): nil"); continue }
    print("  requested \(n.rawValue)")
    print("     -> .name reports: \(a.name.rawValue)   \(a.name == n ? "PRESERVED" : "COLLAPSED")")
}

print("\n=== CLAIM 2: does bestMatch ever return an HC name? ===")
for n in hcNames {
    guard let a = NSAppearance(named: n) else { continue }
    let m = a.bestMatch(from: hcNames + baseNames)
    print("  \(n.rawValue) bestMatch(from: HC+base) -> \(m?.rawValue ?? "nil")")
}
// The decisive form: ask an HC appearance to choose among HC names ONLY.
print("\n  -- restricted to HC names only (no base to collapse onto) --")
for n in hcNames {
    guard let a = NSAppearance(named: n) else { continue }
    print("  \(n.rawValue) bestMatch(from: HConly) -> \(a.bestMatch(from: hcNames)?.rawValue ?? "nil")")
}

print("\n=== CLAIM 3: the currentDrawing appearance of this process ===")
print("  NSAppearance.currentDrawing().name = \(NSAppearance.currentDrawing().name.rawValue)")

print("\n=== CONTROL: NSWorkspace CAN read it (proving the bit is readable at all) ===")
print("  NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast = "
      + "\(NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast)")

print("\n=== VERDICT INPUT ===")
let anyPreserved = hcNames.contains { n in
    guard let a = NSAppearance(named: n) else { return false }
    return a.name == n || a.bestMatch(from: hcNames) == n
}
print("  any appearance read recovered an HC name: \(anyPreserved)")
print("  -> hollis2's claim is \(anyPreserved ? "REFUTED" : "CONFIRMED") on this OS")
