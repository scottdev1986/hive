import { discoverMemoryFacts } from "../../memory-service/memory-store";

export async function repoMemoryCitesItem(
  repoRoot: string,
  itemId: string,
): Promise<boolean> {
  const facts = await discoverMemoryFacts(repoRoot, "repo");
  return facts.some(
    (fact) => fact.evidence.includes(itemId) || fact.body.includes(itemId),
  );
}
