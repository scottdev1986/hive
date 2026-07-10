// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "HiveWorkspace",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "HiveWorkspace", targets: ["HiveWorkspace"]),
        .library(name: "WorkspaceCore", targets: ["WorkspaceCore"]),
    ],
    targets: [
        .target(name: "WorkspaceCore"),
        .executableTarget(
            name: "HiveWorkspace",
            dependencies: ["WorkspaceCore"]
        ),
        .testTarget(
            name: "WorkspaceCoreTests",
            dependencies: ["WorkspaceCore"]
        ),
    ]
)
