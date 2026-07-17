// swift-tools-version:5.10
import PackageDescription

/// GhosttyKit.xcframework is a **build output**, not checked in.
/// Produce it with `scripts/build-ghosttykit.sh` from the repo root, then:
///   ln -sfn ../.cache/native/artifacts/ghostty-<commit>-zig-<sha>/GhosttyKit.xcframework \
///     workspace/Vendor/GhosttyKit.xcframework
/// The path below is the stable SPM binary-target location.
let ghosttyKitPath = "Vendor/GhosttyKit.xcframework"

let package = Package(
    name: "HiveWorkspace",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "HiveWorkspace", targets: ["HiveWorkspace"]),
        .library(name: "WorkspaceCore", targets: ["WorkspaceCore"]),
        .library(name: "HiveTerminalKit", targets: ["HiveTerminalKit"]),
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
        // WP5 L0–L2: Ghostty manual-I/O surface wrapper (binary is offline-built).
        .binaryTarget(
            name: "GhosttyKit",
            path: ghosttyKitPath
        ),
        .target(
            name: "HiveTerminalKit",
            dependencies: [
                "GhosttyKit",
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
            dependencies: ["HiveTerminalKit"]
        ),
    ]
)
