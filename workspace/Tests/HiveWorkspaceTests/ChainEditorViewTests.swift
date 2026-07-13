import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class ChainEditorViewTests: XCTestCase {

    func testNoEffortMenuItemWritesAnExplicitNone() throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let fixture = repoRoot()
            .appendingPathComponent("test/fixtures/model-control-snapshot.json")
        let hive = root.appendingPathComponent("hive")
        try """
            #!/bin/sh
            if [ "$1" = "model-control-snapshot" ]; then
              cat "\(fixture.path)"
            else
              exit 9
            fi
            """.write(to: hive, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: hive.path)

        let dataSource = ModelControlDataSource(hivePath: hive.path, daemonPort: 4483)
        dataSource.refresh()
        waitForRefresh(dataSource)
        let editor = ChainSectionView(kind: .category(.simpleCoding), dataSource: dataSource)
        let popupItems = popups(in: editor).flatMap(\.itemArray)
        let item = try XCTUnwrap(
            popupItems.first { $0.title.contains("no effort setting") },
            "menu items: \(popupItems.map(\.title))")
        let menu = try XCTUnwrap(item.menu)
        let index = menu.index(of: item)

        menu.performActionForItem(at: index)

        let entry = try XCTUnwrap(dataSource.chainEntries(.simpleCoding).last)
        XCTAssertEqual(entry.effort, .some(EffortTarget.none))
    }

    private func waitForRefresh(_ dataSource: ModelControlDataSource) {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if case .loading = dataSource.loadState {
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            } else {
                return
            }
        }
        XCTFail("model-control refresh did not settle")
    }

    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func popups(in view: NSView) -> [NSPopUpButton] {
        ((view as? NSPopUpButton).map { [$0] } ?? [])
            + view.subviews.flatMap(popups)
    }
}
