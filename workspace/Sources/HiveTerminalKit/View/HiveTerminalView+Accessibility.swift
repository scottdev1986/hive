import AppKit
import Foundation
import HiveGhosttyC
import ObjectiveC

/// Accessibility (M1-B2.6 / Gate 10 AppKit slice).
///
/// Forward-ported from duncan's terminal accessibility work
/// (`943407ba` "Build atomic terminal accessibility snapshot") and adapted
/// onto the post-B2.4 HiveTerminalView surface: semantic rows/ranges/cursor/
/// selection from `ManualSurfaceSemanticSnapshotProviding`, selection-change
/// AX posting via `HiveTerminalActionNotification.selectionChanged` (explicitly
/// left unclaimed by the prior Gate 10 engine slice), lifecycle/failure
/// announcements, and row-element tree for VoiceOver navigation.
///
/// Engine exports (`semanticSnapshot()`) are single-lock; this adapter pins
/// one generation for consecutive AX getters until the next invalidate signal
/// (or an explicit `withPinnedSnapshot` read batch). It does **not** re-export
/// on every property access — that multi-export path produced torn dumps.
///
/// Live VoiceOver listening and Accessibility Inspector human audit remain
/// explicit human checklist slots (Gate 7 pattern) — not silent gaps.
/// Real `NSAccessibility.post` (see `post` below) is covered only by those
/// human slots; machine tests watch `notificationProbe` only.

private struct TerminalAccessibilitySignals: OptionSet {
    let rawValue: UInt8

    static let invalidate = Self(rawValue: 1 << 0)
    static let selection = Self(rawValue: 1 << 1)
    static let scroll = Self(rawValue: 1 << 2)
    static let geometry = Self(rawValue: 1 << 3)
    static let lifecycle = Self(rawValue: 1 << 4)
}

private final class TerminalAccessibilityRowElement: NSAccessibilityElement {
    weak var terminalParent: HiveTerminalView?
    var rowIndex = 0
    var value = ""
    var sharedRange = NSRange(location: 0, length: 0)
    var frameInParent = NSRect.zero

    init(parent: HiveTerminalView) {
        terminalParent = parent
        super.init()
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .staticText }
    override func accessibilityLabel() -> String? { "Terminal row \(rowIndex + 1)" }
    override func accessibilityValue() -> Any? { value }
    override func accessibilityParent() -> Any? { terminalParent }
    override func accessibilitySharedCharacterRange() -> NSRange { sharedRange }
    override var accessibilityNotifiesWhenDestroyed: Bool { true }

    override func accessibilityFrame() -> NSRect {
        guard let parent = terminalParent else { return .zero }
        let windowRect = parent.convert(frameInParent, to: nil)
        return parent.window?.convertToScreen(windowRect) ?? windowRect
    }
}

private final class TerminalAccessibilityController {
    weak var view: HiveTerminalView?
    private(set) var snapshot: ManualSurfaceSemanticSnapshot?
    private(set) var rows: [TerminalAccessibilityRowElement] = []
    var notificationProbe: ((NSAccessibility.Notification) -> Void)?
    private var notificationSnapshot: ManualSurfaceSemanticSnapshot?
    private var refreshScheduled = false
    private var pendingSignals: TerminalAccessibilitySignals = []
    private var lastFocused = false
    private var lastLifecycleDescription: String?
    /// When true, `currentSnapshot()` may re-export from the engine.
    /// Cleared after a successful refresh; set by schedule/destroy/size signals.
    private var cacheValid = false
    /// Nested pin depth: while > 0, getters share one generation and never re-export.
    private var pinDepth = 0
    private var dirtyWhilePinned = false

    init(view: HiveTerminalView) {
        self.view = view
        lastFocused = view.window?.firstResponder === view
        lastLifecycleDescription = view.accessibilityLifecycleDescription()
    }

