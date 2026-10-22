import { NextRequest } from "next/server";
import { db } from "@/db";
import { whatsappCampaigns, whatsappCampaignRecipients } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/auth";
import { ok, fail, refreshCounters } from "@/lib/whatsappCampaigns";

export const dynamic = "force-dynamic";

/* POST /api/whatsapp/campaigns/:id/cancel */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return fail("Unauthorized", 401);

    const id = Number((await params).id);
    if (!Number.isInteger(id)) return fail("Invalid campaign id");

    const [campaign] = await db
      .select()
      .from(whatsappCampaigns)
      .where(and(eq(whatsappCampaigns.id, id), eq(whatsappCampaigns.userId, userId)))
      .limit(1);

    if (!campaign) return fail("Campaign not found", 404);

    if (!["draft", "scheduled", "sending"].includes(campaign.status)) {
      return fail(`A ${campaign.status} campaign cannot be cancelled`, 409);
    }

    // Mark cancelled first so the dispatch loop stops, then drop unsent recipients.
    await db
      .update(whatsappCampaigns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(whatsappCampaigns.id, id));

    await db
      .update(whatsappCampaignRecipients)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(whatsappCampaignRecipients.campaignId, id),
          eq(whatsappCampaignRecipients.status, "pending")
        )
      );

    await refreshCounters(id);

    return ok({ id, status: "cancelled" });
  } catch (error) {
    console.error("[WhatsApp Campaign Cancel]", error);
    return fail("Failed to cancel campaign", 500);
  }
}