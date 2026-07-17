//! Shared HVTCP001 116-byte header fixture.
//! Binary source: hvtcp001-header.bin (locked against checkpoint-envelope.c).
pub const bytes: *const [116]u8 = @embedFile("hvtcp001-header.bin");
