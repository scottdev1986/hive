/** The one chars→tokens estimation convention Hive uses when no provider has measured anything: four characters per token, never below one. Budget fitters (memory recall, episodic query classes, digest truncation) share this so their ceilings mean the same thing everywhere; a reading a provider actually reported never passes through here. */

export const CHARS_PER_TOKEN = 4;

export const estimateTokensForText = (text: string): number =>
  Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));

export const estimateTokensForValue = (value: unknown): number =>
  estimateTokensForText(JSON.stringify(value));
