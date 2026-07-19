// swift-tools-version:5.10
import PackageDescription

/// GhosttyKit.xcframework is a **build output**, not checked in.
/// Produce it with `scripts/build-ghosttykit.sh` from the repo root, then materialize:
///   workspace/Vendor/GhosttyKit.xcframework  (libghostty.a + Headers; see build notes)
let ghosttyKitPath = "Vendor/GhosttyKit.xcframework"

let package = Package(
    name: "HiveWorkspace",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "HiveWorkspace", targets: ["HiveWorkspace"]),
        .library(name: "WorkspaceCore", targets: ["WorkspaceCore"]),
        .library(name: "HiveTerminalKit", targets: ["HiveTerminalKit"]),
        .executable(name: "GhosttyManualIsolationProbe", targets: ["GhosttyManualIsolationProbe"]),
        .executable(name: "GhosttyGate10Probe", targets: ["GhosttyGate10Probe"]),
        .executable(name: "HiveTerminalB20Probe", targets: ["HiveTerminalB20Probe"]),
    ],
    dependencies: [
        // Provides LocalProcessTerminalView, the AppKit terminal view that
        // spawns a child process on a pty. Pinned to v1.11.2, the newest
        // release WITHOUT the Metal GPU backend (added in v1.12.0): its
        // Shaders.metal resource makes `swift build --arch arm64 --arch
        // x86_64` (the release-bundle build) require the optional Metal
        // toolchain component, which Xcode 26 machines/CI runners often lack
        // or have version-mismatched. The CPU/CoreGraphics renderer is all a
        // TUI multiplexer needs.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.11.2"),
    ],
    targets: [
        .target(name: "WorkspaceCore"),
        // WP5 L0: GhosttyKit binary (offline-built) + authoritative C ABI header target.
        .binaryTarget(
            name: "GhosttyKit",
            path: ghosttyKitPath
        ),
        // C ABI surface for the seven _v1 symbols. `include/hive_ghostty_bridge.h` is a
        // symlink to repo-root `native/include/hive_ghostty_bridge.h` (one file pins
        // both halves — same pattern as Fixtures sharing the daemon wire doc).
        // HeaderParityTests fails closed if that link ever becomes a drifting fork.
        .target(
            name: "HiveGhosttyC",
            dependencies: ["GhosttyKit"],
            path: "Sources/HiveGhosttyC",
            publicHeadersPath: "include"
        ),
        .target(
            name: "HiveTerminalKit",
            dependencies: [
                "GhosttyKit",
                "HiveGhosttyC",
            ],
            path: "Sources/HiveTerminalKit",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreText"),
                .linkedFramework("Carbon"),
                .linkedFramework("IOKit"),
                .linkedLibrary("c++"),
            ]
        ),
        .executableTarget(
            name: "HiveWorkspace",
            dependencies: [
                "WorkspaceCore",
                "HiveTerminalKit",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            // Official vendor marks for the Model Control Center. The release
            // build copies the generated resource bundle into the .app
            // (src/release/build.ts), so keep the directory `.copy`-stable.
            resources: [.copy("Resources/VendorMarks")]
        ),
        .testTarget(
            name: "WorkspaceCoreTests",
            dependencies: ["WorkspaceCore"],
            // The daemon's real wire document, shared with the daemon-side
            // contract test (src/schemas/routing-policy.wire-contract.test.ts)
            // so one file pins both halves of the schema.
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "HiveWorkspaceTests",
            dependencies: ["HiveWorkspace", "WorkspaceCore"]
        ),
        .testTarget(
            name: "HiveTerminalKitTests",
            dependencies: ["HiveTerminalKit", "HiveGhosttyC"]
        ),
        .executableTarget(
            name: "GhosttyManualIsolationProbe",
            // Isolation probe talks only the C bridge + AppKit host view; it must
            // not pull HiveTerminalKit (and the Gate-10 snapshot symbol) so a
            // six-or-seven-symbol kit can both qualify Gate 1.
            dependencies: ["HiveGhosttyC"],
            path: "Tests/GhosttyManualIsolationProbe",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreText"),
                .linkedFramework("Carbon"),
                .linkedFramework("IOKit"),
                .linkedLibrary("c++"),
            ]
        ),
        .executableTarget(
            name: "GhosttyGate10Probe",
            dependencies: ["HiveTerminalKit", "HiveGhosttyC"],
            path: "Tests/GhosttyGate10Probe"
        ),
        // B2.0 boundary probe: deliberately cannot import HiveGhosttyC or
        // GhosttyKit. It drives only Workspace-visible Hive value types.
        .executableTarget(
            name: "HiveTerminalB20Probe",
            dependencies: ["HiveTerminalKit"],
            path: "Tests/HiveTerminalB20Probe"
        ),
    ]
)
