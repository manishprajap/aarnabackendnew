import { NextRequest } from "next/server";
import { dispatchDueCampaigns, ok, fail } from "@/lib/whatsappCampaigns";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/whatsapp/campaigns/dispatch — OPTIONAL cron endpoint.
 * Sends scheduled campaigns whose scheduledAt has passed.
 * Call it every minute from a cron (Vercel Cron, cron-job.org, systemd timer...) with:
 *   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return fail("Unauthorized", 401);
  }

  try {
    const started = await dispatchDueCampaigns();
    return ok({ started });
  } catch (error) {
    console.error("[WhatsApp Campaigns Dispatch]", error);
    return fail("Failed to dispatch campaigns", 500);
  }
}