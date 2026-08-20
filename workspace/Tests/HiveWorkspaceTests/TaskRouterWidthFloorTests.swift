// TaskRouterWidthFloorTests.swift
//
// The Task Router's route cards carry five fixed columns plus a flexible
// model column. At the window's 940pt minimum the model column gives way;
// this pins that the window can actually be 940 and the cards still fill it.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

@MainActor
final class TaskRouterWidthFloorTests: XCTestCase {

    func testReportWhichViewOwnsTheHorizontalFloor() throws {
        _ = NSApplication.shared
        let denseDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures-dense")
            .path
        let controller = WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/Users/test/Projects/hive",
                instanceLabel: "instance · instance-fixture"),
            state: try ShellFixtureStore(directory: denseDirectory)
                .loadState(scenario: .current))
        defer { controller.window?.close() }
        guard let window = controller.window, let content = window.contentView else {
            return XCTFail("no window")
        }
        let router = try XCTUnwrap(
            find(content, "shell-nav-router") as? NSButton)
        router.performClick(nil)
        window.setContentSize(NSSize(width: 940, height: 560))
        window.layoutIfNeeded()

        let scroll = try XCTUnwrap(find(content, "shell-screen-scroll") as? NSScrollView)
        let document = try XCTUnwrap(scroll.documentView)
        let panel = try XCTUnwrap(document.subviews.first)
        var lines: [String] = [
            "window=\(window.frame.width) content=\(content.bounds.width)",
            "sidebar=\(Theme.Metric.sidebarWidth) scroll=\(scroll.frame.width)",
            "document=\(document.bounds.width) panel=\(panel.frame.width) fitting=\(panel.fittingSize.width)",
        ]
        walk(panel, prefix: "", into: &lines)
        XCTAssertEqual(window.frame.width, 940, accuracy: 1, lines.joined(separator: "\n"))
        XCTAssertEqual(panel.frame.width, document.bounds.width, accuracy: 1)
        XCTAssertNotNil(find(panel, "task-router-routes"))
        XCTAssertNotNil(find(panel, "task-router-card-light_research"))
        XCTAssertNotNil(find(panel, "task-router-row-complex_coding-claude/claude-opus-4-8"))
    }

    private func walk(_ view: NSView, prefix: String, into lines: inout [String]) {
        let raw = view.accessibilityIdentifier()
        let id = raw.isEmpty ? String(describing: type(of: view)) : raw
        let compression = view.contentCompressionResistancePriority(for: .horizontal)
        lines.append(
            "\(prefix)\(id) frame=\(fmt(view.frame.width)) "
                + "fitting=\(fmt(view.fittingSize.width)) "
                + "intrinsic=\(fmt(view.intrinsicContentSize.width)) "
                + "hug=\(view.contentHuggingPriority(for: .horizontal).rawValue) "
                + "resist=\(compression.rawValue)")
        guard prefix.count < 12 else { return }
        for sub in view.subviews {
            walk(sub, prefix: prefix + "  ", into: &lines)
        }
    }

    private func fmt(_ value: CGFloat) -> String {
        value == NSView.noIntrinsicMetric ? "none" : String(format: "%.1f", value)
    }

    private func find(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for subview in view.subviews {
            if let match = find(subview, identifier) { return match }
        }
        return nil
    }
}
