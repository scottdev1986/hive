//! §22 Input arbiter v1 — standalone ordering/claim/transaction logic.
//!
//! Owns: state machine, PTY write queue, claim-local input sequence, and the
//! automation transaction ledger. Writes bytes only through an injected
//! WriteSink (real PTY wiring is the host composition branch).
//!
//! Authority: docs/design/terminal-stack-transition.html §22; enums match
//! src/schemas/session-protocol.ts INPUT_ARBITER_STATES / INPUT_EVIDENCE_LEVELS.
//! Does not invent timeouts, states, or evidence meanings.

const std = @import("std");

/// Wire/schema state names (INPUT_ARBITER_STATES). HUMAN_GESTURE and
/// AUTOMATION_COMMITTED are transient through-states; callers observe them only
/// if they sample mid-transition (the public API completes the through-step).
pub const State = enum {
    free,
    human_gesture,
    human_owned,
    human_orphaned,
    automation_buffering,
    automation_committed,
    terminating,
    closed,

    pub fn wireName(self: State) []const u8 {
        return switch (self) {
            .free => "FREE",
            .human_gesture => "HUMAN_GESTURE",
            .human_owned => "HUMAN_OWNED",
            .human_orphaned => "HUMAN_ORPHANED",
            .automation_buffering => "AUTOMATION_BUFFERING",
            .automation_committed => "AUTOMATION_COMMITTED",
            .terminating => "TERMINATING",
            .closed => "CLOSED",
        };
    }
};

/// Evidence ladder values are typed and never inferred from elapsed time (§22).
pub const EvidenceLevel = enum {
    buffered,
    committed,
    written,
    provider_observed,

    pub fn wireName(self: EvidenceLevel) []const u8 {
        return switch (self) {
            .buffered => "buffered",
            .committed => "committed",
            .written => "written",
            .provider_observed => "provider-observed",
        };
    }
};

pub const SubmitAction = enum { none, @"return", control_enter };

pub const ReleaseKind = enum { submit, cancel };

/// Injected PTY write sink — unit tests use a mock; production wires the PTY.
pub const WriteSink = struct {
    context: *anyopaque,
    writeFn: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,
    closeFn: *const fn (context: *anyopaque) void,

    pub fn write(self: WriteSink, bytes: []const u8) anyerror!void {
        return self.writeFn(self.context, bytes);
    }

    pub fn close(self: WriteSink) void {
        self.closeFn(self.context);
    }
};

/// Injected encoder: turns verified automation body + submit into PTY bytes.
/// Isolation tests pass an identity/mock encoder; host composition owns VT.
/// `allocator` is the arbiter's allocator — WP4-B must use it for `out` growth (M6).
pub const Encoder = struct {
    context: *anyopaque,
    encodeFn: *const fn (
        context: *anyopaque,
        allocator: std.mem.Allocator,
        body: []const u8,
        submit: SubmitAction,
        out: *std.ArrayList(u8),
    ) anyerror!void,

    pub fn encode(
        self: Encoder,
        allocator: std.mem.Allocator,
        body: []const u8,
        submit: SubmitAction,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        return self.encodeFn(self.context, allocator, body, submit, out);
    }
};

/// Provider-specific cancel encoding for operator discard while orphaned.
pub const CancelEncoder = struct {
    context: *anyopaque,
    encodeFn: *const fn (
        context: *anyopaque,
        allocator: std.mem.Allocator,
        out: *std.ArrayList(u8),
    ) anyerror!void,

    pub fn encode(
        self: CancelEncoder,
        allocator: std.mem.Allocator,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        return self.encodeFn(self.context, allocator, out);
    }
};

pub const Error = error{
    HumanOwned,
    HumanOrphaned,
    InputBusy,
    NotReady,
    AlreadyExists,
    Malformed,
    PayloadTooLarge,
    CapacityExceeded,
    GenerationMismatch,
    Closed,
    Internal,
    /// Sink rejected the write after the ledger secured a committed entry (N2).
    SinkWriteFailed,
};

pub const ByteRange = struct {
    start: u64,
    end_exclusive: u64,
};

pub const TransactionResult = struct {
    evidence: EvidenceLevel,
    /// null when evidence is committed-not-written (planned only; not a written claim).
    byte_range: ?ByteRange,
    /// Borrowed pointer into the arbiter's ledger entry; valid until the
    /// arbiter is deinited or the ledger entry is removed. Callers must NOT free.
    result_label: []const u8,
};

const LedgerEntry = struct {
    idempotency_key: []u8,
    digest: [32]u8,
    /// Opaque locator/epoch/message identity retained for MALFORMED reuse checks.
    locator: []u8,
    epoch: u64,
    message_id: []u8,
    transaction_id: []u8,
    /// Host write-queue owned range (P3 / §22:1348 committed). Populated at
    /// entry creation with the planned range; evidence stays .committed until
    /// the sink accepts the bytes (.written).
    byte_range: ?ByteRange,
    /// Planned write offset reserved at commit (same as byte_range.start when set).
    planned_start: u64,
    planned_len: usize,
    evidence: EvidenceLevel,
    result_label: []u8,
    /// Encoded PTY bytes retained until written/cancel/disconnect/exit (sink retry).
    /// §22:1337 durable key fields do not include this; it is ephemeral retry state
    /// and MUST be zeroed on commit, cancel, disconnect, and exit (§22:1338 / P1).
    encoded: ?[]u8,

    fn deinit(self: *LedgerEntry, allocator: std.mem.Allocator) void {
        allocator.free(self.idempotency_key);
        allocator.free(self.locator);
        allocator.free(self.message_id);
        allocator.free(self.transaction_id);
        allocator.free(self.result_label);
        if (self.encoded) |buf| {
            std.crypto.secureZero(u8, buf);
            allocator.free(buf);
        }
        self.* = undefined;
    }
};

const HumanSeqRecord = struct {
    sequence: u64,
    digest: [32]u8,
    byte_range: ByteRange,
    /// Original evidence at first acceptance — dedup must not downgrade (L1).
    evidence: EvidenceLevel,
};

/// §18 automated message cap: 1 MiB.
pub const automated_message_max_bytes: usize = 1024 * 1024;
/// Fixed-cap encode bound: worst-case C0-safe expansion + framing/submit slack (P4 / §22:1338).
/// Encoders must stay within this; excess fails without realloc. Non-core-dump memory
/// where available is an open WP4-B item (§22:1338).
pub const encoded_expansion_factor: usize = 4;
pub const encoded_framing_slack: usize = 256;

fn encodedCapacityForBody(body_len: usize) usize {
    return body_len * encoded_expansion_factor + encoded_framing_slack;
}

