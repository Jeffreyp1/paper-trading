// In-memory watchlist seeded from fallback values.
// CLAUDE.md notes the `watchlist_items` Postgres table exists but no route
// touches it, so we keep this list per-process here. Survives across requests
// in dev (single Next.js server) but resets on restart.

import { FALLBACK_WATCHLIST, type WatchRow } from "./fallback";

type Store = { items: WatchRow[] };

const g = globalThis as unknown as { __stocky_watchlist?: Store };
if (!g.__stocky_watchlist) {
  g.__stocky_watchlist = { items: [...FALLBACK_WATCHLIST] };
}

export function listWatchlist(): WatchRow[] {
  return g.__stocky_watchlist!.items;
}

export function removeWatchlistItem(id: string): boolean {
  const store = g.__stocky_watchlist!;
  const before = store.items.length;
  store.items = store.items.filter((row) => row.id !== id);
  return store.items.length < before;
}
