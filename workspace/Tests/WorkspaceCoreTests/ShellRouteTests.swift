// ShellRouteTests.swift
//
// Pins the screen inventory: every routed screen appears in exactly one nav
// group, and none of the retired destinations. A retired destination that
// compiles into the shell fails here before a menu can reach it.

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
    ]

    func testExactlyTheRoutedContractScreensExist() {
        XCTAssertEqual(
            Set(ShellRoute.allCases),
            [
                .liveRun, .taskRouter, .modelsQuota, .tokens, .queen,
                .memoryOverview, .memoryLibrary, .memoryRecallLab,
                .memoryMaintenance,
            ])
        XCTAssertEqual(ShellRoute.allCases.count, 9)
    }

    func testRouteIdentifiersMatchTheContractSlugs() {
        XCTAssertEqual(
            Set(ShellRoute.allCases.map(\.rawValue)),
            [
                "run", "router", "models", "tokens", "queen",
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

    func testAutonomyIsNotARouteWithoutARevisionedDaemonProjection() {
        XCTAssertNil(ShellRoute(rawValue: "autonomy"))
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
            ShellNavGroup.allCases,
            [.workspace, .modelControl, .runtime, .memory])
        XCTAssertEqual(ShellNavGroup.workspace.routes, [.liveRun])
        XCTAssertEqual(
            ShellNavGroup.modelControl.routes, [.taskRouter, .modelsQuota, .tokens])
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
