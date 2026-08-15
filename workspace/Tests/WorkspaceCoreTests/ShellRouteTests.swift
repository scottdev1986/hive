// ShellRouteTests.swift
//
// Pins the screen inventory: exactly the screens ShellScreenRegistry declares,
// each in exactly one nav group, and none of the retired destinations. A retired
// destination that compiles into the shell fails here before a menu can reach
// it. Tokens and Autonomy are retired rather than absent by accident: their
// services cannot supply an honest contract, so the screens do not exist.

import XCTest
@testable import WorkspaceCore

final class ShellRouteTests: XCTestCase {

    /// Destinations the transition deletes. If one ever compiles into the
    /// shell, these tests fail before a menu can reach it.
    static let retiredRouteIdentifiers = [
        "communications",
        "gates",
        "projects",
        "navigate",
        "review",
        "files",
        // Settled omissions: the owning service cannot supply an honest
        // contract, so the screen is absent from every surface by not being
        // declared at all.
        "tokens",
        "autonomy",
    ]

    func testTheRoutesAreExactlyTheDeclaredScreens() {
        XCTAssertEqual(
            Set(ShellRoute.allCases),
            [
                .liveRun, .taskRouter, .modelsQuota, .queen,
                .memoryOverview, .memoryLibrary, .memoryRecallLab,
                .memoryMaintenance,
            ])
        // The route enum and the registry are the same inventory, not two lists
        // that have to be kept in step.
        XCTAssertEqual(
            Set(ShellScreenRegistry.screens.map(\.route)), Set(ShellRoute.allCases))
        XCTAssertEqual(ShellScreenRegistry.screens.count, ShellRoute.allCases.count)
    }

    func testRouteIdentifiersMatchTheContractSlugs() {
        XCTAssertEqual(
            Set(ShellRoute.allCases.map(\.rawValue)),
            [
                "run", "router", "models", "queen",
                "memory-overview", "memory-library", "memory-recall",
                "memory-maintenance",
            ])
    }

    func testNoRetiredDestinationIsARoute() {
        for retired in Self.retiredRouteIdentifiers {
            XCTAssertFalse(
                ShellRoute.allCases.contains { $0.rawValue == retired },
                "retired destination \(retired) must never be a shell route")
        }
    }

    func testNavGroupsPartitionEveryRouteExactlyOnce() {
        let grouped = ShellNavGroup.allCases.flatMap(\.routes)
        XCTAssertEqual(
            grouped.count, ShellRoute.allCases.count,
            "every route appears in a nav group exactly once")
        XCTAssertEqual(Set(grouped), Set(ShellRoute.allCases))
        for route in ShellRoute.allCases {
            XCTAssertTrue(
                route.navGroup.routes.contains(route),
                "\(route) must belong to its own nav group")
        }
    }

    func testNavGroupOrderMatchesTheShellStructure() {
        XCTAssertEqual(
            ShellScreenRegistry.groups,
            [.workspace, .modelControl, .runtime, .memory])
        XCTAssertEqual(ShellNavGroup.workspace.routes, [.liveRun])
        XCTAssertEqual(
            ShellNavGroup.modelControl.routes, [.taskRouter, .modelsQuota])
        XCTAssertEqual(ShellNavGroup.runtime.routes, [.queen])
        XCTAssertEqual(
            ShellNavGroup.memory.routes,
            [.memoryOverview, .memoryLibrary, .memoryRecallLab, .memoryMaintenance])
    }

    func testEveryRouteHasADisplayTitle() {
        for route in ShellRoute.allCases {
            XCTAssertFalse(route.title.isEmpty, "\(route) needs a sidebar title")
        }
    }
}
