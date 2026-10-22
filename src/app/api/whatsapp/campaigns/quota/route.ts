import { NextRequest } from "next/server";
import { getUserIdFromRequest } from "@/lib/auth";
import { ok, fail, computeQuota } from "@/lib/whatsappCampaigns";

export const dynamic = "force-dynamic";

/* GET /api/whatsapp/campaigns/quota */
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return fail("Unauthorized", 401);

    return ok(await computeQuota(userId));
  } catch (error) {
    console.error("[WhatsApp Campaigns Quota GET]", error);
    return fail("Failed to load quota", 500);
  }
}