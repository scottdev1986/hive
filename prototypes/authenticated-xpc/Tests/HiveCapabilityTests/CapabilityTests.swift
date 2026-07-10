import XCTest
@testable import HiveCapability

/// These tests encode the rights matrix from the blueprint's
/// "Authenticated IPC and capabilities" section as falsifiable assertions.
final class CapabilityTests: XCTestCase {

    private var clock = Date(timeIntervalSince1970: 1_000_000)
    private func makeRegistry(epoch: Int = 0) -> CapabilityRegistry {
        CapabilityRegistry(epoch: epoch, now: { [self] in clock })
    }

    private func writerGrant(_ r: CapabilityRegistry, subject: String = "alex", branch: String = "hive/alex", epoch: Int = 0) -> Grant {
        r.mint(Grant(
            tenant: "HIVE-A", subject: subject,
            actions: Role.writer, oneShot: Role.writerOneShot,
            branch: branch, epoch: epoch,
            expiresAt: clock.addingTimeInterval(300)
        ))
    }

    private func orchestratorGrant(_ r: CapabilityRegistry) -> Grant {
        r.mint(Grant(
            tenant: "HIVE-A", subject: "orchestrator",
            actions: Role.orchestrator, epoch: 0,
            expiresAt: clock.addingTimeInterval(300)
        ))
    }

    // MARK: - Subject/action restriction

    func testWriterHoldsExactlyItsAllowlist() {
        let r = makeRegistry()
        let g = writerGrant(r)
        for action in Action.allCases {
            let decision = r.authorize(grantID: g.id, action: action, branch: "hive/alex")
            let expected = Role.writer.contains(action)
            XCTAssertEqual(decision.isAllowed, expected, "\(action.auditName) on writer")
            if decision.isAllowed, Role.writerOneShot.contains(action) {
                r.release(grantID: g.id, action: action)  // don't burn it for the next loop
            }
        }
    }

    func testWriterCannotSpawnApproveKillOrReadGlobalInbox() {
        let r = makeRegistry()
        let g = writerGrant(r)
        for action: Action in [.spawn, .approve, .kill, .readGlobalInbox] {
            XCTAssertEqual(r.authorize(grantID: g.id, action: action), .denied(.notPermitted), action.auditName)
        }
    }