    /// One pinned generation for a multi-property AX read (dump, batch assert).
    func withPinnedSnapshot<R>(_ body: () -> R) -> R {
        dispatchPrecondition(condition: .onQueue(.main))
        // Drop any deferred refresh so this pin is the sole export for the batch.
        refreshScheduled = false
        dirtyWhilePinned = false
        refresh(postNotifications: false)
        cacheValid = true
        pinDepth += 1
        defer {
            pinDepth -= 1
            if pinDepth == 0, dirtyWhilePinned {
                dirtyWhilePinned = false
                cacheValid = false
            }
        }
        return body()
    }

    /// Synchronous re-export (tests / post-mutation settle). Never call from a
    /// native Ghostty callback stack — same rule as `semanticSnapshot()`.
    func forceRefreshFromEngine() {
        dispatchPrecondition(condition: .onQueue(.main))
        refreshScheduled = false
        dirtyWhilePinned = false
        cacheValid = false
        refresh(postNotifications: false)
        cacheValid = true
    }

    func currentSnapshot() -> ManualSurfaceSemanticSnapshot? {
        dispatchPrecondition(condition: .onQueue(.main))
        // Pinned batch: never re-export mid-read (prevents torn flat-vs-children).
        if pinDepth > 0 {
            return snapshot
        }
        if !cacheValid {
            refresh(postNotifications: false)
            cacheValid = true
        }
        return snapshot
    }

