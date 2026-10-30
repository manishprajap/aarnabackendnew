import { NextRequest, NextResponse } from "next/server";
import { getPublicBusinessSite } from "@/lib/publicBusinessSite";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const site = await getPublicBusinessSite(slug);
    if (!site) {
      return NextResponse.json({ message: "Business website not found" }, { status: 404 });
    }
    return NextResponse.json({ site }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Public Business Website GET]", error);
    return NextResponse.json(
      { message: "Could not load this business website" },
      { status: 500 },
    );
  }
}