    func testOrchestratorMaySpawnAndApproveButHoldsNoLandingRight() {
        let r = makeRegistry()
        let g = orchestratorGrant(r)
        XCTAssertTrue(r.authorize(grantID: g.id, action: .spawn).isAllowed)
        XCTAssertTrue(r.authorize(grantID: g.id, action: .approve).isAllowed)
        // The orchestrator is not "a writer plus more".
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "hive/alex"), .denied(.notPermitted))
        XCTAssertEqual(r.authorize(grantID: g.id, action: .kill), .denied(.notPermitted))
    }

    func testPlainAgentHoldsNeitherLandingNorSpawn() {
        let r = makeRegistry()
        let g = r.mint(Grant(tenant: "HIVE-A", subject: "alex", actions: Role.agent, epoch: 0,
                             expiresAt: clock.addingTimeInterval(300)))
        XCTAssertTrue(r.authorize(grantID: g.id, action: .sendMessage).isAllowed)
        XCTAssertTrue(r.authorize(grantID: g.id, action: .readOwnInbox).isAllowed)
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "hive/alex"), .denied(.notPermitted))
        XCTAssertEqual(r.authorize(grantID: g.id, action: .spawn), .denied(.notPermitted))
    }

    // MARK: - "Only its own branch"

    func testWriterCannotLandAnotherAgentsBranch() {
        let r = makeRegistry()
        let g = writerGrant(r, subject: "alex", branch: "hive/alex")
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "hive/maya"), .denied(.wrongBranch))
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "main"), .denied(.wrongBranch))
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: nil), .denied(.wrongBranch))
    }

    /// The confused-deputy property, stated structurally: a caller cannot even
    /// *express* another subject. `authorize` has no subject parameter, so the
    /// only thing distinguishing alex's call from maya's is which grant the
    /// connection already holds.
    func testAuthorizationNeverConsultsACallerSuppliedSubject() {
        let r = makeRegistry()
        let alex = writerGrant(r, subject: "alex", branch: "hive/alex")
        let maya = writerGrant(r, subject: "maya", branch: "hive/maya")

        XCTAssertTrue(r.authorize(grantID: alex.id, action: .land, branch: "hive/alex").isAllowed)
        XCTAssertEqual(r.authorize(grantID: alex.id, action: .land, branch: "hive/maya"), .denied(.wrongBranch))
        XCTAssertTrue(r.authorize(grantID: maya.id, action: .land, branch: "hive/maya").isAllowed)

        XCTAssertEqual(alex.tenant, maya.tenant)
        XCTAssertNotEqual(alex.subject, maya.subject)
    }

    // MARK: - One-shot, replay, and the failed-merge retry

    func testLandingRightIsSpentOnSuccessAndReplayIsDenied() {
        let r = makeRegistry()
        let g = writerGrant(r)
        XCTAssertTrue(r.authorize(grantID: g.id, action: .land, branch: "hive/alex").isAllowed)
        r.commit(grantID: g.id, action: .land)
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "hive/alex"), .denied(.replayed))
    }

    /// A fast-forward merge that loses a race is not the writer's fault. The
    /// right must survive so the writer can rebase and retry.
    func testFailedLandReleasesTheRightForRetry() {
        let r = makeRegistry()
        let g = writerGrant(r)
        XCTAssertTrue(r.authorize(grantID: g.id, action: .land, branch: "hive/alex").isAllowed)
        r.release(grantID: g.id, action: .land)   // main moved; ff-merge rejected
        XCTAssertTrue(r.authorize(grantID: g.id, action: .land, branch: "hive/alex").isAllowed,
                      "a writer stranded by a lost race can never land again")
        r.commit(grantID: g.id, action: .land)
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "hive/alex"), .denied(.replayed))
    }

    func testConcurrentLandAttemptIsDeniedWhileTheFirstIsInFlight() {
        let r = makeRegistry()
        let g = writerGrant(r)
        XCTAssertTrue(r.authorize(grantID: g.id, action: .land, branch: "hive/alex").isAllowed)
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "hive/alex"), .denied(.replayed))
    }

    func testNonOneShotActionsAreNotConsumed() {
        let r = makeRegistry()
        let g = writerGrant(r)
        for _ in 0..<3 {
            XCTAssertTrue(r.authorize(grantID: g.id, action: .sendMessage).isAllowed)
        }
    }

    // MARK: - Revocation and expiry

    func testRevocationAdvancesEpochAndInvalidatesStaleRights() {
        let r = makeRegistry()
        let g = writerGrant(r, epoch: 0)
        XCTAssertTrue(r.authorize(grantID: g.id, action: .sendMessage).isAllowed)
        XCTAssertEqual(r.revoke(), 1)
        XCTAssertEqual(r.authorize(grantID: g.id, action: .sendMessage), .denied(.staleEpoch))
        XCTAssertEqual(r.authorize(grantID: g.id, action: .land, branch: "hive/alex"), .denied(.staleEpoch))
    }

    func testGrantMintedAtTheNewEpochWorksAfterRevocation() {
        let r = makeRegistry()
        _ = writerGrant(r, epoch: 0)
        let newEpoch = r.revoke()
        let fresh = writerGrant(r, epoch: newEpoch)
        XCTAssertTrue(r.authorize(grantID: fresh.id, action: .land, branch: "hive/alex").isAllowed)
    }

    func testExpiredGrantIsDenied() {
        let r = makeRegistry()
        let g = writerGrant(r)
        clock = clock.addingTimeInterval(301)
        XCTAssertEqual(r.authorize(grantID: g.id, action: .sendMessage), .denied(.expired))
    }

    func testUnknownCapabilityIsDenied() {
        let r = makeRegistry()
        XCTAssertEqual(r.authorize(grantID: "forged-id", action: .sendMessage), .denied(.unknownCapability))
    }

    // MARK: - Audit vocabulary shared with the HTTP control plane

    func testAuditNamesAreStableAndUnique() {
        let names = Action.allCases.map(\.auditName)
        XCTAssertEqual(Set(names).count, names.count)
        XCTAssertEqual(Action.land.auditName, "branch:land")
        XCTAssertEqual(Action.spawn.auditName, "agent:spawn")
        XCTAssertEqual(Action.readGlobalInbox.auditName, "inbox:read-global")
    }
}