pub const InputArbiter = struct {
    allocator: std.mem.Allocator,
    sink: WriteSink,
    encoder: Encoder,
    cancel_encoder: CancelEncoder,

    state: State = .free,

    // Claim / human authoring
    claim_id: ?[]u8 = null,
    owner_viewer_id: ?[]u8 = null,
    /// Next claim-local sequence the host expects (monotone, starts at 1 after claim).
    next_input_seq: u64 = 0,
    /// Highest sequence the host write queue has accepted.
    last_acked_seq: u64 = 0,
    human_records: std.ArrayList(HumanSeqRecord) = .{},

    // Automation buffer (plaintext; zeroed on commit/cancel/disconnect/exit)
    txn_id: ?[]u8 = null,
    idempotency_key: ?[]u8 = null,
    expected_len: usize = 0,
    expected_digest: [32]u8 = [_]u8{0} ** 32,
    recipient_generation: u64 = 0,
    capability_epoch: u64 = 0,
    message_id: ?[]u8 = null,
    locator: ?[]u8 = null,
    provider_strategy: ?[]u8 = null,
    submit: SubmitAction = .none,
    buffer: []u8 = &[_]u8{},
    buffer_len: usize = 0,

    // Ordered PTY write high-water (exclusive next byte offset owned by queue/written).
    write_high_water: u64 = 0,

    ledger: std.ArrayList(LedgerEntry) = .{},

    /// Injected visibility-lease currency. Human claim never times out into FREE;
    /// orphan survival requires this to remain true (§22).
    /// Structural invariant (no timed unlock): this module has no clock, timer,
    /// Thread, or sleep — only an injected boolean lease flag and explicit
    /// onVisibilityLeaseExpired. Orphan→FREE is never automatic.
    lease_current: bool = true,

    /// Last CLAIM_RELEASE kind (submit vs cancel). Encoding is supplied by the
    /// host/provider adapter via `encoded_release`; the arbiter records the
    /// distinction for inspection (§22 table separates the two effects; M8).
    last_release_kind: ?ReleaseKind = null,

    pub fn init(
        allocator: std.mem.Allocator,
        sink: WriteSink,
        encoder: Encoder,
        cancel_encoder: CancelEncoder,
    ) InputArbiter {
        return .{
            .allocator = allocator,
            .sink = sink,
            .encoder = encoder,
            .cancel_encoder = cancel_encoder,
        };
    }

    pub fn deinit(self: *InputArbiter) void {
        self.zeroAndFreeAutomationBuffers();
        self.clearClaim();
        for (self.ledger.items) |*entry| entry.deinit(self.allocator);
        self.ledger.deinit(self.allocator);
        self.human_records.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn currentState(self: *const InputArbiter) State {
        return self.state;
    }

    pub fn setLeaseCurrent(self: *InputArbiter, current: bool) void {
        self.lease_current = current;
    }

    /// When the visibility lease expires while a human claim is orphaned (or
    /// still owned), enter termination rather than releasing to automation.
    pub fn onVisibilityLeaseExpired(self: *InputArbiter) Error!void {
        self.lease_current = false;
        switch (self.state) {
            .human_owned, .human_orphaned, .automation_buffering, .free, .human_gesture, .automation_committed => {
                try self.terminate();
            },
            .terminating, .closed => {},
        }
    }

    // ── FREE → HUMAN_OWNED (CLAIM_ACQUIRE) ──────────────────────────────────

    pub const ClaimResult = struct {
        claim_id: []const u8,
        next_sequence: u64,
    };

    pub fn claimAcquire(
        self: *InputArbiter,
        viewer_id: []const u8,
        claim_id: []const u8,
    ) Error!ClaimResult {
        try self.requireLive();
        switch (self.state) {
            .free => {},
            .human_owned => return error.HumanOwned,
            .human_orphaned => return error.HumanOrphaned,
            .automation_buffering, .automation_committed => return error.InputBusy,
            .human_gesture => return error.InputBusy,
            .terminating, .closed => return error.Closed,
        }
        if (!self.lease_current) return error.NotReady;

        const owned_claim = self.allocator.dupe(u8, claim_id) catch return error.Internal;
        errdefer self.allocator.free(owned_claim);
        const owned_viewer = self.allocator.dupe(u8, viewer_id) catch return error.Internal;
        errdefer self.allocator.free(owned_viewer);

        self.claim_id = owned_claim;
        self.owner_viewer_id = owned_viewer;
        self.next_input_seq = 1;
        self.last_acked_seq = 0;
        self.human_records.clearRetainingCapacity();
        self.state = .human_owned;

        return .{
            .claim_id = self.claim_id.?,
            .next_sequence = self.next_input_seq,
        };
    }

    // ── FREE → HUMAN_GESTURE → FREE (non-authoring gesture) ─────────────────

    pub fn gestureInput(self: *InputArbiter, encoded: []const u8) Error!ByteRange {
        try self.requireLive();
        if (self.state != .free) {
            return switch (self.state) {
                .human_owned => error.HumanOwned,
                .human_orphaned => error.HumanOrphaned,
                .automation_buffering, .automation_committed, .human_gesture => error.InputBusy,
                .terminating, .closed => error.Closed,
                .free => unreachable,
            };
        }
        self.state = .human_gesture;
        const range = self.enqueueAndWrite(encoded) catch {
            self.state = .free;
            return error.Internal;
        };
        self.state = .free;
        return range;
    }

    // ── HUMAN_OWNED + HUMAN_INPUT ───────────────────────────────────────────

    pub fn humanInput(
        self: *InputArbiter,
        viewer_id: []const u8,
        claim_id: []const u8,
        sequence: u64,
        digest: [32]u8,
        encoded: []const u8,
    ) Error!struct { evidence: EvidenceLevel, byte_range: ByteRange, duplicate: bool } {
        try self.requireLive();
        if (self.state != .human_owned) {
            return switch (self.state) {
                .human_orphaned => error.HumanOrphaned,
                .free => error.NotReady,
                .automation_buffering, .automation_committed, .human_gesture => error.InputBusy,
                .terminating, .closed => error.Closed,
                .human_owned => unreachable,
            };
        }
        if (self.owner_viewer_id == null or self.claim_id == null)
            return error.Internal;
        if (!std.mem.eql(u8, self.owner_viewer_id.?, viewer_id) or
            !std.mem.eql(u8, self.claim_id.?, claim_id))
            return error.HumanOwned;

        // Deduplicate by sequence+digest; return stored original evidence (L1).
        for (self.human_records.items) |rec| {
            if (rec.sequence == sequence) {
                if (!std.mem.eql(u8, &rec.digest, &digest)) return error.Malformed;
                return .{ .evidence = rec.evidence, .byte_range = rec.byte_range, .duplicate = true };
            }
        }
        if (sequence != self.next_input_seq) return error.Malformed;

        // Verify digest of the payload the host will own.
        var hasher = std.crypto.hash.sha2.Sha256.init(.{});
        hasher.update(encoded);
        var got: [32]u8 = undefined;
        hasher.final(&got);
        if (!std.mem.eql(u8, &got, &digest)) return error.Malformed;

        const range = self.enqueueAndWrite(encoded) catch return error.Internal;
        const evidence: EvidenceLevel = .written;
        self.human_records.append(self.allocator, .{
            .sequence = sequence,
            .digest = digest,
            .byte_range = range,
            .evidence = evidence,
        }) catch return error.Internal;
        self.last_acked_seq = sequence;
        self.next_input_seq = sequence + 1;
        // ACK only after the host write queue owns the bytes; sink accepted → written.
        return .{ .evidence = evidence, .byte_range = range, .duplicate = false };
    }

    // ── HUMAN_OWNED + CLAIM_RELEASE ─────────────────────────────────────────

    pub fn claimRelease(
        self: *InputArbiter,
        viewer_id: []const u8,
        claim_id: []const u8,
        kind: ReleaseKind,
        encoded_release: []const u8,
    ) Error!ByteRange {
        try self.requireLive();
        if (self.state != .human_owned) {
            return switch (self.state) {
                .human_orphaned => error.HumanOrphaned,
                .free => error.NotReady,
                else => error.InputBusy,
            };
        }
        if (self.owner_viewer_id == null or self.claim_id == null)
            return error.Internal;
        if (!std.mem.eql(u8, self.owner_viewer_id.?, viewer_id) or
            !std.mem.eql(u8, self.claim_id.?, claim_id))
            return error.HumanOwned;

        // Release only after all prior claim bytes and the encoded submit/cancel
        // bytes are accepted by the ordered write queue.
        //
        // M8: `kind` is the §22 submit vs cancel distinction. The provider
        // adapter (host composition) chooses the encoded bytes for that kind
        // (Return/newline vs Escape/^C/Control-U); this module records the kind
        // and orders the write — it does not re-encode or collapse the two.
        const range = if (encoded_release.len > 0)
            self.enqueueAndWrite(encoded_release) catch return error.Internal
        else
            ByteRange{ .start = self.write_high_water, .end_exclusive = self.write_high_water };

        self.last_release_kind = kind;
        self.clearClaim();
        self.state = .free;
        return range;
    }

    // ── HUMAN_OWNED + viewer disconnect → HUMAN_ORPHANED ────────────────────

    pub fn viewerDisconnect(self: *InputArbiter) Error!void {
        try self.requireLive();
        if (self.state != .human_owned) {
            // L3/P1: §22 lists disconnect as a plaintext-zeroing trigger.
            if (self.state == .automation_buffering) {
                self.zeroAndFreeAutomationBuffers();
                self.state = .free;
                return;
            }
            // P1: pending-unwritten hold retains entry.encoded plaintext — zero
            // it, then terminate (lease/disconnect of a held automation txn).
            if (self.state == .automation_committed) {
                self.zeroLedgerEncoded();
                try self.terminate();
                return;
            }
            if (self.state == .free) return;
            if (self.state == .human_orphaned) return;
            return error.InputBusy;
        }
        // Preserve claim only while the visibility lease remains current.
        // Lease expiry enters termination instead of releasing the draft.
        if (!self.lease_current) {
            try self.terminate();
            return;
        }
        self.state = .human_orphaned;
    }

    // ── HUMAN_ORPHANED + operator resume ────────────────────────────────────

    /// Resume an orphaned human claim for `viewer_id` under a new claim id.
    ///
    /// `kind` is enforced HERE (by-construction): only `"human"` may resume.
    /// Callers must not treat a string-compare at the host claim path as the
    /// sole never-steal guard — a future second caller that skips host-side
    /// filtering still cannot bypass this check.
    pub fn operatorResume(
        self: *InputArbiter,
        viewer_id: []const u8,
        new_claim_id: []const u8,
        kind: []const u8,
    ) Error!ClaimResult {
        try self.requireLive();
        if (self.state != .human_orphaned) {
            return switch (self.state) {
                .human_owned => error.HumanOwned,
                .free => error.NotReady,
                else => error.InputBusy,
            };
        }
        // Never-steal for orphaned human leases: automation/other kinds cannot
        // resume through this door regardless of caller discipline.
        if (!std.mem.eql(u8, kind, "human")) return error.HumanOrphaned;
        if (!self.lease_current) {
            try self.terminate();
            return error.Closed;
        }

        // B2: never leave a field holding a freed pointer. Free + null first,
        // then allocate both new ids, then install — errdefer covers both.
        // Issue a new claim to one viewer at the prior sequence. Do not replay
        // acknowledged bytes (human_records retained for dedup of unacked? —
        // acknowledged bytes stay in the write high-water; sequence continues).
        //
        // B2 note: on alloc failure below we remain HUMAN_ORPHANED with both
        // claim fields null. That is sound — orphan protects the draft/sequence
        // high-water, not the claim id strings; operator resume/discard are
        // null-safe (resume re-issues ids; discard does not read claim_id).
        if (self.owner_viewer_id) |old| {
            self.allocator.free(old);
            self.owner_viewer_id = null;
        }
        if (self.claim_id) |old| {
            self.allocator.free(old);
            self.claim_id = null;
        }

        const owned_viewer = self.allocator.dupe(u8, viewer_id) catch return error.Internal;
        errdefer self.allocator.free(owned_viewer);
        const owned_claim = self.allocator.dupe(u8, new_claim_id) catch return error.Internal;
        // Both allocations succeeded; install. No field held a freed pointer
        // at any failure point above.
        self.owner_viewer_id = owned_viewer;
        self.claim_id = owned_claim;
        self.state = .human_owned;
        return .{
            .claim_id = self.claim_id.?,
            .next_sequence = self.next_input_seq,
        };
    }

    // ── HUMAN_ORPHANED + operator discard ───────────────────────────────────

    pub fn operatorDiscard(self: *InputArbiter) Error!ByteRange {
        try self.requireLive();
        if (self.state != .human_orphaned) {
            return switch (self.state) {
                .human_owned => error.HumanOwned,
                .free => error.NotReady,
                else => error.InputBusy,
            };
        }

        var encoded: std.ArrayList(u8) = .{};
        defer {
            // M3/N4: zero capacity (not just items.len) before release.
            if (encoded.capacity > 0) std.crypto.secureZero(u8, encoded.allocatedSlice());
            encoded.deinit(self.allocator);
        }
        // N4: pre-size so encode does not realloc and free an un-zeroed buffer.
        encoded.ensureTotalCapacity(self.allocator, 64) catch return error.Internal;
        self.cancel_encoder.encode(self.allocator, &encoded) catch {
            // A failed cancel remains orphaned (§22).
            return error.Internal;
        };
        const range = self.enqueueAndWrite(encoded.items) catch {
            return error.Internal;
        };
        self.clearClaim();
        self.state = .free;
        return range;
    }

    // ── FREE → AUTOMATION_BUFFERING ─────────────────────────────────────────

    pub const AutomationBegin = struct {
        transaction_id: []const u8,
        idempotency_key: []const u8,
        expected_len: usize,
        expected_digest: [32]u8,
        recipient_generation: u64,
        capability_epoch: u64,
        message_id: []const u8,
        locator: []const u8,
        provider_strategy: []const u8,
        submit: SubmitAction,
    };

    pub fn automationBegin(self: *InputArbiter, begin: AutomationBegin) Error!void {
        try self.requireLive();
        switch (self.state) {
            .free => {},
            .human_owned => return error.HumanOwned,
            .human_orphaned => return error.HumanOrphaned,
            .automation_buffering, .automation_committed => return error.InputBusy,
            .human_gesture => return error.InputBusy,
            .terminating, .closed => return error.Closed,
        }
        if (begin.expected_len > automated_message_max_bytes) return error.PayloadTooLarge;

        // N2: a committed-not-written entry is still in-flight — no new automation.
        if (self.hasPendingUnwritten()) return error.InputBusy;

        // Idempotent: identical key+digest returns stored result path on commit;
        // reserve still creates a buffering state only if no conflict.
        if (self.findLedger(begin.idempotency_key)) |entry| {
            if (!std.mem.eql(u8, &entry.digest, &begin.expected_digest) or
                entry.epoch != begin.capability_epoch or
                !std.mem.eql(u8, entry.locator, begin.locator) or
                !std.mem.eql(u8, entry.message_id, begin.message_id))
                return error.Malformed;
            // Same transaction already completed — surface as already exists so
            // the caller can re-read the stored result without re-buffering.
            return error.AlreadyExists;
        }

        self.txn_id = self.allocator.dupe(u8, begin.transaction_id) catch return error.Internal;
        errdefer self.zeroAndFreeAutomationBuffers();
        self.idempotency_key = self.allocator.dupe(u8, begin.idempotency_key) catch return error.Internal;
        self.message_id = self.allocator.dupe(u8, begin.message_id) catch return error.Internal;
        self.locator = self.allocator.dupe(u8, begin.locator) catch return error.Internal;
        self.provider_strategy = self.allocator.dupe(u8, begin.provider_strategy) catch return error.Internal;
        self.expected_len = begin.expected_len;
        self.expected_digest = begin.expected_digest;
        self.recipient_generation = begin.recipient_generation;
        self.capability_epoch = begin.capability_epoch;
        self.submit = begin.submit;
        self.buffer = self.allocator.alloc(u8, begin.expected_len) catch return error.Internal;
        self.buffer_len = 0;
        self.state = .automation_buffering;
    }

    // ── AUTOMATION_BUFFERING + chunks ───────────────────────────────────────

    pub fn automationChunk(self: *InputArbiter, offset: usize, bytes: []const u8) Error!EvidenceLevel {
        try self.requireLive();
        if (self.state != .automation_buffering) return error.NotReady;
        if (offset != self.buffer_len) return error.Malformed;
        if (self.buffer_len + bytes.len > self.expected_len) return error.PayloadTooLarge;
        @memcpy(self.buffer[self.buffer_len..][0..bytes.len], bytes);
        self.buffer_len += bytes.len;
        return .buffered;
    }

    // ── AUTOMATION_BUFFERING + COMMIT → AUTOMATION_COMMITTED → FREE ─────────

    pub fn automationCommit(
        self: *InputArbiter,
        transaction_id: []const u8,
        idempotency_key: []const u8,
        expected_len: usize,
        expected_digest: [32]u8,
        recipient_generation: u64,
        capability_epoch: u64,
        message_id: []const u8,
        locator: []const u8,
        submit: SubmitAction,
    ) Error!TransactionResult {
        try self.requireLive();

        // Idempotent re-delivery / sink-write retry (N2).
        if (self.findLedger(idempotency_key)) |entry| {
            if (!std.mem.eql(u8, &entry.digest, &expected_digest) or
                entry.epoch != capability_epoch or
                !std.mem.eql(u8, entry.locator, locator) or
                !std.mem.eql(u8, entry.message_id, message_id))
                return error.Malformed;
            if (entry.evidence == .written) {
                return .{
                    .evidence = entry.evidence,
                    .byte_range = entry.byte_range,
                    .result_label = entry.result_label,
                };
            }
            // committed-not-written: re-attempt the sink write once.
            return try self.retryPendingWrite(entry);
        }

        if (self.state != .automation_buffering) return error.NotReady;
        if (self.txn_id == null or self.idempotency_key == null or
            self.message_id == null or self.locator == null)
            return error.Internal;

        // COMMIT must repeat identity fields.
        if (!std.mem.eql(u8, self.txn_id.?, transaction_id) or
            !std.mem.eql(u8, self.idempotency_key.?, idempotency_key) or
            self.expected_len != expected_len or
            !std.mem.eql(u8, &self.expected_digest, &expected_digest) or
            self.recipient_generation != recipient_generation or
            self.capability_epoch != capability_epoch or
            !std.mem.eql(u8, self.message_id.?, message_id) or
            !std.mem.eql(u8, self.locator.?, locator) or
            self.submit != submit)
            return error.Malformed;

        if (self.buffer_len != self.expected_len) return error.Malformed;

        var hasher = std.crypto.hash.sha2.Sha256.init(.{});
        hasher.update(self.buffer[0..self.buffer_len]);
        var got: [32]u8 = undefined;
        hasher.final(&got);
        if (!std.mem.eql(u8, &got, &expected_digest)) return error.Malformed;

        // Through AUTOMATION_COMMITTED.
        self.state = .automation_committed;

        var encoded: std.ArrayList(u8) = .{};
        defer {
            // N4: zero the full allocation (capacity), not just items.len, so a
            // realloc path cannot leave plaintext in a freed old buffer — we
            // also ensureTotalCapacity first so encode does not realloc.
            if (encoded.capacity > 0) std.crypto.secureZero(u8, encoded.allocatedSlice());
            encoded.deinit(self.allocator);
        }
        // P4/N4: fixed-cap encode buffer (worst-case expansion). Capacity is set
        // once so the encoder must not force realloc of an un-zeroed old buffer.
        const encode_cap = encodedCapacityForBody(self.buffer_len);
        encoded.ensureTotalCapacity(self.allocator, encode_cap) catch {
            self.state = .automation_buffering;
            return error.Internal;
        };
        self.encoder.encode(self.allocator, self.buffer[0..self.buffer_len], submit, &encoded) catch {
            self.state = .automation_buffering;
            return error.Internal;
        };
        if (encoded.items.len > encode_cap) {
            // Encoder produced more than the fixed-cap bound. Fail closed.
            self.state = .automation_buffering;
            return error.PayloadTooLarge;
        }

        // M4/N2: ledger BEFORE sink write. P3: byte_range = planned range at
        // creation under .committed (§22:1348 queue owns the range; not kernel).
        const planned_start = self.write_high_water;
        const encoded_owned = self.allocator.dupe(u8, encoded.items) catch {
            self.state = .automation_buffering;
            return error.Internal;
        };

        const entry = buildLedgerEntry(
            self.allocator,
            idempotency_key,
            expected_digest,
            locator,
            capability_epoch,
            message_id,
            transaction_id,
            planned_start,
            encoded_owned.len,
            encoded_owned,
            .committed,
        ) catch {
            std.crypto.secureZero(u8, encoded_owned);
            self.allocator.free(encoded_owned);
            self.state = .automation_buffering;
            return error.Internal;
        };
        // buildLedgerEntry took ownership of encoded_owned on success.
        self.ledger.append(self.allocator, entry) catch {
            var doomed = entry;
            doomed.deinit(self.allocator);
            self.state = .automation_buffering;
            return error.Internal;
        };
        const ledger_idx = self.ledger.items.len - 1;

        // Body buffer zeroed here after encode (commit path). Encoded bytes are
        // RETAINED in the ledger for sink retry while held — still plaintext and
        // still under §22:1338 (zeroed on commit when the write succeeds, and on
        // cancel / disconnect / exit). Do not free entry.encoded on SinkWriteFailed
        // alone (retry needs it); do zero it on the four triggers.
        self.zeroAndFreeAutomationBuffers();

        // Sink write after ledger is secured.
        const pending = &self.ledger.items[ledger_idx];
        self.sink.write(pending.encoded.?) catch {
            // N2: typed failure; evidence stays .committed; do NOT return Ok.
            // HOLD in .automation_committed (§22 table: BUFFERING+COMMIT →
            // AUTOMATION_COMMITTED → FREE — FREE only after the commit effect
            // finishes; write is part of that effect). Holding an automation
            // state blocks every other writer with no new mechanism (claim /
            // gesture / humanInput / new BEGIN all reject automation_*), and
            // write_high_water cannot advance under an interleaved writer — so
            // the planned range stays valid for retry.
            self.state = .automation_committed;
            return error.SinkWriteFailed;
        };
        return self.markWritten(pending);
    }

    /// Cancellation before COMMIT writes nothing; after COMMIT returns stored
    /// result (§22). For the held pending-unwritten entry only, drops encoded
    /// and releases AUTOMATION_COMMITTED → FREE.
    pub fn automationCancel(self: *InputArbiter, idempotency_key: []const u8) Error!?TransactionResult {
        try self.requireLive();
        if (self.findLedger(idempotency_key)) |entry| {
            const result = TransactionResult{
                .evidence = entry.evidence,
                .byte_range = entry.byte_range,
                .result_label = entry.result_label,
            };
            // P2: only release the hold when THIS entry is the pending-unwritten
            // txn (encoded != null). A stale cancel of an old completed key must
            // not wipe an unrelated in-flight buffering txn.
            const was_pending = entry.encoded != null;
            if (entry.encoded) |buf| {
                std.crypto.secureZero(u8, buf);
                self.allocator.free(buf);
                entry.encoded = null;
            }
            if (was_pending) {
                // Pending entry always implies .automation_committed (pre-append
                // failures reset to buffering WITHOUT a ledger entry).
                self.state = .free;
            }
            return result;
        }
        if (self.state != .automation_buffering) return error.NotReady;
        if (self.idempotency_key == null or !std.mem.eql(u8, self.idempotency_key.?, idempotency_key))
            return error.Malformed;
        // Write nothing (cancel before first successful commit write).
        self.zeroAndFreeAutomationBuffers();
        self.state = .free;
        return null;
    }

    fn hasPendingUnwritten(self: *const InputArbiter) bool {
        // Belt-and-suspenders with automation_committed hold; primary gate is state.
        for (self.ledger.items) |entry| {
            if (entry.evidence == .committed and entry.encoded != null) return true;
        }
        return false;
    }

    fn retryPendingWrite(self: *InputArbiter, entry: *LedgerEntry) Error!TransactionResult {
        if (entry.evidence == .written) {
            return .{
                .evidence = .written,
                .byte_range = entry.byte_range,
                .result_label = entry.result_label,
            };
        }
        // Reuse retained encoded bytes (not re-encoded from a zeroed body).
        const bytes = entry.encoded orelse return error.Internal;
        self.sink.write(bytes) catch {
            self.state = .automation_committed;
            return error.SinkWriteFailed;
        };
        return self.markWritten(entry);
    }

    fn markWritten(self: *InputArbiter, entry: *LedgerEntry) Error!TransactionResult {
        const start = entry.planned_start;
        // Holding automation_committed prevented interleaved writers, so
        // write_high_water still equals planned_start (N2 free property).
        if (self.write_high_water != start) return error.Internal;
        self.write_high_water = start + entry.planned_len;
        const range = ByteRange{ .start = start, .end_exclusive = start + entry.planned_len };
        entry.byte_range = range;
        entry.evidence = .written;
        if (entry.encoded) |buf| {
            std.crypto.secureZero(u8, buf);
            self.allocator.free(buf);
            entry.encoded = null;
        }
        self.state = .free;
        return .{
            .evidence = .written,
            .byte_range = range,
            .result_label = entry.result_label,
        };
    }

    // ── any live → TERMINATING → CLOSED ─────────────────────────────────────

    pub fn terminate(self: *InputArbiter) Error!void {
        if (self.state == .closed) return;
        self.state = .terminating;
        // Finish cancellation policy: drop open automation, zero plaintext.
        // P1/§22:1338 EXIT: ledger may outlive termination for durable fields,
        // but entry.encoded is ephemeral retry plaintext — zero it now.
        self.zeroLedgerEncoded();
        self.zeroAndFreeAutomationBuffers();
        self.clearClaim();
        self.sink.close();
        self.state = .closed;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    fn requireLive(self: *const InputArbiter) Error!void {
        if (self.state == .terminating or self.state == .closed) return error.Closed;
    }

    fn enqueueAndWrite(self: *InputArbiter, bytes: []const u8) !ByteRange {
        const start = self.write_high_water;
        if (bytes.len > 0) {
            try self.sink.write(bytes);
        }
        self.write_high_water = start + bytes.len;
        return .{ .start = start, .end_exclusive = self.write_high_water };
    }

    fn clearClaim(self: *InputArbiter) void {
        if (self.claim_id) |id| {
            self.allocator.free(id);
            self.claim_id = null;
        }
        if (self.owner_viewer_id) |v| {
            self.allocator.free(v);
            self.owner_viewer_id = null;
        }
        self.human_records.clearRetainingCapacity();
    }

    fn zeroAndFreeAutomationBuffers(self: *InputArbiter) void {
        if (self.buffer.len > 0) {
            std.crypto.secureZero(u8, self.buffer);
            self.allocator.free(self.buffer);
            self.buffer = &[_]u8{};
        }
        self.buffer_len = 0;
        self.expected_len = 0;
        self.expected_digest = [_]u8{0} ** 32;
        if (self.txn_id) |v| {
            self.allocator.free(v);
            self.txn_id = null;
        }
        if (self.idempotency_key) |v| {
            self.allocator.free(v);
            self.idempotency_key = null;
        }
        if (self.message_id) |v| {
            self.allocator.free(v);
            self.message_id = null;
        }
        if (self.locator) |v| {
            self.allocator.free(v);
            self.locator = null;
        }
        if (self.provider_strategy) |v| {
            self.allocator.free(v);
            self.provider_strategy = null;
        }
        self.submit = .none;
        self.recipient_generation = 0;
        self.capability_epoch = 0;
    }

    fn findLedger(self: *InputArbiter, key: []const u8) ?*LedgerEntry {
        for (self.ledger.items) |*entry| {
            if (std.mem.eql(u8, entry.idempotency_key, key)) return entry;
        }
        return null;
    }

    /// Zero+null every ledger encoded buffer (§22 disconnect/exit zeroing; P1).
    fn zeroLedgerEncoded(self: *InputArbiter) void {
        for (self.ledger.items) |*entry| {
            if (entry.encoded) |buf| {
                std.crypto.secureZero(u8, buf);
                self.allocator.free(buf);
                entry.encoded = null;
            }
        }
    }
};

/// Build a fully-owned ledger entry; takes ownership of `encoded` on success.
fn buildLedgerEntry(
    allocator: std.mem.Allocator,
    idempotency_key: []const u8,
    digest: [32]u8,
    locator: []const u8,
    epoch: u64,
    message_id: []const u8,
    transaction_id: []const u8,
    planned_start: u64,
    planned_len: usize,
    encoded: []u8,
    evidence: EvidenceLevel,
) error{OutOfMemory}!LedgerEntry {
    const key_owned = try allocator.dupe(u8, idempotency_key);
    errdefer allocator.free(key_owned);
    const loc_owned = try allocator.dupe(u8, locator);
    errdefer allocator.free(loc_owned);
    const msg_owned = try allocator.dupe(u8, message_id);
    errdefer allocator.free(msg_owned);
    const txn_owned = try allocator.dupe(u8, transaction_id);
    errdefer allocator.free(txn_owned);
    const label = try allocator.dupe(u8, "written");
    // P3: populate byte_range at creation with the planned range under .committed
    // (§22:1348 — queue owns the contiguous range; not kernel-consumed).
    const range = ByteRange{ .start = planned_start, .end_exclusive = planned_start + planned_len };
    return .{
        .idempotency_key = key_owned,
        .digest = digest,
        .locator = loc_owned,
        .epoch = epoch,
        .message_id = msg_owned,
        .transaction_id = txn_owned,
        .byte_range = range,
        .planned_start = planned_start,
        .planned_len = planned_len,
        .evidence = evidence,
        .result_label = label,
        .encoded = encoded,
    };
}

// ── Unit tests (mock sink; every §22 transition + crash-at-boundary) ────────

const MockSink = struct {
    writes: std.ArrayList(u8) = .{},
    closed: bool = false,
    allocator: std.mem.Allocator,
    fail_next: bool = false,

    fn sink(self: *MockSink) WriteSink {
        return .{
            .context = self,
            .writeFn = write,
            .closeFn = close,
        };
    }

    fn write(context: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *MockSink = @ptrCast(@alignCast(context));
        if (self.fail_next) {
            self.fail_next = false;
            return error.WriteFailed;
        }
        try self.writes.appendSlice(self.allocator, bytes);
    }

    fn close(context: *anyopaque) void {
        const self: *MockSink = @ptrCast(@alignCast(context));
        self.closed = true;
    }

    fn deinit(self: *MockSink) void {
        self.writes.deinit(self.allocator);
    }
};

const IdentityEncoder = struct {
    fn encoder() Encoder {
        return .{ .context = undefined, .encodeFn = encode };
    }
    fn encode(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        body: []const u8,
        submit: SubmitAction,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        _ = context;
        try out.appendSlice(allocator, body);
        switch (submit) {
            .none => {},
            .@"return" => try out.append(allocator, '\r'),
            .control_enter => try out.appendSlice(allocator, "\x1b\r"),
        }
    }
};

const StaticCancel = struct {
    fn encoder() CancelEncoder {
        return .{ .context = undefined, .encodeFn = encode };
    }
    fn encode(
        context: *anyopaque,
        allocator: std.mem.Allocator,
        out: *std.ArrayList(u8),
    ) anyerror!void {
        _ = context;
        try out.appendSlice(allocator, "\x03"); // Control-C stand-in
    }
};

fn sha256(bytes: []const u8) [32]u8 {
    var out: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &out, .{});
    return out;
}

fn makeArbiter(sink: *MockSink) InputArbiter {
    return InputArbiter.init(
        std.testing.allocator,
        sink.sink(),
        IdentityEncoder.encoder(),
        StaticCancel.encoder(),
    );
}

test "FREE + CLAIM_ACQUIRE → HUMAN_OWNED" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const r = try arb.claimAcquire("viewer-1", "clm_testclaim0001");
    try std.testing.expectEqual(State.human_owned, arb.currentState());
    try std.testing.expectEqualStrings("clm_testclaim0001", r.claim_id);
    try std.testing.expectEqual(@as(u64, 1), r.next_sequence);
}

