// WorkspaceShellLaunchTests.swift
//
// Proves fixture and live sources are explicit, mutually distinguishable
// launch choices. Neither choice can silently fall back to the other, and the
// shipped app — which installs no fixture loader — cannot be argued into
// fixtures at all.

import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

final class WorkspaceShellLaunchTests: XCTestCase {
    private func fixtureLoader() -> FixtureShellLoader {
        { _ in ShellState() }
    }

    func testFixtureSourceRequiresItsDirectory() {
        XCTAssertNil(ShellFixtureStore.launchDirectory(arguments: ["--workspace-shell"]))
        XCTAssertEqual(
            ShellFixtureStore.launchDirectory(
                arguments: ["--workspace-shell", "/tmp/corpus"]),
            "/tmp/corpus")
    }

    func testWithoutAFixtureLoaderTheShellUsesTheLiveDaemon() {
        XCTAssertTrue(WorkspaceShellLaunch(
            arguments: ["--workspace-shell", "/tmp/corpus"], fixtureState: nil).isLive)
    }

    func testAFixtureLoaderLaunchesTheShellAgainstFixtures() {
        let launch = WorkspaceShellLaunch(
            arguments: ["--workspace-shell", "/tmp/corpus"],
            fixtureState: fixtureLoader())
        XCTAssertFalse(launch.isLive)
    }

    func testLiveSourceIsAnExplicitDifferentFlag() {
        let launch = WorkspaceShellLaunch(
            arguments: ["--workspace-shell-live"], fixtureState: nil)
        XCTAssertTrue(launch.isLive)
        XCTAssertTrue(WorkspaceShellLaunch(arguments: [], fixtureState: nil).isLive)
    }

    /// Asking for both is a contradiction, and it resolves to the daemon. A
    /// launch that named the live daemon never quietly renders a frozen corpus.
    func testLiveWinsWhenAnInvocationAsksForBoth() {
        let launch = WorkspaceShellLaunch(
            arguments: ["--workspace-shell", "/tmp/corpus", "--workspace-shell-live"],
            fixtureState: fixtureLoader())
        XCTAssertTrue(launch.isLive)
    }

    /// Fullscreen belongs to the screenshot tour, not to anyone who opens the
    /// shell. A launch that does not ask for it must not get it.
    func testFullscreenIsOffUnlessItsFlagIsPresent() {
        XCTAssertEqual(
            WorkspaceShellLaunch(
                arguments: ["--workspace-shell", "/tmp/corpus"],
                fixtureState: fixtureLoader()).fullscreen,
            false)
        XCTAssertEqual(
            WorkspaceShellLaunch(
                arguments: ["--workspace-shell-live"], fixtureState: nil).fullscreen,
            false)
    }

    func testFullscreenIsOnOnlyWithItsFlag() {
        XCTAssertEqual(
            WorkspaceShellLaunch(
                arguments: [
                    "--workspace-shell", "/tmp/corpus", "--workspace-shell-fullscreen",
                ],
                fixtureState: fixtureLoader()).fullscreen,
            true)
        XCTAssertEqual(
            WorkspaceShellLaunch(
                arguments: ["--workspace-shell-live", "--workspace-shell-fullscreen"],
                fixtureState: nil).fullscreen,
            true)
    }

    func testFullscreenAloneKeepsTheDefaultLiveShell() {
        let launch = WorkspaceShellLaunch(
            arguments: ["--workspace-shell-fullscreen"], fixtureState: nil)
        XCTAssertTrue(launch.isLive)
        XCTAssertTrue(launch.fullscreen)
    }
}
