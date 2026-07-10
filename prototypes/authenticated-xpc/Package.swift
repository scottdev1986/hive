// swift-tools-version: 6.0
import PackageDescription

// Swift 5 language mode: the prototype's subject is XPC peer authentication and
// capability authorization, not actor isolation. NSXPCListenerDelegate callbacks
// arrive on private queues and the registry is lock-guarded.
let package = Package(
    name: "authenticated-xpc",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "HiveCapability", swiftSettings: [.swiftLanguageMode(.v5)]),
        .target(
            name: "HiveXPCProtocol",
            dependencies: ["HiveCapability"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "hive-proto-server",
            dependencies: ["HiveCapability", "HiveXPCProtocol"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "hive-proto-peer",
            dependencies: ["HiveCapability", "HiveXPCProtocol"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "hive-proto-fdtest",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "HiveCapabilityTests",
            dependencies: ["HiveCapability"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
