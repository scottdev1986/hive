export interface MemoryClassRows<T> {
  pitfalls: T[];
  articles: T[];
}

export function selectMemoryClasses<T>(
  baseRows: readonly T[],
  deeperRows: readonly T[],
  limit: number,
  isPitfall: (row: T) => boolean,
): MemoryClassRows<T> {
  let pitfalls = baseRows.filter(isPitfall);
  let articles = baseRows.filter((row) => !isPitfall(row));
  if (pitfalls.length === 0) {
    pitfalls = deeperRows.filter(isPitfall).slice(0, limit);
  }
  if (articles.length === 0) {
    articles = deeperRows.filter((row) => !isPitfall(row)).slice(0, limit);
  }
  return { pitfalls, articles };
}

const BRIEF_STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "were",
  "your",
  "task",
  "agent",
]);

export function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    if (token.length >= 4 && !BRIEF_STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}
