import {
  CapabilityProviderSchema,
  unknownVendor,
} from "../../schemas";

// CLAUDE_BEST_MODEL and CLAUDE_OPUS_MODEL used to live here: compiled-in
// model ids, i.e. predetermined model knowledge, removed as route sources by
// the user's directive (2026-07-12). The binary names no model; what a CLI's
// alias resolves to is the vendor's fact, read live via capability discovery
// (`claude`'s initialize menu maps its own aliases) — never a constant that
// silently goes stale when the vendor's top model changes.

// Which vendor's CLI can actually run a user-named model. An explicit model
// launches verbatim (never substituted), so launching it on the other
// vendor's tool produces a vendor-impossible execution identity — the field
// failure was routing picking tool=codex while the caller pinned
// model="claude-opus-4-8", opening a Codex TUI that can never run it. Null
// means the name matches no known vendor family and cannot be validated.
export function modelVendor(model: string): "claude" | "codex" | null {
  const value = model.trim().toLowerCase();
  if (
    /^claude([-.]|$)/.test(value) ||
    ["best", "sonnet", "opus", "haiku", "fable"].includes(value)
  ) {
    return "claude";
  }
  if (/^(gpt|codex)([-.]|$)/.test(value) || /^o[0-9]/.test(value)) {
    return "codex";
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

