// A user or owner control message is a ruling, not just mail. Completing it
// without writing that ruling to repo memory is how the next queen re-asks
// the same question. The itemId is the citation: evidence or body must name
// the message that produced the article, so the complete gate can see it.

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
