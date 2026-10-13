import { NextResponse } from "next/server";
import { getUpcomingFestivals } from "@/lib/festivalBanner";

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  try {
    const items = await getUpcomingFestivals(2);
    return NextResponse.json({ success: true, festivals: items }, { headers: corsHeaders });
  } catch (error) {
    console.error("GET /api/festivals/upcoming failed:", error);
    return NextResponse.json(
      { success: false, error: "Could not load upcoming festivals and occasions." },
      { status: 500, headers: corsHeaders },
    );
  }
}
