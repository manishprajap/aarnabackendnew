/**
 * lib/whatsappCampaignDispatch.ts
 *
 * Sends a campaign to every pending recipient.
 *
 * - If the campaign has a `customMessage` AND the recipient messaged this business
 *   in the last 24 hours -> free-text message (inside WhatsApp's customer service window).
 * - Otherwise (or if free-text is rejected as outside the window) -> approved template.
 *
 * Requires a new nullable TEXT column `customMessage` (custom_message) on whatsappCampaigns.
 * {{name}} works in both the custom message and in template parameters.
 */
import { db } from "@/db";
import {
  whatsappCampaigns,
  whatsappCampaignRecipients,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
} from "@/db/schema";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { getActiveConnection, getAccessToken } from "@/lib/whatsappCampaigns";

const GRAPH_VERSION = "v21.0";
const CONCURRENCY = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Meta error: "re-engagement message" = free-text attempted outside the 24h window.
const OUTSIDE_WINDOW_CODE = "131047";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Meta rejects empty params, newlines, tabs and 5+ consecutive spaces in template params. */
function sanitizeParam(value: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/ {5,}/g, "    ").trim();
  return cleaned || "-";
}

function fillName(value: string, recipientName: string | null): string {
  return value.replace(/\{\{\s*name\s*\}\}/gi, recipientName?.trim() || "there");
}

function fillParam(value: string, recipientName: string | null): string {
  return sanitizeParam(fillName(value, recipientName));
}

type SendResult = { ok: true; messageId: string | null } | { ok: false; error: string };

async function postMessage(
  phoneNumberId: string,
  accessToken: string,
  payload: Record<string, unknown>
): Promise<SendResult> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...payload,
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

function sendTemplate(opts: {
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

  return postMessage(opts.phoneNumberId, opts.accessToken, {
    to: opts.to,
    type: "template",
    template,
  });
}

function sendText(opts: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  text: string;
  recipientName: string | null;
}): Promise<SendResult> {
  return postMessage(opts.phoneNumberId, opts.accessToken, {
    to: opts.to,
    type: "text",
    text: { body: fillName(opts.text, opts.recipientName).slice(0, 4000), preview_url: false },
  });
}

/** Returns the set of phone numbers that sent us a message within the last 24 hours. */
async function getRecipientsInsideWindow(userId: number, phones: string[]): Promise<Set<string>> {
  const inside = new Set<string>();
  if (phones.length === 0) return inside;

  const rows = await db
    .select({
      waId: whatsappContacts.waId,
      lastInbound: max(whatsappMessages.createdAt),
    })
    .from(whatsappMessages)
    .innerJoin(whatsappConversations, eq(whatsappMessages.conversationId, whatsappConversations.id))
    .innerJoin(whatsappContacts, eq(whatsappConversations.contactId, whatsappContacts.id))
    .where(
      and(
        eq(whatsappMessages.userId, userId),
        eq(whatsappMessages.direction, "inbound"),
        inArray(whatsappContacts.waId, phones)
      )
    )
    .groupBy(whatsappContacts.waId);

  const now = Date.now();
  for (const row of rows) {
    if (!row.lastInbound) continue;
    const last = new Date(row.lastInbound as any).getTime();
    if (Number.isFinite(last) && now - last >= 0 && now - last < WINDOW_MS) {
      inside.add(String(row.waId));
    }
  }
  return inside;
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
  const customMessage = String((campaign as any).customMessage ?? "").trim();

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

    const insideWindow = customMessage
      ? await getRecipientsInsideWindow(
          campaign.userId,
          batch.map((r) => r.phoneNumber)
        )
      : new Set<string>();

    const results = await Promise.all(
      batch.map(async (recipient): Promise<SendResult> => {
        const sendAsTemplate = () =>
          sendTemplate({
            phoneNumberId: conn.phoneNumberId,
            accessToken,
            to: recipient.phoneNumber,
            templateName: campaign.templateName,
            language: campaign.templateLanguage,
            parameters,
            recipientName: recipient.name,
          });

        if (customMessage && insideWindow.has(recipient.phoneNumber)) {
          const textResult = await sendText({
            phoneNumberId: conn.phoneNumberId,
            accessToken,
            to: recipient.phoneNumber,
            text: customMessage,
            recipientName: recipient.name,
          });
          if (textResult.ok) return textResult;

          // Window was actually closed (or similar) -> fall back to the template.
          if (textResult.error.includes(OUTSIDE_WINDOW_CODE)) return sendAsTemplate();
          return textResult;
        }

        return sendAsTemplate();
      })
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