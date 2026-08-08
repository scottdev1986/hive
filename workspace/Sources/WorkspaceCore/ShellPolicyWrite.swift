// ShellPolicyWrite.swift What a Model Control screen asks the launch to write. The screens build these from their own controls and hand them over; only a launch holding a daemon connection can send one, so a launch without one simply has no handler and the controls render disabled rather than pretending to write.

import Foundation

public enum ShellPolicyWrite: Equatable, Sendable {
    case route(TaskCategory)
    case provider(ProviderID, enabled: Bool)
    case model(ProviderID, model: String, enabled: Bool)
}
