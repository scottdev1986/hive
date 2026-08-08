/** Lowercases, collapses every run of non-alphanumeric characters to a single dash, trims leading/trailing dashes, and truncates to `max` characters (re-trimming any dash left dangling by the cut). Falls back to `"fact"` when nothing alphanumeric survives. */
export function slugify(value: string, max = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "fact";
}
