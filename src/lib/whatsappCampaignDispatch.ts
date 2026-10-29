/**
 * lib/whatsappCampaignDispatch.ts
 *
 * Sends a campaign's approved template to every pending recipient, filling the
 * template variables ({{1}}, {{2}}…) with the campaign parameters. A parameter may
 * contain {{name}}, which is replaced with each recipient's name.
 *
 * ADJUST if your schema differs: the recipient columns `errorMessage`, `waMessageId`,
 * `sentAt`, and the campaign columns `sent`, `failed`, `completedAt`.
 */
import { db } from "@/db";
import { whatsappCampaigns, whatsappCampaignRecipients } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getActiveConnection, getAccessToken } from "@/lib/whatsappCampaigns";

const GRAPH_VERSION = "v21.0";
const CONCURRENCY = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Meta rejects empty params, newlines, tabs and 5+ consecutive spaces in template params. */
function sanitizeParam(value: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/ {5,}/g, "    ").trim();
  return cleaned || "-";
}

function fillParam(value: string, recipientName: string | null): string {
  const filled = value.replace(/\{\{\s*name\s*\}\}/gi, recipientName?.trim() || "there");
  return sanitizeParam(filled);
}

type SendResult = { ok: true; messageId: string | null } | { ok: false; error: string };

async function sendTemplate(opts: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  language: string;
  parameters: string[];
  recipientName: string | null;
}): Promise<SendResult> {
  const template: Record<string, unknown> = {
    name: opts.templateName,
    language: { code: opts.language },
  };

  // Without a `body` component Meta sends the template with NO variables filled in.
  if (opts.parameters.length > 0) {
    template.components = [
      {
        type: "body",
        parameters: opts.parameters.map((p) => ({
          type: "text",
          text: fillParam(p, opts.recipientName),
        })),
      },
    ];
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: opts.to,
          type: "template",
          template,
        }),
      }
    );

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error;
      const detail = err?.error_data?.details || err?.message || `HTTP ${res.status}`;
      return { ok: false, error: `${err?.code ? `(${err.code}) ` : ""}${detail}`.slice(0, 500) };
    }
    return { ok: true, messageId: data?.messages?.[0]?.id ?? null };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : "Network error").slice(0, 500) };
  }
}

export async function dispatchCampaign(campaignId: number): Promise<void> {
  const [campaign] = await db
    .select()
    .from(whatsappCampaigns)
    .where(eq(whatsappCampaigns.id, campaignId))
    .limit(1);
  if (!campaign) return;
  if (campaign.status !== "sending" && campaign.status !== "scheduled") return;

  await db
    .update(whatsappCampaigns)
    .set({ status: "sending" })
    .where(eq(whatsappCampaigns.id, campaignId));

  const conn: any = await getActiveConnection(campaign.userId);
  if (!conn) {
    await db
      .update(whatsappCampaigns)
      .set({ status: "failed" })
      .where(eq(whatsappCampaigns.id, campaignId));
    return;
  }

  const accessToken = getAccessToken(conn.accessToken);
  const parameters: string[] = Array.isArray(campaign.parameters)
    ? (campaign.parameters as string[])
    : [];

  while (true) {
    // Stop if the user cancelled while we were sending
    const [current] = await db
      .select({ status: whatsappCampaigns.status })
      .from(whatsappCampaigns)
      .where(eq(whatsappCampaigns.id, campaignId))
      .limit(1);
    if (!current || current.status !== "sending") return;

    const batch = await db
      .select()
      .from(whatsappCampaignRecipients)
      .where(
        and(
          eq(whatsappCampaignRecipients.campaignId, campaignId),
          eq(whatsappCampaignRecipients.status, "pending")
        )
      )
      .limit(CONCURRENCY);

    if (batch.length === 0) break;

    const results = await Promise.all(
      batch.map((recipient) =>
        sendTemplate({
          phoneNumberId: conn.phoneNumberId,
          accessToken,
          to: recipient.phoneNumber,
          templateName: campaign.templateName,
          language: campaign.templateLanguage,
          parameters,
          recipientName: recipient.name,
        })
      )
    );

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < batch.length; i++) {
      const result = results[i];
      if (result.ok) {
        sentCount += 1;
        await db
          .update(whatsappCampaignRecipients)
          .set({ status: "sent", waMessageId: result.messageId, sentAt: new Date() })
          .where(eq(whatsappCampaignRecipients.id, batch[i].id));
      } else {
        failedCount += 1;
        await db
          .update(whatsappCampaignRecipients)
          .set({ status: "failed", errorMessage: result.error })
          .where(eq(whatsappCampaignRecipients.id, batch[i].id));
      }
    }

    await db
      .update(whatsappCampaigns)
      .set({
        sent: sql`${whatsappCampaigns.sent} + ${sentCount}`,
        failed: sql`${whatsappCampaigns.failed} + ${failedCount}`,
      })
      .where(eq(whatsappCampaigns.id, campaignId));

    await sleep(250); // gentle pacing to stay within Meta rate limits
  }

  await db
    .update(whatsappCampaigns)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(whatsappCampaigns.id, campaignId), eq(whatsappCampaigns.status, "sending")));
}