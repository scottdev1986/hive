import AppKit
import Foundation
import HiveGhosttyC
import UniformTypeIdentifiers

struct GhosttyClipboardContent: Equatable {
    let mime: String
    let data: String
}

/// Per-surface clipboard state carried through `ghostty_surface_config_s.userdata`.
/// Ghostty invokes these callbacks while a surface entry is active, so every
/// completion is deferred to avoid re-entering C from inside its callback.
final class GhosttyClipboardContext {
    typealias ReadHandler = (ghostty_clipboard_e) -> String?
    typealias WriteHandler = (ghostty_clipboard_e, [GhosttyClipboardContent]) -> Void
    typealias ConfirmationObserver = (String, ghostty_clipboard_request_e) -> Void

    private weak var surface: ManualSurfaceEngine?
    private var acceptingCompletions = true
    private var pendingRequestStates: Set<UnsafeMutableRawPointer> = []
    private let readHandler: ReadHandler
    private let writeHandler: WriteHandler
    private let confirmationObserver: ConfirmationObserver?

    var unownedContextPointer: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }

    init() {
        self.readHandler = { location in
            guard location == GHOSTTY_CLIPBOARD_STANDARD else { return nil }
            return NSPasteboard.general.string(forType: .string)
        }
        self.writeHandler = { location, contents in
            guard location == GHOSTTY_CLIPBOARD_STANDARD else { return }
            let values = contents.compactMap { item -> (NSPasteboard.PasteboardType, String)? in
                let type: NSPasteboard.PasteboardType
                if item.mime == "text/plain" {
                    type = .string
                } else if let uniformType = UTType(mimeType: item.mime) {
                    type = NSPasteboard.PasteboardType(uniformType.identifier)
                } else {
                    type = NSPasteboard.PasteboardType(item.mime)
                }
                return (type, item.data)
            }
            guard !values.isEmpty else { return }
            NSPasteboard.general.declareTypes(values.map(\.0), owner: nil)
            for (type, value) in values {
                NSPasteboard.general.setString(value, forType: type)
            }
        }
        self.confirmationObserver = nil
    }

    init(
        read: @escaping ReadHandler,
        write: @escaping WriteHandler,
        onConfirmation: ConfirmationObserver? = nil
    ) {
        self.readHandler = read
        self.writeHandler = write
        self.confirmationObserver = onConfirmation
    }

    func bind(surface: ManualSurfaceEngine) {
        dispatchPrecondition(condition: .onQueue(.main))
        self.surface = surface
    }

    func beginTeardown() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard acceptingCompletions else { return }
        acceptingCompletions = false
        let surface = self.surface
        self.surface = nil
        let pending = pendingRequestStates
        pendingRequestStates.removeAll()
        for state in pending {
            surface?.completeClipboardRequest("", state: state, confirmed: true)
        }
    }

    func beginRead(location: ghostty_clipboard_e, state: UnsafeMutableRawPointer?) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard acceptingCompletions,
              location == GHOSTTY_CLIPBOARD_STANDARD,
              let state,
              let value = readHandler(location) else { return false }
        pendingRequestStates.insert(state)
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.acceptingCompletions,
                  self.pendingRequestStates.remove(state) != nil,
                  let surface = self.surface else { return }
            surface.completeClipboardRequest(value, state: state, confirmed: false)
        }
        return true
    }

    func confirmRead(
        string: UnsafePointer<CChar>?,
        state: UnsafeMutableRawPointer?,
        request: ghostty_clipboard_request_e
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        let value = string.map { String(cString: $0) } ?? ""
        confirmationObserver?(value, request)
        guard acceptingCompletions, let state else { return }
        pendingRequestStates.insert(state)
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.acceptingCompletions,
                  self.pendingRequestStates.remove(state) != nil,
                  let surface = self.surface else { return }
            // No confirmation UI exists yet. Empty + confirmed consumes the
            // preserved request without authorizing the unsafe original.
            surface.completeClipboardRequest("", state: state, confirmed: true)
        }
    }

    func write(
        location: ghostty_clipboard_e,
        content: UnsafePointer<ghostty_clipboard_content_s>?,
        count: Int,
        confirm: Bool
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        let copied: [GhosttyClipboardContent]
        if let content, count > 0 {
            copied = (0..<count).compactMap { index in
                guard let mime = content[index].mime, let data = content[index].data else { return nil }
                return GhosttyClipboardContent(mime: String(cString: mime), data: String(cString: data))
            }
        } else {
            copied = []
        }
        guard acceptingCompletions,
              location == GHOSTTY_CLIPBOARD_STANDARD,
              !confirm,
              !copied.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.acceptingCompletions else { return }
            self.writeHandler(location, copied)
        }
    }

    static func fromUserdata(_ userdata: UnsafeMutableRawPointer?) -> GhosttyClipboardContext? {
        guard let userdata else { return nil }
        return Unmanaged<GhosttyClipboardContext>.fromOpaque(userdata).takeUnretainedValue()
    }
}
