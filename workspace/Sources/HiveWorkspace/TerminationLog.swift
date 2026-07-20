import Foundation
import os

/// Why this process ended, written where the decision is made so an incident
/// investigator can tell a deliberate quit from a self-inflicted one.
///
/// `NSLog` cannot carry this. Its unified-log entries arrive with an empty
/// subsystem, an empty category, and an `eventMessage` of `<private>` — the
/// text is redacted, so no `log show` predicate can match on it or read it
/// back. An empty result from such a query means "blind reader", not "the
/// event did not happen", which is exactly the false confidence this exists to
/// remove. `os_log` under an explicit subsystem, with every interpolation
/// marked `.public`, round-trips:
///
///     /usr/bin/log show --predicate 'subsystem == "dev.hive.workspace"'
///
/// Use the absolute path: `log` is a shell builtin in zsh and shadows it.
///
/// The subsystem is a constant, deliberately not the bundle identifier: one
/// query has to find the installed app and an agent's debug build alike.
///
/// Absence is itself evidence. Every in-app route to exit records a line
/// first, so a process that vanishes with no `hive-terminate` line at all was
/// killed from outside (a signal — `pkill`, SIGKILL, a crash), not by its own
/// code.
enum TerminationLog {

    static let subsystem = "dev.hive.workspace"
    static let category = "lifecycle"

    /// One case per way this process can end. Raw values are the greppable
    /// tokens an investigator matches on, so they are stable API.
    enum Reason: String {
        /// The feed could not be restarted within its budget; the app quit
        /// itself. `AppDelegate.terminateAfterFeedFailure`.
        case feedFailure = "feed-failure"
        /// The last window closed and no UI surface was left to own the
        /// instance. `applicationShouldTerminateAfterLastWindowClosed`.
        case lastWindowClosed = "last-window-closed"
        /// An in-process quit nothing else claimed: Cmd-Q or the Quit menu
        /// item.
        case userQuit = "user-quit"
        /// A quit Apple Event: Dock "Quit", `osascript`, logout, restart.
        case appleEventQuit = "apple-event-quit"
        /// `--smoke` was given an invocation it cannot run.
        case smokeInvalidInvocation = "smoke-invalid-invocation"
        /// A `--smoke` harness run finished and exited with its verdict.
        case smokeFinished = "smoke-finished"
    }

    /// Where in the termination sequence the line was written. A quit is not
    /// one event: AppKit asks, the app answers — possibly `.terminateLater` —
    /// and the real exit happens after that answer resolves, or never, if the
    /// answer was cancelled.
    enum Phase: String {
        /// Something inside the app decided this process should end. The
        /// earliest and most load-bearing line.
        case requested
        /// `applicationShouldTerminate` answered AppKit. `detail` carries the
        /// reply, including `terminateLater`.
        case decision
        /// A deferred (`terminateLater`) quit resolved — allowed, or cancelled
        /// and the app is still alive.
        case resolved
        /// `applicationWillTerminate`: AppKit is committed, teardown running.
        case willTerminate = "will-terminate"
        /// A direct `exit()` that never reaches the AppKit sequence.
        case exiting
    }

    private static let log = Logger(subsystem: subsystem, category: category)

    /// One line shape for every phase, so a single grep finds the whole
    /// sequence: `hive-terminate phase=<p> reason=<r> detail=<d>`.
    static func record(_ phase: Phase, reason: Reason?, detail: String) {
        log.log("""
            hive-terminate phase=\(phase.rawValue, privacy: .public) \
            reason=\(reason?.rawValue ?? "unrecorded", privacy: .public) \
            detail=\(detail, privacy: .public)
            """)
    }
}
