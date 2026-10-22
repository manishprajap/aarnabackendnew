import { NextRequest } from "next/server";
import { db } from "@/db";
import { whatsappCampaigns, whatsappCampaignRecipients } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/auth";
import { ok, fail, computeQuota, dispatchCampaign } from "@/lib/whatsappCampaigns";

export const dynamic = "force-dynamic";

/* POST /api/whatsapp/campaigns/:id/retry  — re-send only the failed recipients */
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

    if (campaign.status === "sending") return fail("Campaign is still sending", 409);
    if (campaign.status === "cancelled") return fail("A cancelled campaign cannot be retried", 409);
    if (campaign.status === "scheduled" || campaign.status === "draft") {
      return fail("Campaign has not been sent yet", 409);
    }

    const r = whatsappCampaignRecipients;
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(r)
      .where(and(eq(r.campaignId, id), eq(r.status, "failed")));
    const failedCount = Number(row?.n ?? 0);
    if (failedCount === 0) return fail("There are no failed messages to retry", 409);

    // Respect the one-active-campaign limit on limited plans
    const quota = await computeQuota(userId);
    if (quota.activeLimit !== null && quota.activeCount >= quota.activeLimit) {
      return fail(
        "Another campaign is currently active. Wait for it to finish before retrying.",
        403
      );
    }

    await db
      .update(r)
      .set({ status: "pending", errorMessage: null })
      .where(and(eq(r.campaignId, id), eq(r.status, "failed")));

    await db
      .update(whatsappCampaigns)
      .set({ status: "sending", failed: 0, completedAt: null })
      .where(eq(whatsappCampaigns.id, id));

    dispatchCampaign(id).catch((err) => console.error("[Campaign retry]", err));

    return ok({ id, retrying: failedCount });
  } catch (error) {
    console.error("[WhatsApp Campaign Retry]", error);
    return fail("Failed to retry campaign", 500);
  }
}