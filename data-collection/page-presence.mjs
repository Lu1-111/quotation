export const PAGE_LEASE_MS = 30_000;
export const validPageId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(id);

export function createPagePresence({ onInactive = () => {}, now = Date.now, leaseMs = PAGE_LEASE_MS } = {}) {
  const sources = new Map();

  function remove(sourceId, pageId, entry) {
    const pages = sources.get(sourceId);
    if (pages?.get(pageId) !== entry) return;
    pages.delete(pageId);
    if (!pages.size) sources.delete(sourceId);
    entry.close();
    if (!sources.has(sourceId)) Promise.resolve(onInactive(sourceId)).catch(() => {});
  }

  function sweepSource(sourceId) {
    for (const [pageId, entry] of [...(sources.get(sourceId) || [])]) {
      if (entry.expiresAt <= now()) remove(sourceId, pageId, entry);
    }
  }

  return {
    leaseMs,
    attach(sourceId, pageId, close = () => {}) {
      if (!validPageId(pageId)) throw new Error('网页连接标识无效。');
      sweepSource(sourceId);
      if (!sources.has(sourceId)) sources.set(sourceId, new Map());
      const pages = sources.get(sourceId);
      const previous = pages.get(pageId);
      const entry = { close, expiresAt: now() + leaseMs, confirmed: false };
      pages.set(pageId, entry);
      previous?.close();
      return () => remove(sourceId, pageId, entry);
    },
    touch(sourceId, pageId) {
      sweepSource(sourceId);
      const entry = sources.get(sourceId)?.get(pageId);
      if (!entry) return false;
      entry.confirmed = true;
      entry.expiresAt = now() + leaseMs;
      return true;
    },
    release(sourceId, pageId) {
      const entry = sources.get(sourceId)?.get(pageId);
      if (entry) remove(sourceId, pageId, entry);
    },
    active(sourceId) {
      sweepSource(sourceId);
      return [...(sources.get(sourceId)?.values() || [])].some((entry) => entry.confirmed);
    },
    sweep() { for (const sourceId of [...sources.keys()]) sweepSource(sourceId); },
  };
}
