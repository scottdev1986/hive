import AppKit
import WorkspaceCore

/// Hosts pane views and animates them between solver frames.
/// Flipped so solver coordinates (y-down) map directly to view frames.
final class LayoutContainerView: NSView {
    override var isFlipped: Bool { true }

    var onBoundsChanged: (() -> Void)?
    private var lastBounds: CGRect = .zero

    override func layout() {
        super.layout()
        if bounds != lastBounds {
            lastBounds = bounds
            onBoundsChanged?()
        }
    }
}

/// The ~180 ms interruptible layout transition. Frames are driven explicitly
/// from a timer so a retarget mid-flight starts from the true presentation
/// geometry, and the terminal-cell commit fires exactly once, only when a
/// transition fully settles. Reduce Motion snaps immediately (still one commit).
final class LayoutAnimator {

    private struct Transition {
        let view: NSView
        let from: CGRect
        let to: CGRect
    }

    private var timer: Timer?
    private var transitions: [Transition] = []
    private var startTime: CFTimeInterval = 0
    private var completion: (() -> Void)?

    var isAnimating: Bool { timer != nil }

    func animate(views: [(NSView, CGRect)], reduceMotion: Bool, completion: @escaping () -> Void) {
        // Interrupt: drop the pending commit; the new transition owns it.
        cancel()

        let moving = views.filter { $0.0.frame != $0.1 }
        guard !moving.isEmpty else {
            completion()
            return
        }

        if reduceMotion {
            for (view, target) in moving { view.frame = target }
            completion()
            return
        }

        // `view.frame` is the presentation value because this animator is the
        // only thing mutating it — retargets are seamless by construction.
        transitions = moving.map { Transition(view: $0.0, from: $0.0.frame, to: $0.1) }
        self.completion = completion
        startTime = CACurrentMediaTime()
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
        transitions = []
        completion = nil
    }

    private func tick() {
        let elapsed = CACurrentMediaTime() - startTime
        let progress = LayoutTransition.progress(elapsed: elapsed)
        for transition in transitions {
            transition.view.frame = LayoutTransition.interpolate(
                from: transition.from, to: transition.to, progress: progress)
        }
        if elapsed >= LayoutTransition.duration {
            for transition in transitions { transition.view.frame = transition.to }
            let done = completion
            cancel()
            done?()
        }
    }
}
