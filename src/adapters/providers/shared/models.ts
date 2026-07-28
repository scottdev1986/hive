/** The CLI family that can run a model name. Explicit model names launch
 * verbatim; null means the name cannot be validated by family. */
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
