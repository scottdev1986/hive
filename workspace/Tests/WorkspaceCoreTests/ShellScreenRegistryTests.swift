// ShellScreenRegistryTests.swift
//
// The registry's whole guarantee, walked: one declaration per screen, and route,
// sidebar, menu and renderer all derived from it. The four surfaces used to
// decide availability separately and disagreed — one screen was filtered out of
// the sidebar while another with the same missing contract stayed visible — so
// these assertions are about the surfaces AGREEING, not about any one of them
// being right.

import XCTest
@testable import WorkspaceCore

final class ShellScreenRegistryTests: XCTestCase {

    /// Screens whose owning service cannot supply an honest contract. They are
    /// absent because nothing declares them; if one is ever declared again, it
    /// must come with its evidence, and this fails first.
    static let settledOmissions = ["tokens", "autonomy"]

    func testEveryDeclaredScreenIsDeclaredExactlyOnce() {
        let routes = ShellScreenRegistry.screens.map(\.route)
        XCTAssertEqual(
            routes.count, Set(routes).count,
            "a screen declared twice could disagree with itself")
        let commands = ShellScreenRegistry.screens.map(\.command)
        XCTAssertEqual(
            commands.count, Set(commands).count,
            "two screens sharing one menu command would make one unreachable")
        let titles = ShellScreenRegistry.screens.map(\.title)
        XCTAssertEqual(titles.count, Set(titles).count)
        for screen in ShellScreenRegistry.screens {
            XCTAssertFalse(screen.title.isEmpty, "\(screen.route) needs a title")
        }
    }

    /// The route enum, the sidebar and the registry are one inventory. A screen
    /// cannot be routable but missing from the sidebar, which is the exact shape
    /// of the defect this registry replaces.
    func testRouteSidebarAndRegistryAreTheSameInventory() {
        XCTAssertEqual(
            Set(ShellRoute.allCases),
            Set(ShellScreenRegistry.screens.map(\.route)))
        let sidebar = ShellScreenRegistry.groups.flatMap { $0.routes }
        XCTAssertEqual(
            sidebar, ShellScreenRegistry.screens.map(\.route),
            "the sidebar shows every declared screen, in declaration order")
        XCTAssertEqual(
            Set(sidebar), Set(ShellRoute.allCases),
            "no screen is routable but unreachable from the sidebar")
        for route in ShellRoute.allCases {
            XCTAssertTrue(
                route.navGroup.routes.contains(route),
                "\(route) must appear in its own nav group")
            XCTAssertEqual(route.title, ShellScreenRegistry.declaration(for: route).title)
        }
    }

    /// Every screen is nameable in a menu, and every menu command that claims a
    /// destination names a screen that exists.
    func testEveryScreenHasOneMenuCommandAndEveryRouteCommandNamesAScreen() {
        for screen in ShellScreenRegistry.screens {
            guard case .route(let route) = screen.command.resolution else {
                return XCTFail("\(screen.route)'s menu command is not a destination")
            }
            XCTAssertEqual(
                route, screen.route,
                "\(screen.command) is declared for \(screen.route) but goes to \(route)")
        }
        for command in ShellCommand.allCases {
            guard case .route(let route) = command.resolution else { continue }
            XCTAssertTrue(
                ShellScreenRegistry.screens.contains { $0.route == route },
                "\(command) names a screen the shell does not declare")
        }
    }

    /// A menu label must name where it goes. "Settings…" resolving to Task Router
    /// is the defect this pins: the destination's own title has to appear in the
    /// command that reaches it.
    func testEveryScreenCommandIsTitledForItsDestination() {
        for screen in ShellScreenRegistry.screens {
            let title = screen.command.title
            XCTAssertFalse(
                title.hasSuffix("…"),
                "\(title) promises a dialog but navigates to \(screen.route)")
            let shortest = screen.title.replacingOccurrences(of: "Memory ", with: "")
            XCTAssertTrue(
                screen.title.contains(title) || title.contains(shortest),
                "\(screen.command) is labelled \(title) but goes to \(screen.title)")
        }
    }

