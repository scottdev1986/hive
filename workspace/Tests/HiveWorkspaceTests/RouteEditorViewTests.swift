import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class RouteEditorViewTests: XCTestCase {

    func testNoEffortMenuItemWritesAnExplicitNone() throws {
        _ = NSApplication.shared
        let root = repoRoot()
        let view = try currentModelControlView(root: root)
        let policy = try Data(contentsOf: root.appendingPathComponent(
            "workspace/Tests/WorkspaceCoreTests/Fixtures/routing-policy-wire.json"))
        var posted: Data?
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:4483")!,
            authorization: "Bearer fixture",
            loader: { request in
                if request.httpMethod == "POST" {
                    posted = request.httpBody
                    return (Data(), HTTPURLResponse(
                        url: request.url!, statusCode: 503, httpVersion: nil,
                        headerFields: nil)!)
                }
                let data = request.url!.path == "/routing/policy" ? policy : view
                return (data, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        let dataSource = ModelControlDataSource(
            hivePath: nil, daemonPort: nil, makeDaemonClient: { client })
        dataSource.refresh()
        waitForRefresh(dataSource)
        let editor = RouteSectionView(kind: .category(.simpleCoding), dataSource: dataSource)
        let popupItems = popups(in: editor).flatMap(\.itemArray)
        let item = try XCTUnwrap(
            popupItems.first { $0.title.contains("No effort setting") },
            "menu items: \(popupItems.map(\.title))")
        let menu = try XCTUnwrap(item.menu)
        let index = menu.index(of: item)

        menu.performActionForItem(at: index)

        XCTAssertEqual(
            dataSource.route(.simpleCoding)?.candidates.count, 2,
            "a click must not optimistically change the observed route")
        let deadline = Date().addingTimeInterval(2)
        while posted == nil, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        let body = try XCTUnwrap(posted.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })
        let route = try XCTUnwrap(body["route"] as? [String: Any])
        let candidates = try XCTUnwrap(route["candidates"] as? [[String: Any]])
        let effort = try XCTUnwrap(candidates.last?["effort"] as? [String: Any])
        XCTAssertEqual(effort["mode"] as? String, "none")
        XCTAssertEqual(candidates.last?["weight"] as? Int, 1)
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

    private func currentModelControlView(root: URL) throws -> Data {
        let corpus = root.appendingPathComponent(
            "workspace/Tests/WorkspaceCoreTests/Fixtures/model-control-corpus.json")
        let rows = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: corpus))
                as? [[String: Any]])
        let current = try XCTUnwrap(
            rows.first { $0["availability"] as? String == "current" })
        return try JSONSerialization.data(
            withJSONObject: try XCTUnwrap(current["value"]))
    }

    private func popups(in view: NSView) -> [NSPopUpButton] {
        ((view as? NSPopUpButton).map { [$0] } ?? [])
            + view.subviews.flatMap(popups)
    }
}