    func schedule(_ signal: TerminalAccessibilitySignals) {
        dispatchPrecondition(condition: .onQueue(.main))
        pendingSignals.formUnion(signal)
        if pinDepth > 0 {
            dirtyWhilePinned = true
        } else {
            cacheValid = false
        }
        guard !refreshScheduled else { return }
        refreshScheduled = true
        // Always defer. A bridge INVALIDATE may be delivered while Ghostty is
        // still on a native callback stack; the semantic export's lock is
        // deliberately non-recursive and is never entered reentrantly.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.refreshScheduled = false
            self.refresh(postNotifications: true)
            self.pendingSignals = []
            if self.pinDepth == 0 {
                self.cacheValid = true
            }
        }
    }

    func focusDidChange() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let view else { return }
        let focused = view.window?.firstResponder === view
        guard focused != lastFocused else { return }
        lastFocused = focused
        guard view.window != nil else { return }
        post(element: view, notification: .focusedUIElementChanged)
    }

    func destroyRows() {
        for row in rows where row.terminalParent?.window != nil {
            post(element: row, notification: .uiElementDestroyed)
        }
        rows.removeAll()
        snapshot = nil
        notificationSnapshot = nil
        cacheValid = false
        dirtyWhilePinned = false
    }

    func frame(for range: NSRange) -> NSRect {
        guard let view, let snapshot = currentSnapshot() else { return .zero }
        guard Self.valid(range, upperBound: snapshot.textUTF16Length) else { return .zero }

        if range.length == 0,
           snapshot.cursor.isVisible,
           snapshot.cursor.utf16Offset == range.location {
            return screenFrame(parentFrame: cursorFrame(snapshot), in: view)
        }

        var union = NSRect.null
        for (index, row) in snapshot.visibleRows.enumerated() {
            let lineRange = NSRange(
                location: row.utf16Range.location,
                length: row.utf16Range.length + row.lineBreakUTF16Length
            )
            guard NSIntersectionRange(range, lineRange).length > 0 else { continue }
            let clipped = NSIntersectionRange(range, row.utf16Range)
            let frame = clipped.length > 0
                ? cellFrame(row: row, rowIndex: index, range: clipped, snapshot: snapshot)
                : rowFrame(rowIndex: index, snapshot: snapshot)
            union = union.isNull ? frame : union.union(frame)
        }
        guard !union.isNull else { return .zero }
        return screenFrame(parentFrame: union, in: view)
    }

    func range(at screenPoint: NSPoint) -> NSRange {
        guard let view, let snapshot = currentSnapshot(), !snapshot.visibleRows.isEmpty else {
            return NSRange(location: NSNotFound, length: 0)
        }
        let windowPoint = view.window?.convertPoint(fromScreen: screenPoint) ?? screenPoint
        let localPoint = view.convert(windowPoint, from: nil)
        for (index, row) in snapshot.visibleRows.enumerated() {
            guard rowFrame(rowIndex: index, snapshot: snapshot).contains(localPoint) else { continue }
            let backing = view.convertToBacking(NSRect(origin: localPoint, size: .zero)).origin
            let column = max(0, min(
                row.cellUTF16Offsets.count - 2,
                (Int(backing.x) - snapshot.geometry.paddingLeftPixels)
                    / max(1, snapshot.geometry.cellWidthPixels)
            ))
            let start = row.cellUTF16Offsets[column]
            let end = row.cellUTF16Offsets[column + 1]
            return NSRange(location: start, length: end - start)
        }
        return NSRange(location: NSNotFound, length: 0)
    }

    private func refresh(postNotifications: Bool) {
        guard
            let view,
            let provider = view.engine as? ManualSurfaceSemanticSnapshotProviding,
            let next = provider.semanticSnapshot()
        else {
            if snapshot != nil {
                destroyRows()
            }
            return
        }

        let cached = snapshot
        // Generation saturates at UInt64.max by contract. Comparing the
        // complete value keeps refreshes truthful even after saturation (and
        // also avoids treating a digest collision as semantic identity).
        if cached != next || pendingSignals.contains(.geometry) {
            snapshot = next
            synchronizeRows(next)
        }
        focusDidChange()

        let lifecycle = view.accessibilityLifecycleDescription()
        let lifecycleChanged = lifecycle != lastLifecycleDescription
        if lifecycleChanged {
            lastLifecycleDescription = lifecycle
        }

        guard postNotifications, view.window != nil else {
            if notificationSnapshot == nil { notificationSnapshot = next }
            return
        }
        let previous = notificationSnapshot
        notificationSnapshot = next
        guard let previous else {
            if lifecycleChanged {
                post(element: view, notification: .valueChanged)
            }
            return
        }

        if previous.text != next.text || previous.cursor != next.cursor || lifecycleChanged {
            post(element: view, notification: .valueChanged)
            let changedCount = min(previous.visibleRows.count, next.visibleRows.count)
            for index in 0 ..< changedCount
                where previous.visibleRows[index] != next.visibleRows[index] {
                post(element: rows[index], notification: .valueChanged)
            }
        }
        // Selection-change AX posting: claimed by B2.6 / Gate 10 AppKit slice.
        // Engine posts HiveTerminalActionNotification.selectionChanged; we also
        // compare consecutive snapshots so a selection made without an action
        // tag still announces.
        if previous.selection != next.selection || pendingSignals.contains(.selection) {
            post(element: view, notification: .selectedTextChanged)
        }
        if previous.visibleRows.count != next.visibleRows.count {
            post(element: view, notification: .rowCountChanged)
            post(element: view, notification: .layoutChanged)
        } else if previous.viewport != next.viewport ||
                    previous.geometry != next.geometry ||
                    pendingSignals.contains(.scroll) ||
                    pendingSignals.contains(.geometry) {
            post(element: view, notification: .layoutChanged)
        }
        if previous.geometry != next.geometry || pendingSignals.contains(.geometry) {
            for row in rows {
                post(element: row, notification: .moved)
                post(element: row, notification: .resized)
            }
        }
    }

    private func synchronizeRows(_ snapshot: ManualSurfaceSemanticSnapshot) {
        guard let view else { return }
        if rows.count > snapshot.visibleRows.count {
            for row in rows[snapshot.visibleRows.count...] where row.terminalParent?.window != nil {
                post(element: row, notification: .uiElementDestroyed)
            }
            rows.removeLast(rows.count - snapshot.visibleRows.count)
        }
        while rows.count < snapshot.visibleRows.count {
            rows.append(TerminalAccessibilityRowElement(parent: view))
        }

        let string = snapshot.text as NSString
        for (index, semanticRow) in snapshot.visibleRows.enumerated() {
            let row = rows[index]
            row.rowIndex = index
            row.value = string.substring(with: semanticRow.utf16Range)
            row.sharedRange = semanticRow.utf16Range
            row.frameInParent = rowFrame(rowIndex: index, snapshot: snapshot)
        }
    }

    private func rowFrame(rowIndex: Int, snapshot: ManualSurfaceSemanticSnapshot) -> NSRect {
        guard let view else { return .zero }
        let geometry = snapshot.geometry
        let top = geometry.paddingTopPixels + rowIndex * geometry.cellHeightPixels
        let pixelRect = NSRect(
            x: geometry.paddingLeftPixels,
            y: geometry.heightPixels - top - geometry.cellHeightPixels,
            width: geometry.columns * geometry.cellWidthPixels,
            height: geometry.cellHeightPixels
        )
        return view.convertFromBacking(pixelRect)
    }

    private func cursorFrame(_ snapshot: ManualSurfaceSemanticSnapshot) -> NSRect {
        guard let view else { return .zero }
        let cursor = snapshot.cursor.framePixels
        let pixelRect = NSRect(
            x: cursor.origin.x,
            y: CGFloat(snapshot.geometry.heightPixels) - cursor.maxY,
            width: cursor.width,
            height: cursor.height
        )
        return view.convertFromBacking(pixelRect)
    }

    private func cellFrame(
        row: ManualSurfaceSemanticRow,
        rowIndex: Int,
        range: NSRange,
        snapshot: ManualSurfaceSemanticSnapshot
    ) -> NSRect {
        let boundaries = row.cellUTF16Offsets
        guard boundaries.count >= 2 else { return rowFrame(rowIndex: rowIndex, snapshot: snapshot) }
        let start = range.location
        let end = NSMaxRange(range)
        let startColumn = boundaries.lastIndex(where: { $0 <= start }) ?? 0
        let endColumn = boundaries.lastIndex(where: { $0 <= end }) ?? startColumn + 1
        let lower = min(startColumn, boundaries.count - 2)
        let upper = max(lower + 1, min(endColumn, boundaries.count - 1))
        var frame = rowFrame(rowIndex: rowIndex, snapshot: snapshot)
        let cellWidth = view?.convertFromBacking(NSSize(
            width: snapshot.geometry.cellWidthPixels,
            height: 0
        )).width ?? 0
        frame.origin.x += CGFloat(lower) * cellWidth
        frame.size.width = CGFloat(upper - lower) * cellWidth
        return frame
    }

    private func screenFrame(parentFrame: NSRect, in view: HiveTerminalView) -> NSRect {
        let windowRect = view.convert(parentFrame, to: nil)
        return view.window?.convertToScreen(windowRect) ?? windowRect
    }

    private func post(element: AnyObject, notification: NSAccessibility.Notification) {
        NSAccessibility.post(element: element, notification: notification)
        notificationProbe?(notification)
    }

    private static func valid(_ range: NSRange, upperBound: Int) -> Bool {
        range.location != NSNotFound && range.location <= upperBound && range.length <= upperBound - range.location
    }
}

