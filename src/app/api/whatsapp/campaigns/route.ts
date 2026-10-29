import { NextRequest, after } from "next/server";
import { db } from "@/db";
import { whatsappCampaigns, whatsappCampaignRecipients } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/auth";
import {
  ok,
  fail,
  computeQuota,
  normalizePhone,
  serializeCampaign,
  getActiveConnection,
  getAccessToken,
  fetchTemplate,
} from "@/lib/whatsappCampaigns";
import { dispatchCampaign } from "@/lib/whatsappCampaignDispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CUSTOM_MESSAGE_LENGTH = 1000;
const MAX_CAMPAIGN_RECIPIENTS = 10000;
const PAID_PLANS = new Set(["pro", "paid", "premium", "business", "enterprise"]);

function countPlaceholders(text?: string | null): number {
  const nums = Array.from(
    (text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g),
  ).map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

function templateBody(template: any): string {
  if (typeof template?.bodyText === "string") return template.bodyText;
  const body = Array.isArray(template?.components)
    ? template.components.find(
        (c: any) => String(c?.type).toUpperCase() === "BODY",
      )
    : null;
  return typeof body?.text === "string" ? body.text : "";
}

function isPaidPlan(plan: unknown): boolean {
  return PAID_PLANS.has(String(plan ?? "free").trim().toLowerCase());
}

/* GET /api/whatsapp/campaigns */
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return fail("Unauthorized", 401);

    const campaigns = await db
      .select()
      .from(whatsappCampaigns)
      .where(eq(whatsappCampaigns.userId, userId))
      .orderBy(desc(whatsappCampaigns.createdAt));

    return ok(campaigns.map(serializeCampaign));
  } catch (error) {
    console.error("[WhatsApp Campaigns GET]", error);
    return fail("Failed to load campaigns", 500);
  }
}

