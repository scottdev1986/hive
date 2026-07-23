const std = @import("std");
const generated = @import("session_protocol_generated");
const VisibilityLease = @import("visibility_lease").VisibilityLease;

test "lease expires at the configured bound" {
    var lease = try VisibilityLease.initial("workspace-1", 7, 1_000);
    const lifetime = generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expect(!lease.expired(1_000 + lifetime - 1));
    try std.testing.expect(lease.expired(1_000 + lifetime));
    try std.testing.expectEqualStrings("expired", @tagName(lease.state));
}

test "renewal rejects stale and cross-workspace claims" {
    var lease = try VisibilityLease.initial("workspace-1", 7, 1_000);
    try std.testing.expectError(
        error.VisibilityForbidden,
        lease.renew("workspace-2", 8, 2_000),
    );
    try std.testing.expectError(
        error.StaleVisibilityRevision,
        lease.renew("workspace-1", 6, 2_000),
    );
    try lease.renew("workspace-1", 8, 2_000);
    try std.testing.expectEqual(@as(u64, 8), lease.open_terminal_revision);
}
