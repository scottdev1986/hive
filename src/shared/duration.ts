export function formatRoundedSeconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)}s`;
}