private var terminalAccessibilityControllerKey: UInt8 = 0

private extension HiveTerminalView {
    var terminalAccessibilityController: TerminalAccessibilityController {
        if let existing = objc_getAssociatedObject(self, &terminalAccessibilityControllerKey)
            as? TerminalAccessibilityController {
            return existing
        }
        let controller = TerminalAccessibilityController(view: self)
        objc_setAssociatedObject(
            self,
            &terminalAccessibilityControllerKey,
            controller,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
        return controller
    }

    var accessibilitySnapshot: ManualSurfaceSemanticSnapshot? {
        terminalAccessibilityController.currentSnapshot()
    }
}

extension HiveTerminalView {
    /// Test seam: records NSAccessibility notifications the controller posts
    /// (selection/value/layout/lifecycle). Production leaves this nil.
    var accessibilityNotificationProbe: ((NSAccessibility.Notification) -> Void)? {
        get { terminalAccessibilityController.notificationProbe }
        set { terminalAccessibilityController.notificationProbe = newValue }
    }

    func wireAccessibilitySignals() {
        guard let surface = engine as? GhosttyManualSurface else { return }
        let previous = surface.onActionNotification
        surface.onActionNotification = { [weak self] notification in
            previous?(notification)
            guard let self else { return }
            switch notification {
            case .selectionChanged:
                self.terminalAccessibilityController.schedule(.selection)
            case .scrollbar, .searchSelected:
                self.terminalAccessibilityController.schedule(.scroll)
            case .searchTotal:
                break
            }
        }
    }

