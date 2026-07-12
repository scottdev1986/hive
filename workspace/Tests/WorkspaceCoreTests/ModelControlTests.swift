import XCTest
@testable import WorkspaceCore

/// The Model Control Center's honesty rules, as tests. Each of these is a way
/// the screen could lie if it regressed:
/// - a missing reading rendering as a 0% meter
/// - Grok's money rails rendering as a gauge
/// - "vendor said no effort axis" conflated with "could not read effort axis"
/// - a provider-off model row still reading as enabled
final class ModelControlTests: XCTestCase {

    // MARK: Meter derivation — unknown is not zero

    private func window(
        used: Double? = nil, remainingPct: Double? = nil, allowance: Double? = nil,
        unit: String = "percent", confidence: String = "reported"
    ) -> QuotaWindow {
        QuotaWindow(
            unit: unit, allowance: allowance, used: used,
            remainingPct: remainingPct, confidence: confidence, source: "provider")
    }

    func testNoReadingDerivesUnknownNeverZero() {
        let state = MeterDerivation.meterState(for: window(used: nil))
        guard case .unknown = state else {
            return XCTFail("a window with no reading must derive .unknown, got \(state)")
        }
    }

    func testMeasuredZeroIsMeasuredZero() {
        let state = MeterDerivation.meterState(for: window(used: 0, allowance: 100))
        guard case .measured(let percent, _, _, _) = state else {
            return XCTFail("a real 0 reading is a measurement, got \(state)")
        }
        XCTAssertEqual(percent, 0)
    }

    func testUnknownAndMeasuredZeroAreDistinct() {
        let unknown = MeterDerivation.meterState(for: window(used: nil))
        let zero = MeterDerivation.meterState(for: window(used: 0, allowance: 100))
        XCTAssertNotEqual(unknown, zero, "unknown must never compare equal to a measured 0%")
    }

    func testStaleConfidenceDerivesStaleState() {
        let state = MeterDerivation.meterState(
            for: window(used: 12, allowance: 100, confidence: "stale"))
        guard case .stale(let percent, _, _) = state else {
            return XCTFail("stale confidence must derive .stale, got \(state)")
        }
        XCTAssertEqual(percent, 12)
    }

    func testRemainingOnlyReadingFillsHonestly() {
        let state = MeterDerivation.meterState(
            for: window(remainingPct: 0.25, allowance: 100))
        guard case .measured(let percent, _, _, _) = state else {
            return XCTFail("remaining-only should still meter, got \(state)")
        }
        XCTAssertEqual(percent, 75, accuracy: 0.001)
    }

    func testManualUnitPoolIsNotRenderedAsAPercentMeter() {
        let state = MeterDerivation.meterState(for: window(used: 3, unit: "units"))
        guard case .unknown = state else {
            return XCTFail("operator-unit pools are not percent meters, got \(state)")
        }
    }

    // MARK: Provider usage — unmetered vs silent vs unknown

    private func claudePool(fiveHourUsed: Double?) -> QuotaEntry {
        .pool(QuotaPool(
            provider: "claude", pool: "plan", origin: "discovered",
            confidence: "reported", freshness: "fresh", source: "provider",
            fiveHour: window(used: fiveHourUsed, allowance: 100),
            weekly: window(used: nil)))
    }

    func testUnmeteredSurfaceNeverGetsMeters() {
        // Even with a quota row present, a provider with no capacity surface
        // must not mount a meter: money rails are not gauges.
        let usage = MeterDerivation.usage(
            provider: .grok, surface: UsageSurface.none,
            quota: [claudePool(fiveHourUsed: 40)], quotaError: nil)
        XCTAssertEqual(usage, .unmetered)
    }