    func testASettledOmissionIsNotAScreenOnAnySurface() {
        for omitted in Self.settledOmissions {
            XCTAssertFalse(
                ShellRoute.allCases.contains { $0.rawValue == omitted },
                "\(omitted) must not be a route")
            XCTAssertFalse(
                ShellScreenRegistry.screens.contains { $0.route.rawValue == omitted },
                "\(omitted) must not be declared")
            XCTAssertFalse(
                ShellScreenRegistry.groups.flatMap({ $0.routes })
                    .contains { $0.rawValue == omitted },
                "\(omitted) must not reach the sidebar")
            for command in ShellCommand.allCases {
                guard case .route(let route) = command.resolution else { continue }
                XCTAssertNotEqual(
                    route.rawValue, omitted,
                    "\(command) must not name the omitted screen \(omitted)")
            }
        }
        // The positive control: the same searches DO find a screen that exists,
        // so the absences above are facts rather than a reader that finds nothing.
        XCTAssertTrue(ShellRoute.allCases.contains { $0.rawValue == "memory-overview" })
        XCTAssertTrue(
            ShellScreenRegistry.groups.flatMap({ $0.routes })
                .contains { $0.rawValue == "memory-overview" })
    }

    /// The emitted list IS the declarations. A QA leg that parses this must get
    /// every declared screen and nothing else, or it has a copy of the slugs
    /// again — which is the defect that let two QA lists drift apart.
    func testTheEmittedScreenListIsExactlyTheDeclarations() throws {
        let lines = ShellScreenRegistry.proofLines
        XCTAssertEqual(lines.count, ShellScreenRegistry.screens.count)

        var parsed: [(slug: String, command: String, group: String, title: String)] = []
        for line in lines {
            XCTAssertTrue(line.hasPrefix(ShellScreenRegistry.proofPrefix), line)
            let fields = line
                .dropFirst(ShellScreenRegistry.proofPrefix.count)
                .components(separatedBy: ShellScreenRegistry.proofFieldSeparator)
            XCTAssertEqual(fields.count, 4, "a consumer cuts exactly four fields: \(line)")
            for field in fields {
                XCTAssertFalse(field.isEmpty, "an empty field would parse as a screen")
                XCTAssertFalse(
                    field.contains(ShellScreenRegistry.proofFieldSeparator),
                    "a field carrying the separator would split into a phantom screen")
            }
            parsed.append((fields[0], fields[1], fields[2], fields[3]))
        }

        XCTAssertEqual(
            parsed.map(\.slug), ShellScreenRegistry.screens.map(\.route.rawValue))
        XCTAssertEqual(
            parsed.map(\.command), ShellScreenRegistry.screens.map(\.command.rawValue))
        XCTAssertEqual(
            parsed.map(\.title), ShellScreenRegistry.screens.map(\.title))
        XCTAssertEqual(
            Set(parsed.map(\.slug)), Set(ShellRoute.allCases.map(\.rawValue)),
            "the emitted slugs are the routes, so an untourable screen cannot exist")
        for omitted in Self.settledOmissions {
            XCTAssertFalse(
                parsed.contains { $0.slug == omitted },
                "\(omitted) must not be emitted as a tourable screen")
        }
    }

    /// The terminator is what makes a partial run detectable: a consumer that
    /// requires it cannot read success out of a run that printed some screens
    /// and then died.
    func testTheProofTerminatorCarriesTheCountAConsumerMustCheck() {
        let terminator = ShellScreenRegistry.proofTerminator
        XCTAssertEqual(
            terminator, "SHELL-PROOF-END screens=\(ShellScreenRegistry.screens.count)")
        XCTAssertFalse(
            terminator.hasPrefix(ShellScreenRegistry.proofPrefix),
            "the terminator must not parse as one more screen")
        // A truncated emission has fewer screen lines than the terminator claims,
        // which is exactly the discrepancy a consumer is required to notice.
        let truncated = ShellScreenRegistry.proofLines.dropLast()
        XCTAssertNotEqual(
            truncated.count, ShellScreenRegistry.screens.count,
            "a short run must not agree with the terminator's count")
    }

    /// No surface may carry a per-screen exception. The sidebar shows what is
    /// declared, so there is nothing to skip and nowhere to keep a skip list.
    func testNoNavGroupRendersWithoutAScreen() {
        for group in ShellScreenRegistry.groups {
            XCTAssertFalse(
                group.routes.isEmpty,
                "\(group) would render as an empty heading")
        }
        let declaredGroups = Set(ShellScreenRegistry.screens.map(\.group))
        XCTAssertEqual(
            Set(ShellScreenRegistry.groups), declaredGroups,
            "a group is shown exactly when a declared screen is in it")
    }
}
