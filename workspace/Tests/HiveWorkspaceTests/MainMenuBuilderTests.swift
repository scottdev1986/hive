// MainMenuBuilderTests.swift
//
// Guards the application menu against surfaces that have no honest daemon
// contract.

import AppKit
import XCTest
@testable import HiveWorkspace

@MainActor
final class MainMenuBuilderTests: XCTestCase {

    func testAutonomyHasNoMenuOrAction() {
        _ = NSApplication.shared
        let menu = MainMenuBuilder.build()
        let items = menu.items.flatMap { $0.submenu?.items ?? [] }

        XCTAssertFalse(menu.items.contains { $0.submenu?.title == "Agents" })
        XCTAssertFalse(items.contains { $0.title.contains("Autonomy") })
    }
}