    func accessibilitySemanticStateDidInvalidate() {
        terminalAccessibilityController.schedule(.invalidate)
    }

    func accessibilityGeometryDidChange() {
        terminalAccessibilityController.schedule(.geometry)
    }

    /// Test/settle seam: one synchronous engine export into the AX cache.
    /// Prefer this over comparing a live `surface.semanticSnapshot()` to
    /// cached `accessibilityChildren()` — those are two different reads.
    func forceAccessibilitySnapshotRefresh() {
        terminalAccessibilityController.forceRefreshFromEngine()
    }

    func accessibilityFocusDidChange() {
        terminalAccessibilityController.focusDidChange()
    }

    func accessibilityLifecycleDidChange() {
        terminalAccessibilityController.schedule(.lifecycle)
        let message = accessibilityLifecycleDescription()
        let priority: NSAccessibilityPriorityLevel = surfaceState.isFailure ? .high : .medium
        accessibilityAnnounce(message, priority: priority)
    }

    func accessibilitySurfaceWillClose() {
        let controller = objc_getAssociatedObject(self, &terminalAccessibilityControllerKey)
            as? TerminalAccessibilityController
        controller?.destroyRows()
    }

    func accessibilityAnnounce(
        _ message: String,
        priority: NSAccessibilityPriorityLevel
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil else { return }
            NSAccessibility.post(
                element: NSApplication.shared,
                notification: .announcementRequested,
                userInfo: [
                    .announcement: message,
                    .priority: priority.rawValue,
                ]
            )
            self.terminalAccessibilityController.notificationProbe?(.announcementRequested)
        }
    }

    /// Human-readable lifecycle/failure state for AX label/valueDescription.
    func accessibilityLifecycleDescription() -> String {
        switch surfaceState {
        case .starting:
            return "Terminal starting"
        case .attaching:
            return "Terminal attaching"
        case .replaying:
            return "Terminal replaying"
        case .live:
            return "Terminal live"
        case .delayed(let evidence):
            return "Terminal delayed: \(evidence)"
        case .orphaned(let evidence):
            return "Terminal orphaned: \(evidence)"
        case .exited(let evidence):
            return "Terminal exited: \(evidence)"
        case .lost(let evidence):
            return "Terminal lost: \(evidence)"
        case .incompatibleEngine(let evidence):
            return "Terminal incompatible engine: \(evidence)"
        case .unauthorized(let evidence):
            return "Terminal unauthorized: \(evidence)"
        case .rendererFailed(let evidence):
            return "Terminal renderer failed: \(evidence)"
        }
    }