test "FREE + GESTURE_INPUT → HUMAN_GESTURE → FREE enqueues atomically" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const range = try arb.gestureInput("\x1b[A");
    try std.testing.expectEqual(State.free, arb.currentState());
    try std.testing.expectEqualStrings("\x1b[A", sink.writes.items);
    try std.testing.expectEqual(@as(u64, 0), range.start);
    try std.testing.expectEqual(@as(u64, 3), range.end_exclusive);
}

test "FREE + AUTOMATION_BEGIN → AUTOMATION_BUFFERING writes no PTY bytes" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "hello automation";
    try arb.automationBegin(.{
        .transaction_id = "txn_1",
        .idempotency_key = "idemp_1",
        .expected_len = body.len,
        .expected_digest = sha256(body),
        .recipient_generation = 1,
        .capability_epoch = 0,
        .message_id = "msg_1",
        .locator = "ses_1",
        .provider_strategy = "paste",
        .submit = .@"return",
    });
    try std.testing.expectEqual(State.automation_buffering, arb.currentState());
    try std.testing.expectEqual(@as(usize, 0), sink.writes.items.len);
}

test "HUMAN_OWNED + HUMAN_INPUT dedupes sequence+digest and ACKs after queue owns" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    const payload = "hi";
    const dig = sha256(payload);
    const first = try arb.humanInput("v1", "clm_1", 1, dig, payload);
    try std.testing.expect(!first.duplicate);
    try std.testing.expectEqual(EvidenceLevel.written, first.evidence);

    const second = try arb.humanInput("v1", "clm_1", 1, dig, payload);
    try std.testing.expect(second.duplicate);
    try std.testing.expectEqual(first.byte_range.start, second.byte_range.start);
    // Only one write to the sink.
    try std.testing.expectEqualStrings("hi", sink.writes.items);
}

