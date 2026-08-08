// ShellAbsentScreen.swift The value payload of an absent-screen projection row. A screen whose wire is not frozen in this build still renders from a real projection row: the row's availability is unknown and its value names the contract state and the reason, so the panel's honesty claim is data the tests can mutate — never a string synthesized in code.

import Foundation

public struct ShellAbsentScreen: Codable, Equatable, Sendable {
    public let route: String
    public let contractState: String
    public let reason: String

}
