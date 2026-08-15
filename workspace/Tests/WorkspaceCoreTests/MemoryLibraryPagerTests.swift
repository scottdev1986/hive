// MemoryLibraryPagerTests.swift
//
// Pins the library walk: a cursor is only ever replayed against the store that
// minted it, a page observed for another project starts that project's own walk
// instead of extending this one, and walking back truncates the trail rather
// than recording the same page twice.

import XCTest
@testable import WorkspaceCore

final class MemoryLibraryPagerTests: XCTestCase {

    private func page(
        _ ids: [String],
        nextCursor: String?,
        total: Int,
        revision: String = "memory-library-r1"
    ) throws -> MemoryLibraryProjection {
        let items = ids.map { id in
            """
            {"kind":"article","key":"article\\u0000repo\\u0000\(id)","scope":"repo",
             "id":"\(id)","title":"\(id)","topic":"memory","updated":"2026-07-30",
             "revision":"article-r1","source":"agent","status":"verified",
             "verified":"2026-07-30","supersedes":[],"rawRefs":[],
             "evidence":"pager fixture"}
            """
        }.joined(separator: ",")
        let cursor = nextCursor.map { "\"\($0)\"" } ?? "null"
        return try JSONDecoder().decode(
            MemoryLibraryProjection.self,
            from: Data("""
            {"schemaVersion":1,"observedAt":"2026-07-30T20:00:00.000Z",
             "sourceRevision":"\(revision)","freshness":"live","state":"ok",
             "items":[\(items)],"nextCursor":\(cursor),"total":\(total)}
            """.utf8))
    }

    func testAWalkForwardAndBackKeepsOneEntryPerPage() throws {
        let first = try page(["a1", "a2"], nextCursor: "c2", total: 6)
        var pager = MemoryLibraryPager(project: "alpha", page: first)
        XCTAssertEqual(pager.pageNumber, 1)
        XCTAssertNil(pager.previousStep)
        XCTAssertEqual(pager.nextStep, .cursor("c2"))

        pager.observe(
            try page(["a3", "a4"], nextCursor: "c3", total: 6),
            from: "alpha", step: .cursor("c2"))
        XCTAssertEqual(pager.pageNumber, 2)
        XCTAssertEqual(pager.previousStep, .first)
        XCTAssertEqual(pager.nextStep, .cursor("c3"))

        pager.observe(
            try page(["a5", "a6"], nextCursor: nil, total: 6),
            from: "alpha", step: .cursor("c3"))
        XCTAssertEqual(pager.pageNumber, 3)
        XCTAssertEqual(pager.previousStep, .cursor("c2"))
        XCTAssertNil(pager.nextStep, "an absent cursor is the end of the walk")

        // Walking back to a page already served truncates the trail instead of
        // appending a second entry for the same page.
        pager.observe(
            try page(["a3", "a4"], nextCursor: "c3", total: 6),
            from: "alpha", step: .cursor("c2"))
        XCTAssertEqual(pager.pageNumber, 2)
        XCTAssertEqual(pager.trail, [.first, .cursor("c2")])

        pager.observe(
            try page(["a1", "a2"], nextCursor: "c2", total: 6),
            from: "alpha", step: .first)
        XCTAssertEqual(pager.pageNumber, 1)
        XCTAssertEqual(pager.trail, [.first])
        XCTAssertEqual(pager.page.items.first?.display.id, "a1")
    }

    /// Two projects, two stores, two cursor spaces. A page served by beta's
    /// daemon must not extend alpha's walk, and beta's own first page must read
    /// as page one rather than inheriting alpha's depth.
    func testAPageFromAnotherProjectStartsItsOwnWalk() throws {
        var pager = MemoryLibraryPager(project: "alpha", page: try page(
            ["alpha-1"], nextCursor: "alpha-c2", total: 4))
        pager.observe(
            try page(["alpha-2"], nextCursor: "alpha-c3", total: 4),
            from: "alpha", step: .cursor("alpha-c2"))
        XCTAssertEqual(pager.pageNumber, 2, "positive control: alpha really walked")

        pager.observe(
            try page(["beta-1"], nextCursor: "beta-c2", total: 2, revision: "beta-r1"),
            from: "beta", step: .first)

        XCTAssertEqual(pager.project, "beta")
        XCTAssertEqual(pager.pageNumber, 1)
        XCTAssertEqual(pager.trail, [.first])
        XCTAssertEqual(pager.nextStep, .cursor("beta-c2"))
        XCTAssertEqual(pager.page.items.map { $0.display.id }, ["beta-1"])
        XCTAssertEqual(pager.page.total, 2, "beta's totals are beta's own")
    }

    /// The same replacement holds when the foreign page arrives mid-walk with a
    /// cursor of its own: alpha's trail must not gain beta's cursor.
    func testAForeignCursorNeverJoinsThisProjectsTrail() throws {
        var pager = MemoryLibraryPager(project: "alpha", page: try page(
            ["alpha-1"], nextCursor: "alpha-c2", total: 4))
        pager.observe(
            try page(["beta-2"], nextCursor: nil, total: 2, revision: "beta-r1"),
            from: "beta", step: .cursor("beta-c2"))

        XCTAssertEqual(pager.project, "beta")
        XCTAssertEqual(pager.trail, [.cursor("beta-c2")])
        XCTAssertFalse(pager.trail.contains(.cursor("alpha-c2")))
    }

    func testShellStateStartsAWalkOnceAndThenExtendsIt() throws {
        var state = ShellState()
        XCTAssertNil(state.memory.library)

        state.observe(
            libraryPage: try page(["a1"], nextCursor: "c2", total: 2),
            from: "alpha", step: .first)
        XCTAssertEqual(state.memory.library?.pageNumber, 1)

        state.observe(
            libraryPage: try page(["a2"], nextCursor: nil, total: 2),
            from: "alpha", step: .cursor("c2"))
        XCTAssertEqual(state.memory.library?.pageNumber, 2)
        XCTAssertEqual(state.memory.library?.page.items.first?.display.id, "a2")
    }

    /// A refresh that produced nothing keeps the values on screen. Dropping them
    /// would turn a refused read into an empty store, which is the one reading
    /// the Memory screens must never show.
    func testARefreshWithNoValuesKeepsTheObservedOnes() throws {
        var state = ShellState()
        state.observe(
            libraryPage: try page(["a1"], nextCursor: nil, total: 1),
            from: "alpha", step: .first)
        let held = try XCTUnwrap(state.memory.library)

        state.refresh(memory: MemoryScreensState())

        XCTAssertEqual(state.memory.library, held)
    }
}
