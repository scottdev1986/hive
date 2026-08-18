// FactStripViewTests.swift
//
// The pairing proof Queen Provider and Live Run both inherit. Leftover
// width must sit between pairs, never inside one, or a label binds to
// the next pair's value.

import AppKit
import XCTest
@testable import HiveWorkspace

@MainActor
final class FactStripViewTests: XCTestCase {

    func testPairsHugAndLeaveLeftoverWidthBetweenThem() throws {
        let strip = FactStripView(
            pairs: [
                FactStripView.pair(label: "Root", value: "queen · instance-fixture"),
                FactStripView.pair(label: "Live provider", value: "claude"),
                FactStripView.pair(label: "Health", value: "working"),
                FactStripView.pair(label: "Change", value: "idle · revision 1"),
            ],
            identifier: "fact-strip")
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 1100, height: 40))
        host.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(strip)
        NSLayoutConstraint.activate([
            strip.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            strip.topAnchor.constraint(equalTo: host.topAnchor),
            host.widthAnchor.constraint(equalToConstant: 1100),
        ])
        host.layoutSubtreeIfNeeded()

        XCTAssertGreaterThanOrEqual(strip.stack.arrangedSubviews.count, 2)
        var previousPair: NSView?
        for pair in strip.stack.arrangedSubviews {
            let stack = try XCTUnwrap(pair as? NSStackView)
            XCTAssertEqual(stack.spacing, Theme.Space.s)
            let childrenWidth = stack.arrangedSubviews.reduce(CGFloat(0)) {
                $0 + $1.alignmentRect(forFrame: $1.frame).width
            }
            XCTAssertEqual(
                stack.frame.width, childrenWidth + stack.spacing, accuracy: 2,
                "fact pair must hug its label and value")
            if let previous = previousPair {
                let previousFrame = previous.convert(previous.bounds, to: strip)
                let pairFrame = pair.convert(pair.bounds, to: strip)
                let between = pairFrame.minX - previousFrame.maxX
                XCTAssertGreaterThan(between, stack.spacing + 1)
                XCTAssertGreaterThanOrEqual(between, Theme.Space.xl - 1)
            }
            previousPair = pair
        }
    }
}