test "HUMAN_OWNED rejects automation and second claim (single writer)" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    try std.testing.expectError(error.HumanOwned, arb.claimAcquire("v2", "clm_2"));
    try std.testing.expectError(error.HumanOwned, arb.automationBegin(.{
        .transaction_id = "txn_x",
        .idempotency_key = "k",
        .expected_len = 1,
        .expected_digest = sha256("a"),
        .recipient_generation = 1,
        .capability_epoch = 0,
        .message_id = "m",
        .locator = "l",
        .provider_strategy = "p",
        .submit = .none,
    }));
    try std.testing.expectEqual(State.human_owned, arb.currentState());
}

test "HUMAN_OWNED + CLAIM_RELEASE → FREE after release bytes accepted" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    _ = try arb.humanInput("v1", "clm_1", 1, sha256("a"), "a");
    _ = try arb.claimRelease("v1", "clm_1", .submit, "\r");
    try std.testing.expectEqual(State.free, arb.currentState());
    try std.testing.expectEqualStrings("a\r", sink.writes.items);
}

test "HUMAN_OWNED + viewer disconnect → HUMAN_ORPHANED while lease current" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    _ = try arb.humanInput("v1", "clm_1", 1, sha256("draft"), "draft");
    try arb.viewerDisconnect();
    try std.testing.expectEqual(State.human_orphaned, arb.currentState());
    // Automation blocked while orphaned.
    try std.testing.expectError(error.HumanOrphaned, arb.automationBegin(.{
        .transaction_id = "txn_x",
        .idempotency_key = "k",
        .expected_len = 1,
        .expected_digest = sha256("a"),
        .recipient_generation = 1,
        .capability_epoch = 0,
        .message_id = "m",
        .locator = "l",
        .provider_strategy = "p",
        .submit = .none,
    }));
    // Claim never times out into FREE on its own.
    try std.testing.expectEqual(State.human_orphaned, arb.currentState());
}

