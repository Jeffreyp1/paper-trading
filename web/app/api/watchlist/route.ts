import { NextResponse } from "next/server";
import { listWatchlist } from "@/lib/watchlistStore";

export const dynamic = "force-dynamic";

// CLAUDE.md: `watchlist_items` schema exists but no Node/Go route touches it.
// We back this with an in-process store seeded from the dashboard fallbacks.
// Documented as a Known upstream gap in web/README.md.
export async function GET() {
  return NextResponse.json({ items: listWatchlist() });
}
