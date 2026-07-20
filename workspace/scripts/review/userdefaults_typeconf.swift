// hadley: does a WRONG-TYPE stored value crash the read path?
// hollis2 covers absent + unknown-string. The uncovered case is a value that
// is not a string at all -- Data, Array, Dict, Bool, Number.
import Foundation
let suite = "hive.hadley.typeconf.\(UUID().uuidString)"
let d = UserDefaults(suiteName: suite)!
let key = "hive.terminal.themeSelection"
enum Sel: String { case system, dark, light }

let cases: [(String, Any)] = [
    ("Data",   Data([0xff, 0x00, 0xfe])),
    ("Array",  ["dark", "light"]),
    ("Dict",   ["a": "dark"]),
    ("Bool",   true),
    ("Int",    42),
    ("Double", 3.14),
    ("empty",  ""),
]
for (name, value) in cases {
    d.set(value, forKey: key)
    // EXACTLY hollis2's read expression:
    let resolved = d.string(forKey: key).flatMap(Sel.init(rawValue:)) ?? .system
    print("  \(name.padding(toLength: 7, withPad: " ", startingAt: 0)) -> string(forKey:)=\(String(describing: d.string(forKey: key)))  resolved=\(resolved)")
}
d.removePersistentDomain(forName: suite)
print("  NO CRASH -- all wrong-type values fell back")
