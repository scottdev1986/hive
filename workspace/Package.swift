// swift-tools-version:5.10
import Foundation
import PackageDescription

/// GhosttyKit.xcframework is a **build output**, not checked in.
/// Materialize it with `scripts/native/stage-ghosttykit.sh` from the repo root
/// before running SwiftPM.
let ghosttyKitPath = "Vendor/GhosttyKit.xcframework"
let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let ghosttyKitInfo = packageRoot.appendingPathComponent("\(ghosttyKitPath)/Info.plist")

if !FileManager.default.fileExists(atPath: ghosttyKitInfo.path) {
    fatalError("""
    Hive Workspace native inputs are not staged: \(ghosttyKitPath)/Info.plist.
    From the repository root, run scripts/native/stage-ghosttykit.sh before SwiftPM.
    """)
}

let package = Package(
    name: "HiveWorkspace",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "HiveWorkspace", targets: ["HiveWorkspaceApp"]),
        .executable(name: "HiveWorkspaceQA", targets: ["HiveWorkspaceQA"]),
        .library(name: "WorkspaceCore", targets: ["WorkspaceCore"]),
        .library(name: "HiveTerminalKit", targets: ["HiveTerminalKit"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "WorkspaceCore",
            dependencies: ["HiveTerminalKit"]
        ),
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
            resources: [.copy("GhosttyConfig")],
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
        .target(
            name: "HiveWorkspace",
            dependencies: [
                "WorkspaceCore",
                "HiveTerminalKit",
            ],
            resources: [.copy("Resources/VendorMarks")]
        ),
        .executableTarget(
            name: "HiveWorkspaceApp",
            dependencies: ["HiveWorkspace"]
        ),
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
            dependencies: ["HiveTerminalKit"]
        ),
    ]
)
