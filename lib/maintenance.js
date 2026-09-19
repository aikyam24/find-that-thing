import { expireBatch, evictOldestUnpinned, getUsage, readMeta } from './db.js';

export async function runMaintenance({ now = Date.now(), batchSize = 100 } = {}) {
  let expiredPages = 0;
  let expiredBodies = 0;
  let evictedPages = 0;
  let cursor = null;
  for (;;) {
    const batch = await expireBatch({ now, batchSize, cursor });
    expiredPages += batch.expiredPages;
    expiredBodies += batch.expiredBodies;
    cursor = batch.nextCursor;
    if (!cursor) break;
  }
  let budgetBlocked = false;
  for (;;) {
    const usage = await getUsage(now);
    if (usage.estimatedBytes <= usage.collectionBudgetBytes) {
      budgetBlocked = false;
      break;
    }
    const evicted = await evictOldestUnpinned({ now, batchSize });
    evictedPages += evicted.evictedPages;
    budgetBlocked = evicted.budgetBlocked;
    if (!evicted.evictedPages) break;
  }
  const meta = await readMeta();
  return {
    expiredPages,
    expiredBodies,
    evictedPages,
    budgetBlocked: Boolean(budgetBlocked || meta.budgetBlocked),
    nextCursor: null,
  };
}
