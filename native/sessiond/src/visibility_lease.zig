const std = @import("std");
const generated = @import("session_protocol_generated");

pub const VisibilityLease = struct {
    workspace_session_id: []const u8,
    open_terminal_revision: u64,
    expires_mono_ns: u64,
    state: enum { attaching, visible, reconnecting, expired } = .attaching,

    pub fn initial(
        workspace_session_id: []const u8,
        revision: u64,
        now_ns: u64,
    ) !VisibilityLease {
        if (revision == 0) return error.InvalidVisibilityRevision;
        return .{
            .workspace_session_id = workspace_session_id,
            .open_terminal_revision = revision,
            .expires_mono_ns = try expiryFrom(now_ns),
        };
    }

    pub fn renew(
        self: *VisibilityLease,
        workspace_session_id: []const u8,
        revision: u64,
        now_ns: u64,
    ) !void {
        if (self.expired(now_ns)) return error.VisibilityExpired;
        if (!std.mem.eql(u8, self.workspace_session_id, workspace_session_id))
            return error.VisibilityForbidden;
        if (revision < self.open_terminal_revision)
            return error.StaleVisibilityRevision;
        self.open_terminal_revision = revision;
        self.expires_mono_ns = try expiryFrom(now_ns);
        self.state = .visible;
    }

    pub fn expired(self: *VisibilityLease, now_ns: u64) bool {
        if (self.state == .expired) return true;
        if (now_ns < self.expires_mono_ns) return false;
        self.state = .expired;
        return true;
    }

    fn expiryFrom(now_ns: u64) !u64 {
        return std.math.add(
            u64,
            now_ns,
            generated.limits.visibility_expiry_ms * std.time.ns_per_ms,
        );
    }
};