/* POST /api/whatsapp/campaigns */
export async function POST(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return fail("Unauthorized", 401);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid JSON body", 400);
    }

    const {
      name,
      templateId,
      parameters = [],
      customMessage,
      recipients,
      scheduledAt,
      optInConfirmed,
    } = body ?? {};

    if (typeof name !== "string" || !name.trim()) {
      return fail("Campaign name is required", 400);
    }
    if (templateId === undefined || templateId === null || String(templateId).trim() === "") {
      return fail("Template is required", 400);
    }
    if (optInConfirmed !== true) {
      return fail("You must confirm that all recipients have opted in to receive messages", 400);
    }
    if (!Array.isArray(parameters) || parameters.some((p) => typeof p !== "string")) {
      return fail("parameters must be an array of strings", 400);
    }
    if (customMessage !== undefined && customMessage !== null && typeof customMessage !== "string") {
      return fail("customMessage must be a string", 400);
    }
    if (typeof customMessage === "string" && customMessage.trim().length > MAX_CUSTOM_MESSAGE_LENGTH) {
      return fail(`Custom message must be ${MAX_CUSTOM_MESSAGE_LENGTH} characters or fewer`, 400);
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return fail("At least one recipient is required", 400);
    }
    if (recipients.length > MAX_CAMPAIGN_RECIPIENTS) {
      return fail(`A campaign can contain at most ${MAX_CAMPAIGN_RECIPIENTS} recipient rows`, 400);
    }

    const cleanedCustomMessage =
      typeof customMessage === "string" && customMessage.trim()
        ? customMessage.trim()
        : null;

    let scheduleDate: Date | null = null;
    if (scheduledAt !== undefined && scheduledAt !== null && scheduledAt !== "") {
      scheduleDate = new Date(scheduledAt);
      if (Number.isNaN(scheduleDate.getTime())) {
        return fail("Invalid scheduledAt date", 400);
      }
      if (scheduleDate.getTime() <= Date.now()) {
        return fail("scheduledAt must be in the future", 400);
      }
    }

    const seen = new Set<string>();
    const cleaned: { phoneNumber: string; name: string | null }[] = [];
    for (const recipient of recipients) {
      const phoneNumber = normalizePhone(recipient?.phone);
      if (!phoneNumber || seen.has(phoneNumber)) continue;
      seen.add(phoneNumber);
      cleaned.push({
        phoneNumber,
        name: recipient?.name ? String(recipient.name).trim().slice(0, 191) || null : null,
      });
    }
    if (!cleaned.length) {
      return fail("No valid phone numbers found in recipients", 400);
    }

    const conn = await getActiveConnection(userId);
    if (!conn) {
      return fail("Connect your WhatsApp number before creating a campaign", 400);
    }

    const template = await fetchTemplate(
      String(templateId),
      getAccessToken(conn.accessToken),
    );
    if (!template) return fail("Template not found", 404);
    if (String(template.status ?? "").toUpperCase() !== "APPROVED") {
      return fail("Only approved templates can be used for campaigns", 400);
    }

    const expected = countPlaceholders(templateBody(template));
    const cleanedParams = parameters.map((p: string) => p.trim());
    if (cleanedParams.length !== expected || cleanedParams.some((p: string) => !p)) {
      return fail(
        expected === 0
          ? "This template has no variables. Remove the template values."
          : `This template needs ${expected} value${expected === 1 ? "" : "s"}. Fill in all of them.`,
        400,
      );
    }

    const quota = await computeQuota(userId);
    const paid = isPaidPlan(quota.plan);

    // Enforce paid-only features on the server, not just in the UI.
    if (scheduleDate && !paid) {
      return fail("Scheduled campaigns are a Pro feature. Upgrade your plan to schedule campaigns.", 403);
    }
    if (quota.activeLimit !== null && quota.activeCount >= quota.activeLimit) {
      return fail(
        `Your ${quota.plan} plan allows ${quota.activeLimit} active campaign(s) at a time. Wait for one to finish or upgrade.`,
        403,
      );
    }
    if (quota.monthlyLimit !== null && quota.usedThisMonth + cleaned.length > quota.monthlyLimit) {
      const remaining = Math.max(quota.monthlyLimit - quota.usedThisMonth, 0);
      return fail(
        `Monthly limit exceeded. You have ${remaining} message(s) left this month (limit ${quota.monthlyLimit}). Upgrade for more.`,
        403,
      );
    }

    const campaignId = await db.transaction(async (tx) => {
      const result = await tx.insert(whatsappCampaigns).values({
        userId,
        name: name.trim().slice(0, 191),
        templateId: String(templateId),
        templateName: String(template.name ?? ""),
        templateLanguage: String(template.language ?? "en"),
        parameters: cleanedParams,
        customMessage: cleanedCustomMessage,
        status: scheduleDate ? "scheduled" : "sending",
        total: cleaned.length,
        scheduledAt: scheduleDate,
        optInConfirmedAt: new Date(),
      });

      const id = Number(result[0].insertId);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("Campaign insert did not return a valid ID");
      }

      for (let i = 0; i < cleaned.length; i += 500) {
        await tx.insert(whatsappCampaignRecipients).values(
          cleaned.slice(i, i + 500).map((r) => ({
            campaignId: id,
            phoneNumber: r.phoneNumber,
            name: r.name,
            status: "pending",
          })),
        );
      }
      return id;
    });

    const [campaign] = await db
      .select()
      .from(whatsappCampaigns)
      .where(and(eq(whatsappCampaigns.id, campaignId), eq(whatsappCampaigns.userId, userId)))
      .limit(1);

    if (!campaign) {
      return fail("Campaign was created but could not be reloaded", 500);
    }

    // For scheduled campaigns, your cron/dispatch route should pick them up.
    // For immediate sends, after() keeps work attached to the Next.js request lifecycle.
    if (!scheduleDate) {
      after(async () => {
        try {
          await dispatchCampaign(campaignId);
        } catch (error) {
          console.error(`[Campaign dispatch:${campaignId}]`, error);
        }
      });
    }

    return ok(serializeCampaign(campaign), 201);
  } catch (error) {
    console.error("[WhatsApp Campaigns POST]", error);
    return fail("Failed to create campaign", 500);
  }
}
