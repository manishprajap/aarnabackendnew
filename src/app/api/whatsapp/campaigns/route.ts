import { NextRequest, after } from "next/server"; // `after` requires Next.js 15+
import { db } from "@/db";
import { whatsappCampaigns, whatsappCampaignRecipients } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
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
// Keep the function alive long enough to finish sending (Vercel etc.)
export const maxDuration = 300;

const MAX_CUSTOM_MESSAGE_LENGTH = 1000;

/** Highest {{n}} placeholder in a template body. */
function countPlaceholders(text?: string | null): number {
  const nums = Array.from((text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)).map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/** Works whether fetchTemplate returns bodyText or raw Meta `components`. */
function templateBody(template: any): string {
  if (typeof template?.bodyText === "string") return template.bodyText;
  const body = Array.isArray(template?.components)
    ? template.components.find((c: any) => String(c?.type).toUpperCase() === "BODY")
    : null;
  return typeof body?.text === "string" ? body.text : "";
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
      return fail("Invalid JSON body");
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

    /* ---------- validation ---------- */
    if (!name || typeof name !== "string" || !name.trim()) return fail("Campaign name is required");
    if (templateId === undefined || templateId === null || templateId === "") {
      return fail("Template is required");
    }
    if (!optInConfirmed) {
      return fail("You must confirm that all recipients have opted in to receive messages");
    }
    if (!Array.isArray(parameters) || parameters.some((p) => typeof p !== "string")) {
      return fail("parameters must be an array of strings");
    }
    if (customMessage !== undefined && customMessage !== null && typeof customMessage !== "string") {
      return fail("customMessage must be a string");
    }
    if (typeof customMessage === "string" && customMessage.trim().length > MAX_CUSTOM_MESSAGE_LENGTH) {
      return fail(`Custom message must be ${MAX_CUSTOM_MESSAGE_LENGTH} characters or fewer`);
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return fail("At least one recipient is required");
    }

    const cleanedCustomMessage: string | null =
      typeof customMessage === "string" && customMessage.trim() ? customMessage.trim() : null;

    let scheduleDate: Date | null = null;
    if (scheduledAt) {
      scheduleDate = new Date(scheduledAt);
      if (isNaN(scheduleDate.getTime())) return fail("Invalid scheduledAt date");
      if (scheduleDate.getTime() <= Date.now()) return fail("scheduledAt must be in the future");
    }

    // normalise + de-duplicate recipients
    const seen = new Set<string>();
    const cleaned: { phoneNumber: string; name: string | null }[] = [];
    for (const r of recipients) {
      const phoneNumber = normalizePhone(r?.phone);
      if (!phoneNumber || seen.has(phoneNumber)) continue;
      seen.add(phoneNumber);
      cleaned.push({ phoneNumber, name: r?.name ? String(r.name).slice(0, 191) : null });
    }
    if (cleaned.length === 0) return fail("No valid phone numbers found in recipients");

    /* ---------- WhatsApp connection + template (templates live in Meta) ---------- */
    const conn = await getActiveConnection(userId);
    if (!conn) return fail("Connect your WhatsApp number before creating a campaign", 400);

    const template = await fetchTemplate(String(templateId), getAccessToken(conn.accessToken));
    if (!template) return fail("Template not found", 404);
    if (template.status !== "APPROVED") {
      return fail("Only approved templates can be used for campaigns");
    }

    // The number of values must match the template, otherwise Meta rejects every message (error 132000).
    const expected = countPlaceholders(templateBody(template));
    const cleanedParams: string[] = parameters.map((p: string) => p.trim());
    if (cleanedParams.length !== expected || cleanedParams.some((p) => !p)) {
      return fail(
        expected === 0
          ? "This template has no variables. Remove the template values."
          : `This template needs ${expected} value${expected === 1 ? "" : "s"}. Fill in all of them.`
      );
    }

    /* ---------- plan quota ---------- */
    const quota = await computeQuota(userId);
    if (quota.activeLimit !== null && quota.activeCount >= quota.activeLimit) {
      return fail(
        `Your ${quota.plan} plan allows ${quota.activeLimit} active campaign(s) at a time. Wait for it to finish or upgrade.`,
        403
      );
    }
    if (quota.monthlyLimit !== null && quota.usedThisMonth + cleaned.length > quota.monthlyLimit) {
      const remaining = Math.max(quota.monthlyLimit - quota.usedThisMonth, 0);
      return fail(
        `Monthly limit exceeded. You have ${remaining} message(s) left this month (limit ${quota.monthlyLimit}). Upgrade for more.`,
        403
      );
    }

    /* ---------- create campaign + recipients atomically ---------- */
    const campaignId = await db.transaction(async (tx) => {
      const result = await tx.insert(whatsappCampaigns).values({
        userId,
        name: name.trim(),
        templateId: String(templateId),
        templateName: template.name,
        templateLanguage: template.language,
        parameters: cleanedParams,
        customMessage: cleanedCustomMessage,
        status: scheduleDate ? "scheduled" : "sending",
        total: cleaned.length,
        scheduledAt: scheduleDate,
        optInConfirmedAt: new Date(),
      });
      const id = Number(result[0].insertId);

      for (let i = 0; i < cleaned.length; i += 500) {
        await tx.insert(whatsappCampaignRecipients).values(
          cleaned.slice(i, i + 500).map((r) => ({
            campaignId: id,
            phoneNumber: r.phoneNumber,
            name: r.name,
            status: "pending",
          }))
        );
      }
      return id;
    });

    const [campaign] = await db
      .select()
      .from(whatsappCampaigns)
      .where(eq(whatsappCampaigns.id, campaignId))
      .limit(1);

    // Send immediately, but keep the serverless function alive until sending finishes.
    // Scheduled campaigns are picked up by the cron route.
    if (!scheduleDate) {
      after(async () => {
        try {
          await dispatchCampaign(campaignId);
        } catch (err) {
          console.error("[Campaign dispatch]", err);
        }
      });
    }

    return ok(serializeCampaign(campaign), 201);
  } catch (error) {
    console.error("[WhatsApp Campaigns POST]", error);
    return fail("Failed to create campaign", 500);
  }
}