    func testMeteredProviderWithPoolGetsWindows() {
        let usage = MeterDerivation.usage(
            provider: .claude, surface: .metered,
            quota: [claudePool(fiveHourUsed: 63)], quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        XCTAssertEqual(windows.count, 2)
        guard case .measured(let percent, _, _, _) = windows[0].state else {
            return XCTFail("five-hour window should be measured")
        }
        XCTAssertEqual(percent, 63)
        // The weekly window has no reading — it must be unknown, not 0.
        guard case .unknown = windows[1].state else {
            return XCTFail("weekly window without a reading must be unknown")
        }
    }

    func testSilentFeedDerivesSilentWithMeasuredReason() {
        let usage = MeterDerivation.usage(
            provider: .claude, surface: .metered,
            quota: [.unconfigured(QuotaUnconfigured(
                provider: "claude", model: "*",
                reason: "no provider reading",
                probeError: "get_usage returned no data (experimental surface)"))],
            quotaError: nil)
        guard case .silent(let reason) = usage else {
            return XCTFail("a metered provider with no reading is silent, got \(usage)")
        }
        XCTAssertTrue(reason.contains("get_usage"), "the measured reason must survive")
    }

    func testDaemonUnreachableDerivesUnknownNotSilent() {
        let usage = MeterDerivation.usage(
            provider: .claude, surface: .metered,
            quota: nil, quotaError: "the Hive daemon could not be reached")
        guard case .unknown(let reason) = usage else {
            return XCTFail("no daemon = unknown, got \(usage)")
        }
        XCTAssertTrue(reason.contains("daemon"))
    }

    func testCardMetersTheAccountPoolNotAModelScopedPool() {
        let modelScoped = QuotaEntry.pool(QuotaPool(
            provider: "claude", pool: "weekly:Fable", origin: "discovered",
            models: ["claude-fable-5"], label: "Fable",
            confidence: "reported", freshness: "fresh", source: "provider",
            fiveHour: window(used: 99, allowance: 100),
            weekly: window(used: 99, allowance: 100)))
        let account = claudePool(fiveHourUsed: 22)
        let usage = MeterDerivation.usage(
            provider: .claude, surface: .metered,
            quota: [modelScoped, account], quotaError: nil)
        guard case .metered(let windows) = usage,
              case .measured(let percent, _, _, _) = windows[0].state else {
            return XCTFail("expected account-pool meters, got \(usage)")
        }
        XCTAssertEqual(percent, 22, "the card meters the account pool, not a model ceiling")
    }

    func testModelPoolExhaustionIsMeasuredOnlyAndUnknownIsNotExhausted() {
        let exhausted = QuotaEntry.pool(QuotaPool(
            provider: "claude", pool: "weekly:Fable", origin: "discovered",
            models: ["claude-fable-5"], label: "Fable",
            confidence: "reported", freshness: "fresh", source: "provider",
            fiveHour: window(used: nil),
            weekly: window(used: 100, allowance: 100)))
        XCTAssertTrue(MeterDerivation.modelPoolExhausted(
            provider: .claude, canonicalId: "claude-fable-5", quota: [exhausted]))
        XCTAssertFalse(MeterDerivation.modelPoolExhausted(
            provider: .claude, canonicalId: "claude-opus-4-8", quota: [exhausted]),
            "another model does not inherit this ceiling")
        let unknownPool = QuotaEntry.pool(QuotaPool(
            provider: "claude", pool: "weekly:Fable", origin: "discovered",
            models: ["claude-fable-5"], label: "Fable",
            confidence: "missing", freshness: "missing", source: "none",
            fiveHour: window(used: nil), weekly: window(used: nil)))
        XCTAssertFalse(MeterDerivation.modelPoolExhausted(
            provider: .claude, canonicalId: "claude-fable-5", quota: [unknownPool]),
            "UNKNOWN is not exhausted")
        XCTAssertFalse(MeterDerivation.modelPoolExhausted(
            provider: .claude, canonicalId: "claude-fable-5", quota: nil))
    }

    func testPlanLabelComesFromTheAccountPool() {
        XCTAssertEqual(
            MeterDerivation.planLabel(provider: .claude, quota: [claudePool(fiveHourUsed: 22)]),
            nil, "the fixture account pool has no label")
        let labeled = QuotaEntry.pool(QuotaPool(
            provider: "claude", pool: "subscription", origin: "discovered",
            models: ["*"], label: "max",
            confidence: "reported", freshness: "fresh", source: "provider",
            fiveHour: window(used: 22, allowance: 100),
            weekly: window(used: 43, allowance: 100)))
        XCTAssertEqual(MeterDerivation.planLabel(provider: .claude, quota: [labeled]), "max")
    }

    // MARK: Effort — three values, three treatments

    private func model(
        supportsEffort: DiscoveredFact<Bool>,
        levels: DiscoveredFact<[String]>,
        defaultEffort: DiscoveredFact<String> = .unknown(
            reason: "field-absent", surface: "test", observedAt: "")
    ) -> DiscoveredModel {
        DiscoveredModel(
            provider: "grok", canonicalId: "m", launchToken: "m",
            hidden: .known(false, surface: "test", observedAt: ""),
            supportsEffort: supportsEffort,
            supportedEffortLevels: levels,
            defaultEffort: defaultEffort,
            observedAt: "")
    }

    func testVendorStatedNoEffortAxisIsKnownNone() {
        // grok-composer-2.5-fast advertises supports_reasoning_effort: false —
        // the vendor STATING there is no effort axis.
        let axis = EffortAxis.derive(from: model(
            supportsEffort: .known(false, surface: "grok.models_cache", observedAt: ""),
            levels: .unknown(reason: "field-absent", surface: "grok.models_cache", observedAt: "")))
        XCTAssertEqual(axis, .none)
    }

    func testUnreadableEffortIsUnknownWithReason() {
        let axis = EffortAxis.derive(from: model(
            supportsEffort: .unknown(reason: "surface-silent", surface: "codex.model/list", observedAt: ""),
            levels: .unknown(reason: "surface-silent", surface: "codex.model/list", observedAt: "")))
        XCTAssertEqual(axis, .unknown(reason: "surface-silent"))
    }

    func testKnownNoneAndUnknownAreDifferentFacts() {
        let none = EffortAxis.derive(from: model(
            supportsEffort: .known(false, surface: "t", observedAt: ""),
            levels: .unknown(reason: "field-absent", surface: "t", observedAt: "")))
        let unknown = EffortAxis.derive(from: model(
            supportsEffort: .unknown(reason: "field-absent", surface: "t", observedAt: ""),
            levels: .unknown(reason: "field-absent", surface: "t", observedAt: "")))
        XCTAssertNotEqual(none, unknown, "known-none and unknown must never merge")
    }

    func testAdvertisedLevelsSurviveVerbatimInVendorOrder() {
        let axis = EffortAxis.derive(from: model(
            supportsEffort: .known(true, surface: "t", observedAt: ""),
            levels: .known(["minimal", "low", "medium", "high", "max", "ultra"],
                           surface: "t", observedAt: ""),
            defaultEffort: .known("medium", surface: "t", observedAt: "")))
        XCTAssertEqual(axis, .known(
            levels: ["minimal", "low", "medium", "high", "max", "ultra"],
            defaultLevel: "medium"))
    }

    func testAdvertisedSupportWithEmptyLevelListIsSurfacedNotGuessed() {
        let axis = EffortAxis.derive(from: model(
            supportsEffort: .known(true, surface: "t", observedAt: ""),
            levels: .known([], surface: "t", observedAt: "")))
        guard case .unknown = axis else {
            return XCTFail("an empty advertised list is an inconsistency, not a picker: \(axis)")
        }
    }

    // MARK: Model rows — provider-off dominates

    func testProviderOffOverridesModelOn() {
        let state = ModelRowState.derive(
            providerEnabled: false, modelSelfEnabled: true, modelAvailable: true)
        XCTAssertEqual(state, .disabledByProvider(preferenceOn: true))
        XCTAssertFalse(state.isEffectivelyEnabled,
                       "a model under a disabled provider is never effective")
    }

    func testProviderOffPreservesStoredPreferenceForDisplay() {
        let offPreference = ModelRowState.derive(
            providerEnabled: false, modelSelfEnabled: false, modelAvailable: true)
        XCTAssertEqual(offPreference, .disabledByProvider(preferenceOn: false))
    }

    func testSelfDisabledDiffersFromProviderDisabled() {
        let bySelf = ModelRowState.derive(
            providerEnabled: true, modelSelfEnabled: false, modelAvailable: true)
        let byProvider = ModelRowState.derive(
            providerEnabled: false, modelSelfEnabled: false, modelAvailable: true)
        XCTAssertEqual(bySelf, .disabledBySelf)
        XCTAssertNotEqual(bySelf, byProvider, "the two disabled causes get two looks")
    }

    func testUnavailableDominatesEverything() {
        let state = ModelRowState.derive(
            providerEnabled: true, modelSelfEnabled: true, modelAvailable: false)
        XCTAssertEqual(state, .unavailable)
    }

    func testBothOnIsEnabled() {
        let state = ModelRowState.derive(
            providerEnabled: true, modelSelfEnabled: true, modelAvailable: true)
        XCTAssertEqual(state, .enabled)
        XCTAssertTrue(state.isEffectivelyEnabled)
    }

    // MARK: Policy mutations and chains

    private var fixtureSnapshot: ModelControlSnapshot {
        let opus = DiscoveredModel(
            provider: "claude", canonicalId: "claude-opus-4-8", launchToken: "claude-opus-4-8",
            displayName: "Opus 4.8",
            hidden: .known(false, surface: "claude.initialize", observedAt: ""),
            supportsEffort: .known(true, surface: "claude.initialize", observedAt: ""),
            supportedEffortLevels: .known(["low", "medium", "high"], surface: "claude.initialize", observedAt: ""),
            defaultEffort: .known("high", surface: "claude.initialize", observedAt: ""),
            observedAt: "")
        let effectiveDefault = EffectiveDefault(
            model: .known("claude-opus-4-8", surface: "claude.initialize", observedAt: ""),
            effort: .unknown(reason: "field-absent", surface: "claude.initialize", observedAt: ""))
        return ModelControlSnapshot(
            generatedAt: "2026-07-12T00:00:00Z",
            providers: [
                "claude": .available(models: [opus], effectiveDefault: effectiveDefault),
                "grok": .unavailable(reason: "grok CLI not signed in"),
            ],
            billing: [:],
            usageSurfaces: ["claude": .metered, "grok": UsageSurface.none],
            quota: nil,
            quotaError: "daemon not running")
    }

    func testChainReorderKeepsPrimaryAtIndexZero() {
        let a = ChainEntry(target: .exact(provider: "claude", model: "a", variant: nil), effort: .exact("high"))
        let b = ChainEntry(target: .exact(provider: "codex", model: "b", variant: nil), effort: .providerControlled)
        let c = ChainEntry(target: .vendorDefault(provider: "grok"), effort: .none)
        let moved = ModelControlPolicy.move([a, b, c], from: 2, to: 0)
        XCTAssertEqual(moved, [c, a, b])
        XCTAssertEqual(ModelControlPolicy.move([a, b, c], from: 5, to: 0), [a, b, c],
                       "out-of-range moves are no-ops")
    }

    func testEditsClearTheProvisionalFlag() {
        var policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        XCTAssertTrue(policy.provisional)
        policy.setProviderEnabled(.claude, false)
        XCTAssertFalse(policy.provisional)
    }

    func testSeedEnablesEveryDiscoveredProviderAndSkipsUnavailableInDefaultChain() {
        let policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        XCTAssertTrue(policy.providerEnabled(.claude))
        XCTAssertTrue(policy.providerEnabled(.grok))
        // grok's catalog is unavailable, so it cannot serve as a default link.
        XCTAssertEqual(policy.defaultChain.map(\.provider), ["claude"])
    }

    func testChainLinkStatusProviderOffWins() {
        var policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        policy.setProviderEnabled(.claude, false)
        let entry = ChainEntry(
            target: .exact(provider: "claude", model: "claude-opus-4-8", variant: nil),
            effort: .exact("high"))
        XCTAssertEqual(
            ChainLinkStatus.derive(entry: entry, policy: policy, snapshot: fixtureSnapshot),
            .providerOff)
    }

    func testChainLinkStatusUnresolvableWhenModelLeftCatalog() {
        let policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        let entry = ChainEntry(
            target: .exact(provider: "claude", model: "claude-3-opus", variant: nil),
            effort: .providerControlled)
        XCTAssertEqual(
            ChainLinkStatus.derive(entry: entry, policy: policy, snapshot: fixtureSnapshot),
            .unresolvable)
    }

    func testChainLinkStatusModelDisabled() {
        var policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        policy.setModelEnabled(provider: .claude, modelId: "claude-opus-4-8", false)
        let entry = ChainEntry(
            target: .exact(provider: "claude", model: "claude-opus-4-8", variant: nil),
            effort: .providerControlled)
        XCTAssertEqual(
            ChainLinkStatus.derive(entry: entry, policy: policy, snapshot: fixtureSnapshot),
            .modelDisabled)
    }

    func testWarningsFireOnAllProvidersOffAndEmptyDefaultChain() {
        var policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        policy.setProviderEnabled(.claude, false)
        policy.setProviderEnabled(.grok, false)
        policy.defaultChain = []
        let warnings = PolicyWarning.derive(policy: policy, snapshot: fixtureSnapshot)
        XCTAssertTrue(warnings.contains(.noProvidersEnabled))
        XCTAssertTrue(warnings.contains(.defaultChainEmpty))
    }

    // MARK: Billing chips

    func testBillingChipStates() {
        XCTAssertEqual(
            BillingChip.derive(from: BillingSnapshot(
                creditsEnabled: .known(false, surface: "t", observedAt: ""),
                generalUtilization: .unknown(reason: "field-absent", surface: "t", observedAt: ""))),
            .paidOverflowOff)
        XCTAssertEqual(
            BillingChip.derive(from: BillingSnapshot(
                creditsEnabled: .known(true, surface: "t", observedAt: ""),
                generalUtilization: .unknown(reason: "field-absent", surface: "t", observedAt: ""))),
            .creditsAvailable)
        XCTAssertEqual(
            BillingChip.derive(from: BillingSnapshot(
                creditsEnabled: .unknown(reason: "surface-silent", surface: "t", observedAt: ""),
                generalUtilization: .unknown(reason: "surface-silent", surface: "t", observedAt: ""))),
            .unknown, "an unreadable credit flag is unknown, never off")
        XCTAssertEqual(BillingChip.derive(from: nil), .unknown)
    }

    // MARK: Wire decoding

    func testSnapshotDecodesThreeValuedEffortAndFourthProvider() throws {
        let json = """
        {
          "generatedAt": "2026-07-12T22:00:00Z",
          "providers": {
            "grok": {
              "status": "ok",
              "records": [{
                "provider": "grok",
                "canonicalId": "grok-composer-2.5-fast",
                "variant": null,
                "launchToken": "grok-composer-2.5-fast",
                "displayName": null,
                "hidden": {"state": "known", "value": false, "surface": "grok.models_cache", "observedAt": "2026-07-12T21:59:00Z"},
                "supportsEffort": {"state": "known", "value": false, "surface": "grok.models_cache", "observedAt": "2026-07-12T21:59:00Z"},
                "supportedEffortLevels": {"state": "unknown", "reason": "field-absent", "surface": "grok.models_cache", "observedAt": "2026-07-12T21:59:00Z"},
                "defaultEffort": {"state": "unknown", "reason": "field-absent", "surface": "grok.models_cache", "observedAt": "2026-07-12T21:59:00Z"},
                "observedAt": "2026-07-12T21:59:00Z"
              }],
              "effectiveDefault": {
                "model": {"state": "known", "value": "grok-4.5", "surface": "grok.models", "observedAt": "2026-07-12T21:59:00Z"},
                "effort": {"state": "unknown", "reason": "surface-silent", "surface": "grok.models", "observedAt": "2026-07-12T21:59:00Z"}
              }
            },
            "newvendor": {"status": "unavailable", "reason": "no driver signed in"}
          },
          "billing": {"grok": null},
          "usageSurfaces": {"grok": "none", "newvendor": "metered"},
          "quota": null,
          "quotaError": "daemon not running"
        }
        """
        let snapshot = try ModelControlSnapshot.decode(from: Data(json.utf8))
        // The fourth-provider test: an id the render layer has never heard of
        // decodes and appears in the provider list.
        XCTAssertTrue(snapshot.providerIDs.contains(ProviderID("newvendor")))
        guard case .available(let models, _)? = snapshot.providers["grok"] else {
            return XCTFail("grok catalog should decode as available")
        }
        XCTAssertEqual(EffortAxis.derive(from: models[0]), .none,
                       "supports_reasoning_effort=false must decode to known-none")
        XCTAssertEqual(snapshot.usageSurfaces["grok"], UsageSurface.none)
        XCTAssertNil(snapshot.quota, "an unreachable daemon decodes as unknown quota, not empty")
    }
}