test "human claim never times out into FREE; lease expiry terminates" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    try arb.viewerDisconnect();
    try std.testing.expectEqual(State.human_orphaned, arb.currentState());
    // No timed unlock path exists; only lease expiry / terminate.
    try arb.onVisibilityLeaseExpired();
    try std.testing.expectEqual(State.closed, arb.currentState());
    try std.testing.expect(sink.closed);
}

test "HUMAN_ORPHANED + operator resume → HUMAN_OWNED at prior sequence" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    _ = try arb.humanInput("v1", "clm_1", 1, sha256("x"), "x");
    try arb.viewerDisconnect();
    const r = try arb.operatorResume("v2", "clm_2", "human");
    try std.testing.expectEqual(State.human_owned, arb.currentState());
    try std.testing.expectEqual(@as(u64, 2), r.next_sequence);
    // Do not replay acknowledged bytes — sink still only has "x".
    try std.testing.expectEqualStrings("x", sink.writes.items);
}

test "HUMAN_ORPHANED + non-human operatorResume is denied at the arbiter" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    try arb.viewerDisconnect();
    try std.testing.expectEqual(State.human_orphaned, arb.currentState());
    // By-construction never-steal: kind is enforced inside operatorResume, not
    // only at a host-side caller compare.
    try std.testing.expectError(error.HumanOrphaned, arb.operatorResume("auto-v", "clm_auto", "automation"));
    try std.testing.expectEqual(State.human_orphaned, arb.currentState());
    // Human resume still works after the denied non-human attempt.
    const r = try arb.operatorResume("v2", "clm_2", "human");
    try std.testing.expectEqual(State.human_owned, arb.currentState());
    try std.testing.expectEqualStrings("clm_2", r.claim_id);
}

