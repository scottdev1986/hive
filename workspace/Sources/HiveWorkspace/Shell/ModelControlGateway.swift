// ModelControlGateway.swift The model-control snapshot endpoint described
// once. ShellLiveStore reads the same projection Task Router and Models &
// Quota render; writes go through RoutingPolicyGateway against that document's
// revision.

import Foundation
import WorkspaceCore

struct ModelControlGateway {
    static let read = WorkspaceReadEndpoint<WorkspaceModelControlView>(
        path: "model-control/snapshot",
        source: { ProjectionSource(revision: String($0.routing.policy.revision)) },
        observedAt: { $0.observedAt })
}
