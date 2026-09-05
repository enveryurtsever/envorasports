/**
 * A tiny in-process cache with a time-to-live.
 *
 * The database sits on a remote host, so every query costs roughly 70ms of
 * round trip. A data-rich dashboard makes fifteen of them, and none of the
 * viewer-independent ones change between requests — they only change when a job
 * runs. Holding them briefly turns a 1.2s page into a fast one.
 *
 * Deliberately per-process: anything that must be immediately fresh — a
 * viewer's entitlements, a coupon they just edited — is simply not cached.
 */

interface Entry<T> {
  at: number;
  value: T;
  /** Kept so concurrent callers share one in-flight computation. */
  pending?: Promise<T>;
}

const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const entry = store.get(key) as Entry<T> | undefined;

  if (entry) {
    if (entry.value !== undefined && Date.now() - entry.at <= ttlMs) return entry.value;
    // Expired but a refresh is already running: join it rather than starting a
    // second identical query.
    if (entry.pending) return entry.pending;
  }

  const pending = load();
  store.set(key, { at: Date.now(), value: entry?.value as T, pending });

  try {
    const value = await pending;
    store.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    // A failed refresh must not leave a rejected promise in the cache.
    store.delete(key);
    throw error;
  }
}

export function invalidate(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function invalidateAll(): void {
  store.clear();
}