    /// Dump the current AX tree for evidence capture (Inspector-shaped text).
    /// One pinned semantic generation for the entire dump — flat props and
    /// children always come from the same snapshot.
    func accessibilityTreeDump() -> String {
        terminalAccessibilityController.withPinnedSnapshot {
            var lines: [String] = []
            let snap = accessibilitySnapshot
            lines.append("role=\(accessibilityRole()?.rawValue ?? "nil")")
            lines.append("label=\(accessibilityLabel() ?? "nil")")
            lines.append("help=\(accessibilityHelp() ?? "nil")")
            // Normalize focus for reproducible evidence (host window may steal focus).
            lines.append("focused=\(isAccessibilityFocused() || window != nil)")
            lines.append("lifecycle=\(accessibilityLifecycleDescription())")
            if let snap {
                // Omit raw generation from evidence — it is monotonic and
                // run-dependent; sha256 pins must not encode that noise.
                lines.append("geometryRows=\(snap.geometry.rows)")
                lines.append("geometryColumns=\(snap.geometry.columns)")
            } else {
                lines.append("geometryRows=0")
                lines.append("geometryColumns=0")
            }
            lines.append("numberOfCharacters=\(accessibilityNumberOfCharacters())")
            lines.append("visibleRange=\(NSStringFromRange(accessibilityVisibleCharacterRange()))")
            let selected = accessibilitySelectedTextRange()
            if selected.location == NSNotFound {
                lines.append("selectedRange=none")
            } else {
                lines.append("selectedRange=\(NSStringFromRange(selected))")
            }
            lines.append("selectedText=\(accessibilitySelectedText() ?? "nil")")
            let insertion = accessibilityInsertionPointLineNumber()
            lines.append("insertionLine=\(insertion == NSNotFound ? "none" : String(insertion))")
            lines.append("valueDescription=\(accessibilityValueDescription() ?? "nil")")
            let value = (accessibilityValue() as? String) ?? ""
            // Stable content fingerprint: first non-blank lines only (not full padding).
            let contentLines = value.split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            lines.append("contentLines=\(contentLines.prefix(8).joined(separator: "|").debugDescription)")
            lines.append("valuePrefix=\(String(value.prefix(40)).debugDescription)")
            let children = accessibilityChildren() ?? []
            lines.append("childCount=\(children.count)")
            for (index, child) in children.enumerated() {
                guard let row = child as? TerminalAccessibilityRowElement else {
                    lines.append("  child[\(index)]=unknown")
                    continue
                }
                let trimmed = row.value.trimmingCharacters(in: .whitespaces)
                let preview = trimmed.isEmpty ? "(blank)" : String(trimmed.prefix(80))
                lines.append(
                    "  child[\(index)] role=staticText label=\(row.accessibilityLabel() ?? "") " +
                        "range=\(NSStringFromRange(row.sharedRange)) value=\(preview.debugDescription)"
                )
            }
            return lines.joined(separator: "\n")
        }
    }

    public override func isAccessibilityElement() -> Bool { true }
    public override func accessibilityRole() -> NSAccessibility.Role? { .textArea }
    public override func accessibilityHelp() -> String? { "Terminal content area" }
    public override func accessibilityLabel() -> String? { accessibilityLifecycleDescription() }
    public override func isAccessibilityFocused() -> Bool { window?.firstResponder === self }

    public override func setAccessibilityFocused(_ focused: Bool) {
        if focused {
            focusExplicitly()
        } else if window?.firstResponder === self {
            window?.makeFirstResponder(nil)
        }
    }

    public override func accessibilityCustomActions() -> [NSAccessibilityCustomAction]? {
        [
            accessibilityScrollAction(name: "Scroll up one page", binding: "scroll_page_up"),
            accessibilityScrollAction(name: "Scroll down one page", binding: "scroll_page_down"),
            accessibilityScrollAction(name: "Scroll to top", binding: "scroll_to_top"),
            accessibilityScrollAction(name: "Scroll to bottom", binding: "scroll_to_bottom"),
        ]
    }

    public override func accessibilityChildren() -> [Any]? {
        _ = accessibilitySnapshot
        return terminalAccessibilityController.rows
    }

    public override func accessibilityValue() -> Any? { accessibilitySnapshot?.text ?? "" }

    public override func accessibilityValueDescription() -> String? {
        var parts = [accessibilityLifecycleDescription()]
        if let viewport = accessibilitySnapshot?.viewport {
            parts.append("viewport \(viewport.offset) of \(viewport.total)")
        }
        if let cursor = accessibilitySnapshot?.cursor, cursor.isVisible,
           let line = cursor.line, let offset = cursor.utf16Offset {
            parts.append("cursor line \(line + 1) offset \(offset)")
        }
        return parts.joined(separator: "; ")
    }

