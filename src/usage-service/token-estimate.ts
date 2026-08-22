export const CHARS_PER_TOKEN = 4;

export const estimateTokensForText = (text: string): number =>
  Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));

export const estimateTokensForValue = <T>(value: T): number =>
  estimateTokensForText(JSON.stringify(value));
