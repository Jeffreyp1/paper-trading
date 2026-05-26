import { NextResponse } from "next/server";
import { removeWatchlistItem } from "@/lib/watchlistStore";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const ok = removeWatchlistItem(params.id);
  return NextResponse.json({ ok });
}