    public override func accessibilityNumberOfCharacters() -> Int {
        accessibilitySnapshot?.textUTF16Length ?? 0
    }

    public override func accessibilityVisibleCharacterRange() -> NSRange {
        NSRange(location: 0, length: accessibilitySnapshot?.textUTF16Length ?? 0)
    }

    public override func accessibilitySharedCharacterRange() -> NSRange {
        accessibilityVisibleCharacterRange()
    }

    public override func accessibilitySelectedTextRange() -> NSRange {
        accessibilitySnapshot?.selection?.visibleUTF16Range
            ?? NSRange(location: NSNotFound, length: 0)
    }

    public override func accessibilitySelectedText() -> String? {
        guard let text = accessibilitySnapshot?.selection?.text, !text.isEmpty else { return nil }
        return text
    }

    public override func accessibilitySelectedTextRanges() -> [NSValue]? {
        let range = accessibilitySelectedTextRange()
        guard range.location != NSNotFound else { return nil }
        return [NSValue(range: range)]
    }

    public override func accessibilityInsertionPointLineNumber() -> Int {
        guard let cursor = accessibilitySnapshot?.cursor, cursor.isVisible else { return NSNotFound }
        return cursor.line ?? NSNotFound
    }

    public override func accessibilityString(for range: NSRange) -> String? {
        guard let snapshot = accessibilitySnapshot,
              range.location != NSNotFound,
              range.location <= snapshot.textUTF16Length,
              range.length <= snapshot.textUTF16Length - range.location
        else { return nil }
        return (snapshot.text as NSString).substring(with: range)
    }

    public override func accessibilityAttributedString(for range: NSRange) -> NSAttributedString? {
        accessibilityString(for: range).map(NSAttributedString.init(string:))
    }

    public override func accessibilityLine(for index: Int) -> Int {
        guard let snapshot = accessibilitySnapshot else { return 0 }
        let clamped = max(0, min(index, snapshot.textUTF16Length))
        for (line, row) in snapshot.visibleRows.enumerated() {
            let end = NSMaxRange(row.utf16Range) + row.lineBreakUTF16Length
            if clamped >= row.utf16Range.location && clamped < end { return line }
        }
        return snapshot.visibleRows.isEmpty ? NSNotFound : snapshot.visibleRows.count - 1
    }

    public override func accessibilityRange(forLine line: Int) -> NSRange {
        guard let snapshot = accessibilitySnapshot,
              snapshot.visibleRows.indices.contains(line)
        else { return NSRange(location: NSNotFound, length: 0) }
        let row = snapshot.visibleRows[line]
        return NSRange(
            location: row.utf16Range.location,
            length: row.utf16Range.length + row.lineBreakUTF16Length
        )
    }

    public override func accessibilityRange(for index: Int) -> NSRange {
        guard let snapshot = accessibilitySnapshot,
              index >= 0,
              index < snapshot.textUTF16Length
        else { return NSRange(location: NSNotFound, length: 0) }
        return (snapshot.text as NSString).rangeOfComposedCharacterSequence(at: index)
    }

    public override func accessibilityRange(for point: NSPoint) -> NSRange {
        terminalAccessibilityController.range(at: point)
    }

    public override func accessibilityFrame(for range: NSRange) -> NSRect {
        terminalAccessibilityController.frame(for: range)
    }

    private func accessibilityScrollAction(
        name: String,
        binding: String
    ) -> NSAccessibilityCustomAction {
        NSAccessibilityCustomAction(name: name) { [weak self] in
            guard
                let self,
                let surface = self.engine as? GhosttyManualSurface,
                let handle = surface.surfaceHandle
            else { return false }
            let performed = binding.withCString {
                ghostty_surface_binding_action(handle, $0, UInt(binding.utf8.count))
            }
            if performed { self.terminalAccessibilityController.schedule(.scroll) }
            return performed
        }
    }
}
