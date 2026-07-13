import XCTest
@testable import WorkspaceCore

/// The Model Control Center's honesty rules, as tests. Each of these is a way
/// the screen could lie if it regressed:
/// - a missing reading rendering as a 0% meter
/// - Grok's money rails rendering as a gauge
/// - "vendor said no effort axis" conflated with "could not read effort axis"
/// - a provider-off model row still reading as enabled
final class ModelControlTests: XCTestCase {

    func testMCCCommandsCarryTheWindowDaemonPort() {
        XCTAssertEqual(
            ModelControlCommand.arguments(
                ["model-control-snapshot"], daemonPort: 4317),
            ["model-control-snapshot", "--port", "4317"])
        XCTAssertEqual(
            ModelControlCommand.arguments(
                ["routing", "export"], daemonPort: 4317),
            ["routing", "export", "--port", "4317"])
        XCTAssertEqual(
            ModelControlCommand.arguments(
                ["routing", "set-provider", "claude", "enabled",
                 "--expect-revision", "8"], daemonPort: 4483),
            ["routing", "set-provider", "claude", "enabled",
             "--expect-revision", "8", "--port", "4483"])
    }

    // MARK: Meter derivation — unknown is not zero

    private func window(
        used: Double? = nil, remainingPct: Double? = nil, allowance: Double? = nil,
        unit: String = "percent", confidence: String = "reported",
        windowMinutes: Double? = nil
    ) -> QuotaWindow {
        QuotaWindow(
            unit: unit, allowance: allowance, used: used,
            remainingPct: remainingPct, confidence: confidence, source: "provider",
            windowMinutes: windowMinutes)
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

    // Claude meters BOTH windows, so a discovered Claude pool carries both
    // durations even when a window's reading is momentarily absent — the silent
    // feed of §2.2 drops the reading, never the window. The durations are what
    // tell a silent window apart from one the plan does not have at all.
    private func claudePool(fiveHourUsed: Double?) -> QuotaEntry {
        .pool(QuotaPool(
            provider: "claude", pool: "plan", origin: "discovered",
            confidence: "reported", freshness: "fresh", source: "provider",
            fiveHour: window(used: fiveHourUsed, allowance: 100, windowMinutes: 300),
            weekly: window(used: nil, windowMinutes: 10_080)))
    }

    /// Codex's `prolite` plan, as captured off the wire on 2026-07-13: ONE
    /// weekly window at 31%, and no five-hour window at all (`secondary` is null
    /// in the payload). See src/daemon/fixtures/codex-rate-limits-prolite.json.
    private func codexProlitePool() -> QuotaEntry {
        .pool(QuotaPool(
            provider: "codex", pool: "codex", origin: "discovered",
            label: "prolite",
            confidence: "authoritative", freshness: "fresh", source: "provider",
            fiveHour: window(used: nil, confidence: "missing"),
            weekly: window(
                used: 31, allowance: 100,
                confidence: "authoritative", windowMinutes: 10_080)))
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

    // The bug: Codex's five-hour slot was rendered "no reading for this window"
    // — the copy §7.4 reserves for a probe that failed closed — when the probe
    // had in fact succeeded and reported, authoritatively, that this plan has
    // no five-hour window. It must say "not metered", not "unknown": one blames
    // the plan (true), the other blames the probe (false).
    func testPlanWithNoFiveHourWindowSaysNotMeteredNotUnknown() {
        let usage = MeterDerivation.usage(
            provider: .codex, surface: .metered,
            quota: [codexProlitePool()], quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        XCTAssertEqual(windows.map(\.label), ["5 hour window", "7 day window"])

        XCTAssertEqual(
            windows[0].state, .notMetered,
            "a window this plan does not have must say so — .unknown would "
                + "claim a read failure that never happened")

        // And the window the plan DOES meter carries its real measured value.
        guard case .measured(let percent, _, _, let confidence) = windows[1].state else {
            return XCTFail("the weekly window IS measured, got \(windows[1].state)")
        }
        XCTAssertEqual(percent, 31)
        XCTAssertEqual(confidence, "authoritative")
    }

    // The two absences must never collapse into each other: "this plan has no
    // such window" and "this window has no reading" are different facts, and
    // rendering one as the other is the whole bug.
    func testNotMeteredAndUnknownAreDistinct() {
        XCTAssertNotEqual(MeterState.notMetered, .unknown(reason: "no reading for this window"))
    }

    // THE POSITIVE CONTROL. These bytes were not typed by hand and were not
    // copied from a description — they are what the daemon's own code (ac0979f)
    // emitted when run over the real captured Codex payload
    // (src/daemon/fixtures/codex-rate-limits-prolite.json).
    //
    // The first assertion is the whole point of the test: my reader must SEE
    // availability. A misspelled key would decode to nil, the derivation would
    // silently fall back to the old inference, the UI would still look right, and
    // nothing would ever tell me the explicit path was dead. An all-absent field
    // is indistinguishable from a quiet vendor — so prove the reader can see a
    // positive before trusting any negative.
    func testReaderActuallySeesAvailabilityOnTheRealEmittedWire() throws {
        let wire = """
        {"generatedAt":"2026-07-10T12:00:00.000Z","providers":{},"billing":{},
         "usageSurfaces":{"codex":"metered"},
         "quota":[{"provider":"codex","account":"default","pool":"codex",
          "origin":"discovered","models":["*"],"label":"prolite","routable":true,
          "confidence":"authoritative","freshness":"fresh","source":"provider",
          "fiveHour":{"availability":"not-metered","unit":"percent","allowance":null,
            "used":null,"reserved":null,"reservedIsEstimate":null,"remaining":null,
            "remainingPct":null,"resetsAt":null,"confidence":"authoritative",
            "source":"provider","observedAt":"2026-07-10T12:00:00.000Z",
            "windowMinutes":null},
          "weekly":{"availability":"available","unit":"percent","allowance":100,
            "used":31,"reserved":0,"reservedIsEstimate":true,"remaining":69,
            "remainingPct":0.69,"resetsAt":"2026-07-19T18:58:59.000Z",
            "confidence":"authoritative","source":"provider",
            "observedAt":"2026-07-10T12:00:00.000Z","windowMinutes":10080}}]}
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(ModelControlSnapshot.self, from: wire)
        let quota = try XCTUnwrap(snapshot.quota)
        guard case .pool(let pool) = quota[0] else { return XCTFail("expected a pool") }

        // The positive control: the field is READ, not silently absent.
        XCTAssertEqual(
            pool.fiveHour.availability, "not-metered",
            "the reader must see the vendor's own word — nil here means a dead "
                + "key that would fall back forever with no signal")
        XCTAssertEqual(pool.weekly.availability, "available")

        let usage = MeterDerivation.usage(
            provider: .codex, surface: .metered, quota: quota, quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        XCTAssertEqual(windows[0].state, .notMetered)
        guard case .measured(let percent, _, _, _) = windows[1].state else {
            return XCTFail("the weekly window IS measured, got \(windows[1].state)")
        }
        XCTAssertEqual(percent, 31)
    }

    // The daemon's word OVERRIDES the inference, and must: a window it calls
    // "unknown" is a failed read even if the duration went missing too. This is
    // the case the old heuristic got wrong, now settled by the vendor's own fact.
    func testExplicitUnknownBeatsTheInferenceEvenWithNoDuration() {
        let halfQuiet = QuotaEntry.pool(QuotaPool(
            provider: "codex", pool: "codex", origin: "discovered",
            confidence: "authoritative", freshness: "fresh", source: "provider",
            fiveHour: QuotaWindow(
                availability: "unknown", unit: "percent", used: nil,
                confidence: "missing", source: "none", windowMinutes: nil),
            weekly: QuotaWindow(
                availability: "available", unit: "percent", allowance: 100, used: 31,
                confidence: "authoritative", source: "provider", windowMinutes: 10_080)))
        let usage = MeterDerivation.usage(
            provider: .codex, surface: .metered, quota: [halfQuiet], quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        guard case .unknown = windows[0].state else {
            return XCTFail(
                "the daemon said unknown — a missing duration must not override it "
                    + "into a confident 'not metered', got \(windows[0].state)")
        }
    }

    // A window the plan does not meter has nothing reserved against it, and the
    // daemon says so with null rather than a 0 that would measure a window that
    // does not exist. This decodes the WIRE, not a struct we built ourselves,
    // because the hazard is a schema mismatch and a struct cannot express one.
    //
    // The blast radius is why this is pinned: QuotaEntry.init(from:) lets a
    // QuotaPool decode error propagate, so ONE non-decodable window fails the
    // whole snapshot — `quota` goes nil and the UI reports "the Hive daemon
    // could not be reached", blanking every provider and blaming the daemon for
    // what is really a type error. A null reserve must never do that.
    func testNullReserveOnANotMeteredWindowDecodesAndDoesNotBlankTheSnapshot() throws {
        let wire = """
        {"generatedAt":"2026-07-13T13:18:30.457Z","providers":{},"billing":{},
         "usageSurfaces":{"codex":"metered"},
         "quota":[
          {"provider":"codex","account":"default","pool":"codex","origin":"discovered",
           "models":["*"],"label":"prolite","routable":true,"confidence":"authoritative",
           "freshness":"fresh","source":"provider",
           "fiveHour":{"unit":"percent","allowance":null,"used":null,"reserved":null,
             "reservedIsEstimate":null,"remaining":null,"remainingPct":null,
             "resetsAt":null,"confidence":"missing","source":"none",
             "observedAt":null,"windowMinutes":null},
           "weekly":{"unit":"percent","allowance":100,"used":31,"reserved":1.5,
             "reservedIsEstimate":true,"remaining":67.5,"remainingPct":0.675,
             "resetsAt":"2026-07-19T18:58:59.000Z","confidence":"authoritative",
             "source":"provider","observedAt":"2026-07-13T13:18:30.457Z",
             "windowMinutes":10080}}
        ]}
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(ModelControlSnapshot.self, from: wire)
        let quota = try XCTUnwrap(
            snapshot.quota,
            "a null reserve must not fail the snapshot — nil quota here would "
                + "surface to the user as 'the daemon could not be reached'")
        XCTAssertEqual(quota.count, 1)

        // The numeric reserve on the metered window still round-trips.
        guard case .pool(let pool) = quota[0] else { return XCTFail("expected a pool") }
        XCTAssertNil(pool.fiveHour.reserved)
        XCTAssertEqual(pool.weekly.reserved, 1.5)

        // And the derivation still tells the two absences apart.
        let usage = MeterDerivation.usage(
            provider: .codex, surface: .metered, quota: quota, quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        XCTAssertEqual(windows[0].state, .notMetered)
        guard case .measured(let percent, _, _, _) = windows[1].state else {
            return XCTFail("the weekly window IS measured, got \(windows[1].state)")
        }
        XCTAssertEqual(percent, 31)
    }

    // Backwards compatibility: the daemon shipping today sends a NUMERIC reserve
    // on the not-metered window (reserved:8 against a window with no allowance).
    // Making the field optional must not break the wire that is live right now.
    func testNumericReserveFromTheCurrentDaemonStillDecodes() throws {
        let wire = """
        {"generatedAt":"2026-07-13T13:18:30.457Z","providers":{},"billing":{},
         "usageSurfaces":{"codex":"metered"},
         "quota":[
          {"provider":"codex","account":"default","pool":"codex","origin":"discovered",
           "models":["*"],"label":"prolite","routable":true,"confidence":"authoritative",
           "freshness":"fresh","source":"provider",
           "fiveHour":{"unit":"percent","allowance":null,"used":null,"reserved":8,
             "reservedIsEstimate":true,"remaining":null,"remainingPct":null,
             "resetsAt":"2026-07-13T15:24:58.589Z","confidence":"missing",
             "source":"none","observedAt":null,"windowMinutes":null},
           "weekly":{"unit":"percent","allowance":100,"used":31,"reserved":1.5,
             "reservedIsEstimate":true,"remaining":67.5,"remainingPct":0.675,
             "resetsAt":null,"confidence":"authoritative","source":"provider",
             "observedAt":"2026-07-13T13:18:30.457Z","windowMinutes":10080}}
        ]}
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(ModelControlSnapshot.self, from: wire)
        let quota = try XCTUnwrap(snapshot.quota)
        guard case .pool(let pool) = quota[0] else { return XCTFail("expected a pool") }
        XCTAssertEqual(pool.fiveHour.reserved, 8)
        XCTAssertEqual(windowsAreNotMetered(quota), true)
    }

    /// The five-hour window derives .notMetered regardless of what reserve the
    /// daemon happened to attach to it — the reserve is not what decides.
    private func windowsAreNotMetered(_ quota: [QuotaEntry]) -> Bool {
        guard case .metered(let windows) = MeterDerivation.usage(
            provider: .codex, surface: .metered, quota: quota, quotaError: nil)
        else { return false }
        return windows[0].state == .notMetered
    }

    // The lie this guard exists to prevent, and it was reachable: Claude's
    // get_usage emits a pool when EITHER window parses, so a partial read
    // (weekly present, five_hour missing) yields fiveHour: null — and the
    // ledger's upsert overwrites the previously-known 300 with that null
    // (ON CONFLICT DO UPDATE SET fiveHourWindowMinutes = excluded..., no
    // coalesce). The pool then looks EXACTLY like Codex's not-metered one:
    // used nil, windowMinutes nil, beside a readable weekly.
    //
    // The discriminator is authority. Claude's feed is "reported" and
    // experimental (§2.2); it may not assert that a plan lacks a window. Telling
    // a Max-plan user "your plan does not meter a 5 hour window" is the original
    // bug inverted — a confident lie rather than a timid one, and worse.
    func testPartiallySilentClaudeFeedIsUnknownNotNotMetered() {
        let halfQuiet = QuotaEntry.pool(QuotaPool(
            provider: "claude", pool: "subscription", origin: "discovered",
            label: "max",
            confidence: "reported", freshness: "fresh", source: "provider",
            // The overwritten duration — indistinguishable from Codex's
            // not-metered window on every field EXCEPT the pool's authority.
            fiveHour: window(used: nil, confidence: "missing"),
            weekly: window(
                used: 57, allowance: 100,
                confidence: "reported", windowMinutes: 10_080)))
        let usage = MeterDerivation.usage(
            provider: .claude, surface: .metered, quota: [halfQuiet], quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        guard case .unknown = windows[0].state else {
            return XCTFail(
                "a merely-reported source may not claim a plan lacks a window — "
                    + "expected .unknown, got \(windows[0].state)")
        }
        XCTAssertNotEqual(
            windows[0].state, .notMetered,
            "this is a Max plan with a five-hour window; saying otherwise is a lie")
    }

    // Nothing here encodes "Codex has no five-hour window" — the decision is
    // made from what the payload reports. The SAME provider on a plan that does
    // expose a five-hour window must light it up with no code change, or we have
    // just hardcoded today's plan into tomorrow's bug.
    func testSameProviderOnAPlanThatDoesMeterFiveHoursLightsItUp() {
        let plus = QuotaEntry.pool(QuotaPool(
            provider: "codex", pool: "codex", origin: "discovered", label: "plus",
            confidence: "authoritative", freshness: "fresh", source: "provider",
            fiveHour: window(
                used: 57, allowance: 100,
                confidence: "authoritative", windowMinutes: 300),
            weekly: window(
                used: 40, allowance: 100,
                confidence: "authoritative", windowMinutes: 10_080)))
        let usage = MeterDerivation.usage(
            provider: .codex, surface: .metered, quota: [plus], quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        guard case .measured(let percent, _, _, _) = windows[0].state else {
            return XCTFail("a plan that reports a five-hour window must meter it, "
                + "got \(windows[0].state)")
        }
        XCTAssertEqual(percent, 57)
    }

    // The other half of the distinction, and the one that must not regress: a
    // window the provider DOES meter, whose reading is merely absent, still
    // mounts and still says unknown. Suppressing that would hide Claude's silent
    // feed instead of showing it.
    func testMeteredWindowWithNoReadingStaysMountedAsUnknown() {
        let usage = MeterDerivation.usage(
            provider: .claude, surface: .metered,
            quota: [claudePool(fiveHourUsed: 63)], quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        XCTAssertEqual(windows.map(\.label), ["5 hour window", "7 day window"])
        guard case .unknown = windows[1].state else {
            return XCTFail("a metered window with no reading must stay unknown")
        }
    }

    // A pool that answered nothing at all is not evidence that its windows do
    // not exist. Without a reading anywhere, both windows stay mounted and the
    // silence shows — "we could not read" is not "there is nothing to read".
    func testPoolWithNoReadingAnywhereKeepsBothWindows() {
        let silent = QuotaEntry.pool(QuotaPool(
            provider: "codex", pool: "codex", origin: "discovered",
            confidence: "missing", freshness: "missing", source: "none",
            fiveHour: window(used: nil, confidence: "missing"),
            weekly: window(used: nil, confidence: "missing")))
        let usage = MeterDerivation.usage(
            provider: .codex, surface: .metered, quota: [silent], quotaError: nil)
        guard case .metered(let windows) = usage else {
            return XCTFail("expected meters, got \(usage)")
        }
        XCTAssertEqual(windows.map(\.label), ["5 hour window", "7 day window"])
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

    // MARK: Model rows — provider-off dominates; three off-reasons never collapse

    func testProviderOffOverridesModelOn() {
        let state = ModelRowState.derive(
            providerEnabled: false, enablement: .enabled, modelAvailable: true)
        XCTAssertEqual(state, .disabledByProvider(preferenceOn: true))
        XCTAssertFalse(state.isEffectivelyEnabled,
                       "a model under a disabled provider is never effective")
    }

    func testProviderOffPreservesStoredPreferenceForDisplay() {
        let offPreference = ModelRowState.derive(
            providerEnabled: false, enablement: .disabledByUser, modelAvailable: true)
        XCTAssertEqual(offPreference, .disabledByProvider(preferenceOn: false))
    }

    func testThreeOffReasonsAreThreeDistinctStates() {
        let seeded = ModelRowState.derive(
            providerEnabled: true, enablement: .seededOff, modelAvailable: true)
        let bySelf = ModelRowState.derive(
            providerEnabled: true, enablement: .disabledByUser, modelAvailable: true)
        let byProvider = ModelRowState.derive(
            providerEnabled: false, enablement: .disabledByUser, modelAvailable: true)
        XCTAssertEqual(seeded, .seededOff)
        XCTAssertEqual(bySelf, .disabledBySelf)
        XCTAssertEqual(byProvider, .disabledByProvider(preferenceOn: false))
        XCTAssertNotEqual(seeded, bySelf, "awaiting-consent and user-off never merge")
        XCTAssertFalse(seeded.isEffectivelyEnabled,
                       "a seeded-off model cannot spawn — that is the consent guarantee")
    }

    func testProviderOffDominatesSeededOff() {
        let state = ModelRowState.derive(
            providerEnabled: false, enablement: .seededOff, modelAvailable: true)
        XCTAssertEqual(state, .disabledByProvider(preferenceOn: false))
    }

    func testUnavailableDominatesEverything() {
        let state = ModelRowState.derive(
            providerEnabled: true, enablement: .enabled, modelAvailable: false)
        XCTAssertEqual(state, .unavailable)
    }

    func testBothOnIsEnabled() {
        let state = ModelRowState.derive(
            providerEnabled: true, enablement: .enabled, modelAvailable: true)
        XCTAssertEqual(state, .enabled)
        XCTAssertTrue(state.isEffectivelyEnabled)
    }

    // MARK: Consent is enablement

    private var grokAvailableSnapshot: ModelControlSnapshot {
        let composer = model(
            supportsEffort: .known(false, surface: "grok.models_cache", observedAt: ""),
            levels: .unknown(reason: "field-absent", surface: "grok.models_cache", observedAt: ""))
        let effectiveDefault = EffectiveDefault(
            model: .known("grok-4.5", surface: "grok.models", observedAt: ""),
            effort: .unknown(reason: "surface-silent", surface: "grok.models", observedAt: ""))
        var snapshot = fixtureSnapshot
        snapshot.providers["grok"] = .available(
            models: [composer], effectiveDefault: effectiveDefault)
        snapshot.billing = [
            "claude": BillingSnapshot(
                creditsEnabled: .known(false, surface: "claude.get_usage", observedAt: ""),
                generalUtilization: .known(44, surface: "claude.get_usage", observedAt: "")),
            "grok": nil,
        ]
        return snapshot
    }

    func testUnreadableBillingSeedsModelsOffAwaitingConsent() {
        let policy = ProvisionalPolicyStore.seed(from: grokAvailableSnapshot)
        // Grok's billing is unreadable → its models ship OFF, visible,
        // awaiting consent. Claude's billing is verified covered → enabled.
        XCTAssertEqual(
            policy.rowState(provider: .grok, modelId: "m", available: true),
            .seededOff)
        XCTAssertEqual(
            policy.rowState(provider: .claude, modelId: "claude-opus-4-8", available: true),
            .enabled)
    }

    func testNewlyDiscoveredModelUnderUnverifiedVendorArrivesSeededOff() {
        // A model that appears AFTER seeding (no explicit policy entry)
        // inherits seededOff — it must never arrive silently consented.
        let policy = ProvisionalPolicyStore.seed(from: grokAvailableSnapshot)
        XCTAssertEqual(
            policy.rowState(provider: .grok, modelId: "grok-5-new", available: true),
            .seededOff)
    }

    func testFlippingSeededOffOnIsConsentAndOffAgainIsUserOffNotSeeded() {
        var policy = ProvisionalPolicyStore.seed(from: grokAvailableSnapshot)
        policy.setModelEnabled(provider: .grok, modelId: "m", true)
        XCTAssertEqual(
            policy.rowState(provider: .grok, modelId: "m", available: true),
            .enabled, "flipping on is the consent")
        policy.setModelEnabled(provider: .grok, modelId: "m", false)
        XCTAssertEqual(
            policy.rowState(provider: .grok, modelId: "m", available: true),
            .disabledBySelf,
            "a user off is a user off — only seeding writes seededOff")
    }

    func testSeededOffProviderIsExcludedFromTheSeededDefaultChain() {
        let policy = ProvisionalPolicyStore.seed(from: grokAvailableSnapshot)
        XCTAssertEqual(policy.defaultChain.map(\.provider), ["claude"],
                       "an unconsented vendor must not be pre-wired into the fallback")
    }

    func testSpendCaveatStates() {
        // Verified covered: credits known OFF — a plan wall, not a bill.
        XCTAssertNil(SpendCaveat.derive(from: BillingSnapshot(
            creditsEnabled: .known(false, surface: "t", observedAt: ""),
            generalUtilization: .known(44, surface: "t", observedAt: ""))))
        // Credits known ON: enabling may genuinely spend.
        XCTAssertNotNil(SpendCaveat.derive(from: BillingSnapshot(
            creditsEnabled: .known(true, surface: "t", observedAt: ""),
            generalUtilization: .unknown(reason: "field-absent", surface: "t", observedAt: ""))))
        // Overflow switch unreadable (Codex auto-top-up): caveat with reason.
        let codex = SpendCaveat.derive(from: BillingSnapshot(
            creditsEnabled: .unknown(reason: "field-absent", surface: "t", observedAt: ""),
            generalUtilization: .known(10, surface: "t", observedAt: ""),
            overflowUncertainty: "Codex may auto-purchase credits; the setting is not exposed"))
        XCTAssertEqual(codex, "Codex may auto-purchase credits; the setting is not exposed")
        // Billing unreadable end-to-end (Grok): caveat.
        XCTAssertNotNil(SpendCaveat.derive(from: nil))
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
            billing: [
                "claude": BillingSnapshot(
                    creditsEnabled: .known(false, surface: "claude.get_usage", observedAt: ""),
                    generalUtilization: .known(44, surface: "claude.get_usage", observedAt: "")),
                "grok": nil,
            ],
            usageSurfaces: ["claude": .metered, "grok": UsageSurface.none],
            quota: nil,
            quotaError: "daemon not running")
    }

    func testChainReorderKeepsPrimaryAtIndexZero() {
        let a = ChainEntry(provider: "claude", model: "a", effort: .exact("high"))
        let b = ChainEntry(provider: "codex", model: "b", effort: .providerControlled)
        let c = ChainEntry(provider: "grok", model: "grok-4.5", effort: .none)
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

    // MARK: The provisional routing table — the atom is (model, effort)

    /// Two consented providers, one with a full effort axis and one whose
    /// vendor states there is no effort axis.
    private var routingTableSnapshot: ModelControlSnapshot {
        var snapshot = grokAvailableSnapshot
        snapshot.billing["grok"] = BillingSnapshot(
            creditsEnabled: .known(false, surface: "grok._x.ai/billing", observedAt: ""),
            generalUtilization: .unknown(reason: "surface-silent", surface: "grok._x.ai/billing", observedAt: ""))
        return snapshot
    }

    func testEveryCategorySeedsAChainWithReasoning() {
        let policy = ProvisionalPolicyStore.seed(from: routingTableSnapshot)
        for category in TaskCategory.allCases {
            let chain = policy.categoryPolicy(category).chain
            XCTAssertFalse(chain.isEmpty, "\(category.rawValue) should ship pre-filled")
            for entry in chain {
                XCTAssertEqual(entry.confidence, .assumed,
                               "nothing claims evidence that does not exist")
                XCTAssertTrue(entry.note?.contains("Assumed order") == true,
                              "every seeded row says why it was chosen")
            }
        }
        XCTAssertFalse(policy.defaultChain.isEmpty)
    }

    func testSameModelSeedsAtDifferentEffortsInDifferentCategories() {
        // The whole feature: fable-5@high for complex coding and fable-5@low
        // for summarization are two different placeable routing choices.
        let policy = ProvisionalPolicyStore.seed(from: routingTableSnapshot)
        let complex = policy.categoryPolicy(.complexCoding).chain
            .first { $0.provider == "claude" }
        let summarize = policy.categoryPolicy(.summarization).chain
            .first { $0.provider == "claude" }
        guard let complexModel = complex?.model, let summaryModel = summarize?.model else {
            return XCTFail("claude should seed exact targets in both categories")
        }
        XCTAssertEqual(complexModel, summaryModel, "same model…")
        XCTAssertEqual(complex?.effort, .exact("high"))
        XCTAssertEqual(summarize?.effort, .exact("low"))
        XCTAssertNotEqual(complex?.effort, summarize?.effort, "…different atoms")
    }

    func testSeedingNeverInventsAnEffortLevel() {
        // Grok's model states it has NO effort axis: the seeded entry must be
        // effort .none — assignable, with nothing to pick — never a made-up
        // "high".
        let policy = ProvisionalPolicyStore.seed(from: routingTableSnapshot)
        let grokLink = policy.categoryPolicy(.complexCoding).chain
            .first { $0.provider == "grok" }
        XCTAssertNotNil(grokLink, "a consented grok is seeded — visible, usable")
        XCTAssertEqual(grokLink?.effort, EffortTarget.none)
    }

    func testCodeReviewLeadsWithADifferentVendor() {
        let policy = ProvisionalPolicyStore.seed(from: routingTableSnapshot)
        let review = policy.categoryPolicy(.codeReview).chain
        let complex = policy.categoryPolicy(.complexCoding).chain
        XCTAssertEqual(review.count, complex.count)
        XCTAssertNotEqual(review.first?.provider, complex.first?.provider,
                          "review prefers vendor independence")
    }

    func testChainLinkStatusProviderOffWins() {
        var policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        policy.setProviderEnabled(.claude, false)
        let entry = ChainEntry(
            provider: "claude", model: "claude-opus-4-8", effort: .exact("high"))
        XCTAssertEqual(
            ChainLinkStatus.derive(entry: entry, policy: policy, snapshot: fixtureSnapshot),
            .providerOff)
    }

    func testChainLinkStatusUnresolvableWhenModelLeftCatalog() {
        let policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        let entry = ChainEntry(
            provider: "claude", model: "claude-3-opus", effort: .providerControlled)
        XCTAssertEqual(
            ChainLinkStatus.derive(entry: entry, policy: policy, snapshot: fixtureSnapshot),
            .unresolvable)
    }

    func testChainLinkStatusModelDisabled() {
        var policy = ProvisionalPolicyStore.seed(from: fixtureSnapshot)
        policy.setModelEnabled(provider: .claude, modelId: "claude-opus-4-8", false)
        let entry = ChainEntry(
            provider: "claude", model: "claude-opus-4-8", effort: .providerControlled)
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

    // MARK: Display names — specific models, never "default"

    func testHumanNamePrefersTheVendorsOwnDisplayName() {
        var record = model(
            supportsEffort: .known(true, surface: "t", observedAt: ""),
            levels: .known(["low"], surface: "t", observedAt: ""))
        record.displayName = "Fable"
        XCTAssertEqual(record.humanName, "Fable")
    }

    func testHumanNameNeverDisplaysDefaultAsAModel() {
        // Claude's menu labels its alias entry "Default (recommended)". That
        // is an alias's label, not a model identity — the UI displays models.
        var record = model(
            supportsEffort: .known(true, surface: "t", observedAt: ""),
            levels: .known(["low"], surface: "t", observedAt: ""))
        record.provider = "claude"
        record.canonicalId = "claude-opus-4-8"
        record.displayName = "Default (recommended)"
        XCTAssertEqual(record.humanName, "Opus 4.8")
    }

    func testHumanNamePrettifiesTheVendorIdMechanically() {
        var record = model(
            supportsEffort: .known(true, surface: "t", observedAt: ""),
            levels: .known(["low"], surface: "t", observedAt: ""))
        record.provider = "claude"
        record.canonicalId = "claude-fable-5"
        record.displayName = nil
        XCTAssertEqual(record.humanName, "Fable 5")
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
