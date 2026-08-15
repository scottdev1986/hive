// MemoryScreens.swift The observed values the four Memory screens render, and the walk state the Library page controls need. Everything here came from a daemon projection: the shell holds no memory of its own, so a screen with no projection renders nothing rather than a reconstruction.

import Foundation

/// Which page of the library to ask the daemon for. A cursor is minted by one
/// store and is meaningless to any other, so it is carried as a value rather
/// than assembled from a page number this client invented.
public enum MemoryLibraryStep: Equatable, Sendable {
    case first
    case cursor(String)
}

/// The library page on screen and the trail of steps that reached it, so Previous
/// re-asks the daemon for a page it already served rather than reconstructing one
/// locally.
public struct MemoryLibraryPager: Equatable, Sendable {
    /// The project whose daemon minted these cursors. Pagination is per store:
    /// a page observed for another project starts that project's own walk
    /// instead of extending this one.
    public private(set) var project: ProjectID
    public private(set) var page: MemoryLibraryProjection
    /// The step that produced each page reached so far, oldest first.
    public private(set) var trail: [MemoryLibraryStep]

    public init(
        project: ProjectID,
        page: MemoryLibraryProjection,
        step: MemoryLibraryStep = .first
    ) {
        self.project = project
        self.page = page
        self.trail = [step]
    }

    /// Takes one observed page. A page from a different project replaces the walk
    /// whole; re-walking to a step already in the trail truncates back to it
    /// rather than recording the same page twice.
    public mutating func observe(
        _ page: MemoryLibraryProjection,
        from project: ProjectID,
        step: MemoryLibraryStep
    ) {
        guard project == self.project else {
            self = MemoryLibraryPager(project: project, page: page, step: step)
            return
        }
        switch step {
        case .first:
            trail = [.first]
        case .cursor:
            if let index = trail.firstIndex(of: step) {
                trail.removeSubrange(trail.index(after: index)...)
            } else {
                trail.append(step)
            }
        }
        self.page = page
    }

    /// The step that re-asks for the page before this one, or nil on the first page.
    public var previousStep: MemoryLibraryStep? {
        trail.count > 1 ? trail[trail.count - 2] : nil
    }

    /// The step that asks for the page after this one, or nil when the daemon
    /// named no successor. An absent cursor is the end of the walk, never an
    /// invitation to guess one.
    public var nextStep: MemoryLibraryStep? {
        page.nextCursor.map { .cursor($0) }
    }

    /// Which page of the walk is on screen, counting from one.
    public var pageNumber: Int { trail.count }
}

/// The four Memory screens' observed values. Each is nil until its daemon read
/// produced one, and a nil renders as the screen's availability state rather
/// than as an empty store.
public struct MemoryScreensState: Equatable, Sendable {
    public var overview: MemoryOverviewProjection?
    /// Set only by `observe`, so every page on screen went through the walk's
    /// own rules rather than being assigned around them.
    public private(set) var library: MemoryLibraryPager?
    public var recall: MemoryRecallPreview?
    public var maintenance: MemoryMaintenanceProjection?

    public init(
        overview: MemoryOverviewProjection? = nil,
        library: MemoryLibraryPager? = nil,
        recall: MemoryRecallPreview? = nil,
        maintenance: MemoryMaintenanceProjection? = nil
    ) {
        self.overview = overview
        self.library = library
        self.recall = recall
        self.maintenance = maintenance
    }

    /// Takes one observed page. The first page of a project starts its walk;
    /// every later page goes through the pager, which decides whether it extends
    /// this walk or replaces it.
    public mutating func observe(
        page: MemoryLibraryProjection,
        from project: ProjectID,
        step: MemoryLibraryStep
    ) {
        if library == nil {
            library = MemoryLibraryPager(project: project, page: page, step: step)
        } else {
            library?.observe(page, from: project, step: step)
        }
    }
}
