const std = @import("std");
const generated = @import("session_protocol_generated");
const pty_host = @import("pty_host");

pub const schema_version: u8 = 1;
pub const record_relative_path = "record.json";
pub const control_relative_path = "control.cap";
pub const runtime_relative_path = "neutral";
pub const operation_payload_max_bytes: usize = 16 * 1024 * 1024;

pub const SessionRef = struct {
    key: []const u8,
    incarnation: []const u8,

    pub fn eql(self: SessionRef, other: SessionRef) bool {
        return std.mem.eql(u8, self.key, other.key) and
            std.mem.eql(u8, self.incarnation, other.incarnation);
    }
};

pub const ProcessIdentity = generated.TerminalHostProcessIdentity;

pub const WindowSize = generated.TerminalHostWindowSize;

pub fn ptyGeometry(window: WindowSize) pty_host.Geometry {
    return .{
        .columns = window.columns,
        .rows = window.rows,
        .width_px = window.widthPixels,
        .height_px = window.heightPixels,
    };
}

pub const TerminalProfile = struct {
    inputMode: enum { canonical, literal },
    echo: bool,
    signalCharacters: bool,
    softwareFlowControl: bool,
    eofByte: u8,
    startByte: u8,
    stopByte: u8,
    hangupOnLastClose: bool,

    pub fn ptyProfile(self: TerminalProfile) pty_host.TerminalProfile {
        return .{
            .input_mode = switch (self.inputMode) {
                .canonical => .canonical,
                .literal => .literal,
            },
            .echo = self.echo,
            .signal_characters = self.signalCharacters,
            .software_flow_control = self.softwareFlowControl,
            .eof_byte = self.eofByte,
            .start_byte = self.startByte,
            .stop_byte = self.stopByte,
            .hangup_on_last_close = self.hangupOnLastClose,
        };
    }
};

pub const EnvironmentEntry = struct { name: []const u8, value: []const u8 };

pub const TransferableHandle = struct {
    token: []const u8,
    sourceDisposition: enum { retain, @"close-after-transfer" },
};

pub const DescriptorMapping = struct {
    handle: TransferableHandle,
    targetDescriptor: i32,
};

pub const Command = struct {
    executable: []const u8,
    arguments: []const []const u8,
    workingDirectory: []const u8,
    completeEnvironment: []const EnvironmentEntry,
    descriptorMap: []const DescriptorMapping,
};

pub const CreateRequest = struct {
    key: []const u8,
    idempotencyKey: []const u8,
    command: Command,
    terminalProfile: TerminalProfile,
    initialWindow: WindowSize,
};

pub const LaunchSpec = struct {
    argv: []const []const u8,
    cwd: []const u8,
    envp: []const []const u8,
    terminalProfile: TerminalProfile,
    initialWindow: WindowSize,
};

pub const HostLimits = struct {
    maxInputTransactionBytes: usize,
    maxInputQueueBytes: usize,
    maxOutputFrameBytes: usize,
    outputLowWaterBytes: usize,
    outputHighWaterBytes: usize,
    outputRetentionBytes: usize,
};

pub const JobControlEvidence = generated.TerminalHostJobControlEvidence;
pub const ExitStatus = generated.TerminalHostExitStatus;
pub const ReapEvidence = generated.TerminalHostReapEvidence;

pub const OsCode = union(enum) {
    string: []const u8,
    number: i32,
};

pub const LaunchOutcome = union(enum) {
    running: struct {
        child: ProcessIdentity,
        execProof: enum { @"replacement-observed" },
        jobControl: JobControlEvidence,
    },
    @"exec-failed": struct {
        layer: enum {
            command,
            @"working-directory",
            environment,
            @"descriptor-transfer",
            @"terminal-setup",
            @"exec-transition",
        },
        osCode: ?OsCode,
        diagnostic: []const u8,
    },
    exited: struct { exit: ExitStatus, reap: ReapEvidence },
    unknown: struct { diagnostic: []const u8 },
};

pub const CreateResult = struct {
    session: SessionRef,
    outcome: LaunchOutcome,
    limits: HostLimits,
};

pub const Host = struct {
    context: *anyopaque,
    createFn: *const fn (*anyopaque, CreateRequest) anyerror!CreateResult,

    pub fn create(self: Host, request: CreateRequest) !CreateResult {
        return self.createFn(self.context, request);
    }
};

pub fn putLength(hasher: *std.crypto.hash.sha2.Sha256, length: usize) void {
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(u64, &bytes, @intCast(length), .big);
    hasher.update(&bytes);
}
