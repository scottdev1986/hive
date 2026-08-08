import Foundation
import XCTest
@testable import HiveWorkspace

@MainActor
final class ModelControlDaemonReadTests: XCTestCase {

    func testSettingsReadsOnlyDaemonProjections() async throws {
        let root = repoRoot()
        let view = try currentModelControlView(root: root)
        var paths: [String] = []
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:4483")!,
            authorization: "Bearer fixture",
            loader: { request in
                paths.append(request.url!.path)
                return (view, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        let dataSource = ModelControlDataSource(
            hivePath: nil, daemonPort: nil,
            makeDaemonClient: { client })

        dataSource.refresh()
        try await waitForLoad(dataSource)

        guard case .loaded = dataSource.loadState else {
            return XCTFail("daemon-backed Settings refresh did not load")
        }
        XCTAssertEqual(Set(paths), ["/model-control/snapshot"])
        XCTAssertEqual(dataSource.snapshot?.providerIDs.count, 5)
        guard case .daemon? = dataSource.backend else {
            return XCTFail("routing policy did not come from the daemon")
        }
    }

    func testSettingsWritesPolicyDirectlyToDaemon() async throws {
        let root = repoRoot()
        var viewObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: currentModelControlView(root: root))
                as? [String: Any])
        var routing = try XCTUnwrap(viewObject["routing"] as? [String: Any])
        var policyObject = try XCTUnwrap(routing["policy"] as? [String: Any])
        var policy = try JSONSerialization.data(withJSONObject: policyObject)
        var view = try JSONSerialization.data(withJSONObject: viewObject)
        var posted: Data?
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:4483")!,
            authorization: "Bearer fixture",
            loader: { request in
                if request.httpMethod == "POST" {
                    posted = request.httpBody
                    var providers = policyObject["providers"] as! [String: String]
                    providers["grok"] = "enabled"
                    policyObject["providers"] = providers
                    policyObject["revision"] = 7
                    policy = try JSONSerialization.data(withJSONObject: policyObject)
                    routing["policy"] = policyObject
                    var presentedProviders = routing["providers"] as! [String: Any]
                    presentedProviders["grok"] = ["state": "enabled"]
                    routing["providers"] = presentedProviders
                    viewObject["routing"] = routing
                    view = try JSONSerialization.data(withJSONObject: viewObject)
                    return (Data(), HTTPURLResponse(
                        url: request.url!, statusCode: 200, httpVersion: nil,
                        headerFields: ["x-hive-operation-id": "operation-1"])!)
                }
                let data = request.url!.path == "/routing/policy" ? policy : view
                return (data, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        let dataSource = ModelControlDataSource(
            hivePath: nil, daemonPort: nil,
            makeDaemonClient: { client })
        dataSource.refresh()
        try await waitForLoad(dataSource)

        dataSource.setProviderEnabled(.grok, true)
        XCTAssertFalse(
            dataSource.providerMasterOn(.grok),
            "the client must not optimistically apply the requested state")
        let deadline = Date().addingTimeInterval(2)
        while dataSource.backendRevision != 7, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        let body = try XCTUnwrap(posted.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })
        XCTAssertEqual(body["op"] as? String, "set-provider")
        XCTAssertEqual(body["expectedRevision"] as? Int, 6)
        XCTAssertEqual(body["provider"] as? String, "grok")
        XCTAssertEqual(body["state"] as? String, "enabled")
        guard case .daemon(let document)? = dataSource.backend else {
            return XCTFail("policy write did not retain the daemon backend")
        }
        XCTAssertEqual(document.revision, 7)
        XCTAssertTrue(dataSource.providerMasterOn(.grok))
    }

    private func waitForLoad(_ dataSource: ModelControlDataSource) async throws {
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if case .loading = dataSource.loadState {
                try await Task.sleep(for: .milliseconds(10))
            } else {
                return
            }
        }
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
}

private extension ModelControlDataSource {
    var backendRevision: Int? {
        guard case .daemon(let document)? = backend else { return nil }
        return document.revision
    }
}
