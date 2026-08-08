/** Rounds a millisecond duration to the nearest second and renders it as `"Ns"`. */
export function formatRoundedSeconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)}s`;
}
