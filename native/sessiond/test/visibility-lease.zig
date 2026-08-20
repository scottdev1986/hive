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

test "a running host holds its own lease open" {
    var lease = try VisibilityLease.initial("workspace-1", 7, 1_000);
    const first = lease.expires_mono_ns;
    try std.testing.expect(!lease.expired(first - 1));
    lease.touch(first + 1);
    try std.testing.expect(lease.expires_mono_ns > first);
    try std.testing.expect(!lease.expired(first + 1));
}

test "touch does not revive an expired lease" {
    var lease = try VisibilityLease.initial("workspace-1", 7, 1_000);
    const lifetime = generated.limits.visibility_expiry_ms * std.time.ns_per_ms;
    try std.testing.expect(lease.expired(1_000 + lifetime));
    const frozen = lease.expires_mono_ns;
    lease.touch(1_000 + lifetime + 1);
    try std.testing.expectEqual(frozen, lease.expires_mono_ns);
    try std.testing.expect(lease.expired(1_000 + lifetime + 1));
}