test "HUMAN_ORPHANED + operator discard → FREE after cancel enqueued" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    try arb.viewerDisconnect();
    _ = try arb.operatorDiscard();
    try std.testing.expectEqual(State.free, arb.currentState());
    try std.testing.expectEqualStrings("\x03", sink.writes.items);
}

test "AUTOMATION_BUFFERING + COMMIT → AUTOMATION_COMMITTED → FREE zeros buffers" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "prompt body";
    const dig = sha256(body);
    try arb.automationBegin(.{
        .transaction_id = "txn_1",
        .idempotency_key = "idemp_1",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 3,
        .capability_epoch = 7,
        .message_id = "msg_1",
        .locator = "ses_abc",
        .provider_strategy = "paste",
        .submit = .@"return",
    });
    const buffered = try arb.automationChunk(0, body);
    try std.testing.expectEqual(EvidenceLevel.buffered, buffered);
    const result = try arb.automationCommit(
        "txn_1",
        "idemp_1",
        body.len,
        dig,
        3,
        7,
        "msg_1",
        "ses_abc",
        .@"return",
    );
    try std.testing.expectEqual(State.free, arb.currentState());
    try std.testing.expectEqual(EvidenceLevel.written, result.evidence);
    try std.testing.expectEqualStrings("prompt body\r", sink.writes.items);
    // Plaintext buffer released.
    try std.testing.expectEqual(@as(usize, 0), arb.buffer.len);
}

