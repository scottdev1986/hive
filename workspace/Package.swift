// swift-tools-version:5.10
import Foundation
import PackageDescription

/// GhosttyKit.xcframework is a **build output**, not checked in.
/// Materialize it and Gate 6's checkpoint fixtures with
/// `scripts/native/stage-ghosttykit.sh` from the repo root before running SwiftPM.
let ghosttyKitPath = "Vendor/GhosttyKit.xcframework"
let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let requiredStagedInputs = [
    "\(ghosttyKitPath)/Info.plist",
    "Vendor/checkpoint-fixtures",
]
let missingStagedInputs = requiredStagedInputs.filter {
    !FileManager.default.fileExists(atPath: packageRoot.appendingPathComponent($0).path)
}

if !missingStagedInputs.isEmpty {
    fatalError("""
    Hive Workspace native inputs are not staged: \(missingStagedInputs.joined(separator: ", ")).
    From the repository root, run scripts/native/stage-ghosttykit.sh before SwiftPM.
    """)
}

let package = Package(
    name: "HiveWorkspace",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "HiveWorkspace", targets: ["HiveWorkspaceApp"]),
        .executable(name: "HiveWorkspaceQA", targets: ["HiveWorkspaceQA"]),
        .library(name: "WorkspaceCore", targets: ["WorkspaceCore"]),
        .library(name: "HiveTerminalKit", targets: ["HiveTerminalKit"]),
        .executable(name: "GhosttyManualIsolationProbe", targets: ["GhosttyManualIsolationProbe"]),
        .executable(name: "GhosttyGate3Probe", targets: ["GhosttyGate3Probe"]),
        .executable(name: "GhosttyGate7Probe", targets: ["GhosttyGate7Probe"]),
        .executable(name: "GhosttyGate10Probe", targets: ["GhosttyGate10Probe"]),
        .executable(name: "HiveTerminalB20Probe", targets: ["HiveTerminalB20Probe"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "WorkspaceCore",
            dependencies: ["HiveTerminalKit"]
        ),
        // Offline-built GhosttyKit binary plus its authoritative C ABI header target.
        .binaryTarget(
            name: "GhosttyKit",
            path: ghosttyKitPath
        ),
        // C ABI surface for the seven _v1 symbols.
        // `include/hive_ghostty_bridge_module.h` is a symlink to repo-root
        // `native/include/hive_ghostty_bridge.h` (one file pins both halves).
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
        // The app itself is a library so that both executables below can link
        // it without duplicating a source file. It keeps this name because the
        // release build copies its resource bundle by the name SwiftPM derives
        // from the target (`HiveWorkspace_HiveWorkspace.bundle`).
        .target(
            name: "HiveWorkspace",
            dependencies: [
                "WorkspaceCore",
                "HiveTerminalKit",
            ],
            // Official vendor marks for the Model Control Center. The release
            // build copies the generated resource bundle into the .app
            // (src/release/build.ts), so keep the directory `.copy`-stable.
            resources: [.copy("Resources/VendorMarks")]
        ),
        // The shipped product: an entry point and nothing else. It installs no
        // QA hooks, which is what keeps the smoke checks and the fixture-corpus
        // shell out of the binary a user launches from the Dock.
        .executableTarget(
            name: "HiveWorkspaceApp",
            dependencies: ["HiveWorkspace"]
        ),
        // The QA harness. Nothing in the shipped product depends on this
        // target, so nothing in it links into the released .app.
        .target(
            name: "WorkspaceQAKit",
            dependencies: [
                "HiveWorkspace",
                "WorkspaceCore",
                "HiveTerminalKit",
            ]
        ),
        .executableTarget(
            name: "HiveWorkspaceQA",
            dependencies: [
                "HiveWorkspace",
                "WorkspaceQAKit",
            ]
        ),
        .testTarget(
            name: "WorkspaceCoreTests",
            dependencies: ["WorkspaceCore"],
            // The daemon and Workspace tests share these fixtures so one file
            // pins both halves of the wire schema.
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "HiveWorkspaceTests",
            dependencies: [
                "HiveWorkspace", "WorkspaceQAKit", "HiveTerminalKit", "WorkspaceCore",
            ]
        ),
        .testTarget(
            name: "HiveTerminalKitTests",
            dependencies: ["HiveTerminalKit", "HiveGhosttyC"]
        ),
        .executableTarget(
            name: "GhosttyManualIsolationProbe",
            // Isolation probe talks only the C bridge + AppKit host view; it must
            // not pull HiveTerminalKit (and the Gate-10 snapshot symbol) so a
            // a kit exposing either bridge generation can qualify.
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
            name: "GhosttyGate3Probe",
            dependencies: ["HiveTerminalKit", "HiveGhosttyC"],
            path: "Tests/GhosttyGate3Probe"
        ),
        .executableTarget(
            name: "GhosttyGate7Probe",
            dependencies: ["HiveTerminalKit", "HiveGhosttyC"],
            path: "Tests/GhosttyGate7Probe",
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
        // This boundary probe deliberately cannot import HiveGhosttyC or
        // GhosttyKit; it drives only Workspace-visible Hive value types.
        .executableTarget(
            name: "HiveTerminalB20Probe",
            dependencies: ["HiveTerminalKit"],
            path: "Tests/HiveTerminalB20Probe"
        ),
    ]
)