test "automation idempotent: commit twice returns stored result, no second write" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "once";
    const dig = sha256(body);
    try arb.automationBegin(.{
        .transaction_id = "txn_1",
        .idempotency_key = "idemp_once",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_1",
        .locator = "ses_1",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    const first = try arb.automationCommit(
        "txn_1",
        "idemp_once",
        body.len,
        dig,
        1,
        1,
        "msg_1",
        "ses_1",
        .none,
    );
    const second = try arb.automationCommit(
        "txn_1",
        "idemp_once",
        body.len,
        dig,
        1,
        1,
        "msg_1",
        "ses_1",
        .none,
    );
    try std.testing.expectEqual(first.byte_range.?.start, second.byte_range.?.start);
    try std.testing.expectEqual(first.byte_range.?.end_exclusive, second.byte_range.?.end_exclusive);
    try std.testing.expectEqualStrings("once", sink.writes.items);
}

test "automation cancel before COMMIT writes nothing; after returns stored" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "cancel-me";
    const dig = sha256(body);
    try arb.automationBegin(.{
        .transaction_id = "txn_c",
        .idempotency_key = "idemp_c",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_c",
        .locator = "ses_c",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    const cancelled = try arb.automationCancel("idemp_c");
    try std.testing.expect(cancelled == null);
    try std.testing.expectEqual(State.free, arb.currentState());
    try std.testing.expectEqual(@as(usize, 0), sink.writes.items.len);

    // Commit a real one, then cancel-after returns stored.
    try arb.automationBegin(.{
        .transaction_id = "txn_d",
        .idempotency_key = "idemp_d",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_d",
        .locator = "ses_d",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    _ = try arb.automationCommit(
        "txn_d",
        "idemp_d",
        body.len,
        dig,
        1,
        1,
        "msg_d",
        "ses_d",
        .none,
    );
    const after = try arb.automationCancel("idemp_d");
    try std.testing.expect(after != null);
    try std.testing.expectEqualStrings("cancel-me", sink.writes.items);
}

test "idempotency key reuse with different digest is MALFORMED" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "alpha";
    const dig = sha256(body);
    try arb.automationBegin(.{
        .transaction_id = "txn_1",
        .idempotency_key = "same_key",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_1",
        .locator = "ses_1",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    _ = try arb.automationCommit(
        "txn_1",
        "same_key",
        body.len,
        dig,
        1,
        1,
        "msg_1",
        "ses_1",
        .none,
    );
    try std.testing.expectError(error.Malformed, arb.automationBegin(.{
        .transaction_id = "txn_2",
        .idempotency_key = "same_key",
        .expected_len = 4,
        .expected_digest = sha256("beta"),
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_2",
        .locator = "ses_1",
        .provider_strategy = "p",
        .submit = .none,
    }));
}

test "TERMINATE from every live state → TERMINATING → CLOSED; rejects new work" {
    const starts = [_]struct {
        name: []const u8,
        setup: *const fn (*InputArbiter) anyerror!void,
    }{
        .{ .name = "FREE", .setup = struct {
            fn f(a: *InputArbiter) anyerror!void {
                _ = a;
            }
        }.f },
        .{ .name = "HUMAN_OWNED", .setup = struct {
            fn f(a: *InputArbiter) anyerror!void {
                _ = try a.claimAcquire("v", "clm");
            }
        }.f },
        .{ .name = "HUMAN_ORPHANED", .setup = struct {
            fn f(a: *InputArbiter) anyerror!void {
                _ = try a.claimAcquire("v", "clm");
                try a.viewerDisconnect();
            }
        }.f },
        .{ .name = "AUTOMATION_BUFFERING", .setup = struct {
            fn f(a: *InputArbiter) anyerror!void {
                try a.automationBegin(.{
                    .transaction_id = "t",
                    .idempotency_key = "k",
                    .expected_len = 1,
                    .expected_digest = sha256("z"),
                    .recipient_generation = 1,
                    .capability_epoch = 0,
                    .message_id = "m",
                    .locator = "l",
                    .provider_strategy = "p",
                    .submit = .none,
                });
            }
        }.f },
    };

    for (starts) |case| {
        var sink = MockSink{ .allocator = std.testing.allocator };
        defer sink.deinit();
        var arb = makeArbiter(&sink);
        defer arb.deinit();
        try case.setup(&arb);
        try arb.terminate();
        try std.testing.expectEqual(State.closed, arb.currentState());
        try std.testing.expect(sink.closed);
        try std.testing.expectError(error.Closed, arb.claimAcquire("v", "c"));
        try std.testing.expectError(error.Closed, arb.automationBegin(.{
            .transaction_id = "t",
            .idempotency_key = "k2",
            .expected_len = 1,
            .expected_digest = sha256("z"),
            .recipient_generation = 1,
            .capability_epoch = 0,
            .message_id = "m",
            .locator = "l",
            .provider_strategy = "p",
            .submit = .none,
        }));
    }
}

test "crash-at-boundary: no interleave — human input rejected during automation" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    try arb.automationBegin(.{
        .transaction_id = "t",
        .idempotency_key = "k",
        .expected_len = 4,
        .expected_digest = sha256("abcd"),
        .recipient_generation = 1,
        .capability_epoch = 0,
        .message_id = "m",
        .locator = "l",
        .provider_strategy = "p",
        .submit = .none,
    });
    // Mid-buffer "crash" boundary: no human claim may interleave.
    try std.testing.expectError(error.InputBusy, arb.claimAcquire("v", "c"));
    try std.testing.expectError(error.InputBusy, arb.gestureInput("x"));
}

test "evidence levels are typed wire names, never time-derived" {
    try std.testing.expectEqualStrings("buffered", EvidenceLevel.buffered.wireName());
    try std.testing.expectEqualStrings("committed", EvidenceLevel.committed.wireName());
    try std.testing.expectEqualStrings("written", EvidenceLevel.written.wireName());
    try std.testing.expectEqualStrings("provider-observed", EvidenceLevel.provider_observed.wireName());
    try std.testing.expectEqualStrings("FREE", State.free.wireName());
    try std.testing.expectEqualStrings("HUMAN_ORPHANED", State.human_orphaned.wireName());
    try std.testing.expectEqualStrings("AUTOMATION_COMMITTED", State.automation_committed.wireName());
}

test "disconnect mid-automation zeros plaintext and stays consistent" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "secret-plaintext-bytes";
    try arb.automationBegin(.{
        .transaction_id = "t",
        .idempotency_key = "k",
        .expected_len = body.len,
        .expected_digest = sha256(body),
        .recipient_generation = 1,
        .capability_epoch = 0,
        .message_id = "m",
        .locator = "l",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    // Terminate (exit/disconnect path) zeros buffers.
    try arb.terminate();
    try std.testing.expectEqual(@as(usize, 0), arb.buffer.len);
    try std.testing.expectEqual(State.closed, arb.currentState());
}

test "viewer disconnect without current lease terminates instead of FREE" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    arb.setLeaseCurrent(false);
    try arb.viewerDisconnect();
    try std.testing.expectEqual(State.closed, arb.currentState());
}

// M7: The no-timed-unlock invariant is structural — InputArbiter has no clock,
// timer, Thread, or sleep; only an injected lease_current boolean and explicit
// onVisibilityLeaseExpired(). A loop over currentState() cannot observe a
// timed unlock and is not a positive control. See the lease_current field doc.

test "L1: human input dedup returns original written evidence not downgraded" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    const payload = "hi";
    const dig = sha256(payload);
    const first = try arb.humanInput("v1", "clm_1", 1, dig, payload);
    try std.testing.expectEqual(EvidenceLevel.written, first.evidence);
    const second = try arb.humanInput("v1", "clm_1", 1, dig, payload);
    try std.testing.expect(second.duplicate);
    try std.testing.expectEqual(EvidenceLevel.written, second.evidence);
}

test "L3: viewerDisconnect during automation zeros plaintext buffer" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "secret-on-disconnect";
    try arb.automationBegin(.{
        .transaction_id = "t",
        .idempotency_key = "k",
        .expected_len = body.len,
        .expected_digest = sha256(body),
        .recipient_generation = 1,
        .capability_epoch = 0,
        .message_id = "m",
        .locator = "l",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    try std.testing.expect(arb.buffer.len > 0);
    try arb.viewerDisconnect();
    try std.testing.expectEqual(@as(usize, 0), arb.buffer.len);
    try std.testing.expectEqual(State.free, arb.currentState());
}

test "M8: claimRelease records submit vs cancel kind distinctly" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    _ = try arb.claimAcquire("v1", "clm_1");
    _ = try arb.claimRelease("v1", "clm_1", .submit, "\r");
    try std.testing.expectEqual(ReleaseKind.submit, arb.last_release_kind.?);

    _ = try arb.claimAcquire("v1", "clm_2");
    _ = try arb.claimRelease("v1", "clm_2", .cancel, "\x03");
    try std.testing.expectEqual(ReleaseKind.cancel, arb.last_release_kind.?);
    try std.testing.expectEqualStrings("\r\x03", sink.writes.items);
}

// N2: sink fail → typed error + evidence .committed + hold automation_committed;
// retained encoded enables retry; no double-write; writers blocked by state.
test "N2: sink write failure is typed; retry writes once; blocks new automation" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "once-only";
    const dig = sha256(body);
    try arb.automationBegin(.{
        .transaction_id = "txn_m4",
        .idempotency_key = "idemp_m4",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_m4",
        .locator = "ses_m4",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    sink.fail_next = true;
    try std.testing.expectError(error.SinkWriteFailed, arb.automationCommit(
        "txn_m4",
        "idemp_m4",
        body.len,
        dig,
        1,
        1,
        "msg_m4",
        "ses_m4",
        .none,
    ));
    try std.testing.expectEqual(@as(usize, 0), sink.writes.items.len);
    // HOLD in automation_committed — not FREE (N2 constraint #3/#4).
    try std.testing.expectEqual(State.automation_committed, arb.currentState());
    const entry = arb.findLedger("idemp_m4").?;
    try std.testing.expectEqual(EvidenceLevel.committed, entry.evidence);
    // P3: byte_range populated at creation with planned range under .committed.
    try std.testing.expect(entry.byte_range != null);
    try std.testing.expectEqual(entry.planned_start, entry.byte_range.?.start);
    try std.testing.expect(entry.encoded != null); // content retained for retry
    const high_water = arb.write_high_water;

    // Existing state machine blocks every other writer (no new mechanism).
    try std.testing.expectError(error.InputBusy, arb.automationBegin(.{
        .transaction_id = "txn_other",
        .idempotency_key = "idemp_other",
        .expected_len = 1,
        .expected_digest = sha256("x"),
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_o",
        .locator = "ses_o",
        .provider_strategy = "p",
        .submit = .none,
    }));
    try std.testing.expectError(error.InputBusy, arb.claimAcquire("v", "clm"));
    try std.testing.expectError(error.InputBusy, arb.gestureInput("x"));
    // high_water frozen while held — planned range still valid.
    try std.testing.expectEqual(high_water, arb.write_high_water);

    // Retry reuses retained encoded; writes exactly once → written → FREE.
    const second = try arb.automationCommit(
        "txn_m4",
        "idemp_m4",
        body.len,
        dig,
        1,
        1,
        "msg_m4",
        "ses_m4",
        .none,
    );
    try std.testing.expectEqual(EvidenceLevel.written, second.evidence);
    try std.testing.expect(second.byte_range != null);
    try std.testing.expectEqual(State.free, arb.currentState());
    try std.testing.expectEqualStrings("once-only", sink.writes.items);

    // Further commit is pure idempotent return — no second write.
    const third = try arb.automationCommit(
        "txn_m4",
        "idemp_m4",
        body.len,
        dig,
        1,
        1,
        "msg_m4",
        "ses_m4",
        .none,
    );
    try std.testing.expectEqual(EvidenceLevel.written, third.evidence);
    try std.testing.expectEqualStrings("once-only", sink.writes.items);
}

// P1 positive control: disconnect while pending-unwritten zeros ledger.encoded.
test "P1: disconnect while pending-unwritten zeros retained plaintext" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "secret-pending-write";
    const dig = sha256(body);
    try arb.automationBegin(.{
        .transaction_id = "txn_p1",
        .idempotency_key = "idemp_p1",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_p1",
        .locator = "ses_p1",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    sink.fail_next = true;
    try std.testing.expectError(error.SinkWriteFailed, arb.automationCommit(
        "txn_p1",
        "idemp_p1",
        body.len,
        dig,
        1,
        1,
        "msg_p1",
        "ses_p1",
        .none,
    ));
    try std.testing.expectEqual(State.automation_committed, arb.currentState());
    try std.testing.expect(arb.findLedger("idemp_p1").?.encoded != null);
    try arb.viewerDisconnect();
    try std.testing.expectEqual(State.closed, arb.currentState());
    // THE ASSERTION: retained plaintext zeroed (not left for deinit-only).
    try std.testing.expect(arb.findLedger("idemp_p1").?.encoded == null);
}

// P2 positive control: stale cancel of completed A must not destroy buffering B.
test "P2: cancel completed A while B buffers leaves B intact" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body_a = "alpha";
    const dig_a = sha256(body_a);
    try arb.automationBegin(.{
        .transaction_id = "txn_a",
        .idempotency_key = "idemp_a",
        .expected_len = body_a.len,
        .expected_digest = dig_a,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_a",
        .locator = "ses_a",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body_a);
    _ = try arb.automationCommit(
        "txn_a",
        "idemp_a",
        body_a.len,
        dig_a,
        1,
        1,
        "msg_a",
        "ses_a",
        .none,
    );
    try std.testing.expectEqual(State.free, arb.currentState());

    const body_b = "bravo-in-flight";
    const dig_b = sha256(body_b);
    try arb.automationBegin(.{
        .transaction_id = "txn_b",
        .idempotency_key = "idemp_b",
        .expected_len = body_b.len,
        .expected_digest = dig_b,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_b",
        .locator = "ses_b",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body_b);
    try std.testing.expectEqual(State.automation_buffering, arb.currentState());
    try std.testing.expect(arb.buffer_len == body_b.len);

    // Stale cancel of A returns stored result and must NOT wipe B.
    const cancelled = try arb.automationCancel("idemp_a");
    try std.testing.expect(cancelled != null);
    try std.testing.expectEqual(EvidenceLevel.written, cancelled.?.evidence);
    // THE ASSERTION THAT FAILS AGAINST UNFIXED P2:
    try std.testing.expectEqual(State.automation_buffering, arb.currentState());
    try std.testing.expectEqual(body_b.len, arb.buffer_len);
    try std.testing.expectEqualStrings(body_b, arb.buffer[0..arb.buffer_len]);
}

test "N2: cancel of committed-not-written releases hold to FREE" {
    var sink = MockSink{ .allocator = std.testing.allocator };
    defer sink.deinit();
    var arb = makeArbiter(&sink);
    defer arb.deinit();

    const body = "cancel-pending";
    const dig = sha256(body);
    try arb.automationBegin(.{
        .transaction_id = "txn_c",
        .idempotency_key = "idemp_c",
        .expected_len = body.len,
        .expected_digest = dig,
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_c",
        .locator = "ses_c",
        .provider_strategy = "p",
        .submit = .none,
    });
    _ = try arb.automationChunk(0, body);
    sink.fail_next = true;
    try std.testing.expectError(error.SinkWriteFailed, arb.automationCommit(
        "txn_c",
        "idemp_c",
        body.len,
        dig,
        1,
        1,
        "msg_c",
        "ses_c",
        .none,
    ));
    try std.testing.expectEqual(State.automation_committed, arb.currentState());
    const cancelled = try arb.automationCancel("idemp_c");
    try std.testing.expect(cancelled != null);
    try std.testing.expectEqual(EvidenceLevel.committed, cancelled.?.evidence);
    try std.testing.expectEqual(State.free, arb.currentState());
    try std.testing.expectEqual(@as(usize, 0), sink.writes.items.len);
    // New automation may begin after cancel.
    try arb.automationBegin(.{
        .transaction_id = "txn_next",
        .idempotency_key = "idemp_next",
        .expected_len = 1,
        .expected_digest = sha256("z"),
        .recipient_generation = 1,
        .capability_epoch = 1,
        .message_id = "msg_n",
        .locator = "ses_n",
        .provider_strategy = "p",
        .submit = .none,
    });
    try std.testing.expectEqual(State.automation_buffering, arb.currentState());
}

// B2 POSITIVE CONTROL: allocator failure during operatorResume must not leave
// freed pointers in claim fields (double-free at deinit / UAF on next use).
// Against unfixed code (free without null, late errdefer) this double-frees.
test "B2 positive control: operatorResume dupe failure leaves no freed pointers" {
    const FailNth = struct {
        parent: std.mem.Allocator,
        n: usize,
        count: usize = 0,

        fn allocator(self: *@This()) std.mem.Allocator {
            return .{
                .ptr = self,
                .vtable = &.{
                    .alloc = alloc,
                    .resize = resize,
                    .remap = remap,
                    .free = free,
                },
            };
        }
        fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.count += 1;
            if (self.count == self.n) return null;
            return self.parent.rawAlloc(len, alignment, ret_addr);
        }
        fn resize(ctx: *anyopaque, buf: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.parent.rawResize(buf, alignment, new_len, ret_addr);
        }
        fn remap(ctx: *anyopaque, buf: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.parent.rawRemap(buf, alignment, new_len, ret_addr);
        }
        fn free(ctx: *anyopaque, buf: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.parent.rawFree(buf, alignment, ret_addr);
        }
    };

    // Fail the first dupe in operatorResume (viewer_id) after free+null of olds.
    {
        var gpa_state: std.heap.GeneralPurposeAllocator(.{}) = .{};
        defer {
            const leak = gpa_state.deinit();
            std.testing.expect(leak == .ok) catch @panic("B2: leak/double-free detected (viewer dupe fail)");
        }
        const gpa = gpa_state.allocator();
        var fail = FailNth{ .parent = gpa, .n = 1 };
        // Pre-allocate claim with parent so only resume dupes use FailNth.
        var sink = MockSink{ .allocator = gpa };
        defer sink.deinit();
        var arb = InputArbiter.init(gpa, sink.sink(), IdentityEncoder.encoder(), StaticCancel.encoder());
        defer arb.deinit();

        _ = try arb.claimAcquire("viewer-old", "clm_old");
        try arb.viewerDisconnect();
        // Switch allocator to failing for resume path only.
        arb.allocator = fail.allocator();
        const err = arb.operatorResume("viewer-new", "clm_new", "human");
        try std.testing.expectError(error.Internal, err);
        // Fields must be null — not dangling freed pointers.
        try std.testing.expect(arb.owner_viewer_id == null);
        try std.testing.expect(arb.claim_id == null);
        // Restore parent for safe deinit of remaining arbiter state.
        arb.allocator = gpa;
    }

    // Fail the second dupe (claim_id) after viewer dupe succeeded.
    {
        var gpa_state: std.heap.GeneralPurposeAllocator(.{}) = .{};
        defer {
            const leak = gpa_state.deinit();
            std.testing.expect(leak == .ok) catch @panic("B2: leak/double-free detected (claim dupe fail)");
        }
        const gpa = gpa_state.allocator();
        var sink = MockSink{ .allocator = gpa };
        defer sink.deinit();
        var arb = InputArbiter.init(gpa, sink.sink(), IdentityEncoder.encoder(), StaticCancel.encoder());
        defer arb.deinit();

        _ = try arb.claimAcquire("viewer-old", "clm_old");
        try arb.viewerDisconnect();
        // n=1 fails first alloc under FailNth; but claimAcquire already done.
        // operatorResume: free olds (no alloc), dupe viewer (count=1 fail if n=1).
        // For second-dupe failure: n=2.
        var fail = FailNth{ .parent = gpa, .n = 2 };
        arb.allocator = fail.allocator();
        const err = arb.operatorResume("viewer-new", "clm_new", "human");
        try std.testing.expectError(error.Internal, err);
        // Viewer may have been allocated then freed by errdefer; both null.
        try std.testing.expect(arb.owner_viewer_id == null);
        try std.testing.expect(arb.claim_id == null);
        arb.allocator = gpa;
    }
}
