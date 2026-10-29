/**
 * lib/whatsappCampaignDispatch.ts
 *
 * Sends a campaign to every pending recipient.
 *
 * - If the campaign has a `customMessage` AND the recipient messaged this business
 *   in the last 24 hours -> free-text message (inside WhatsApp's customer service window).
 * - Otherwise (or if free-text is rejected as outside the window) -> approved template.
 *
 * {{name}} works in both the custom message and in template parameters.
 * Counters are always recomputed with refreshCounters() so they stay consistent with
 * the webhook (delivered / read updates).
 */
import { db } from "@/db";
import {
  whatsappCampaigns,
  whatsappCampaignRecipients,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
} from "@/db/schema";
import { and, eq, inArray, max } from "drizzle-orm";
import {
  GRAPH_URL,
  getActiveConnection,
  getAccessToken,
  refreshCounters,
} from "@/lib/whatsappCampaigns";

const CONCURRENCY = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Meta error 131047 = "re-engagement message": free-text attempted outside the 24h window.
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
    const res = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
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
    });

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

/** Returns the phone numbers that sent this business a message within the last 24 hours. */
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
  const c = whatsappCampaigns;
  const r = whatsappCampaignRecipients;

  const [campaign] = await db.select().from(c).where(eq(c.id, campaignId)).limit(1);
  if (!campaign) return;
  if (campaign.status !== "sending" && campaign.status !== "scheduled") return;

  await db
    .update(c)
    .set({ status: "sending", startedAt: campaign.startedAt ?? new Date() })
    .where(eq(c.id, campaignId));

  const conn: any = await getActiveConnection(campaign.userId);
  if (!conn) {
    await db.update(c).set({ status: "failed" }).where(eq(c.id, campaignId));
    return;
  }

  const accessToken = getAccessToken(conn.accessToken);
  const parameters: string[] = Array.isArray(campaign.parameters)
    ? (campaign.parameters as string[])
    : [];
  const customMessage = (campaign.customMessage ?? "").trim();

  while (true) {
    // Stop if the user cancelled while we were sending
    const [current] = await db
      .select({ status: c.status })
      .from(c)
      .where(eq(c.id, campaignId))
      .limit(1);
    if (!current || current.status !== "sending") return;

    const batch = await db
      .select()
      .from(r)
      .where(and(eq(r.campaignId, campaignId), eq(r.status, "pending")))
      .limit(CONCURRENCY);

    if (batch.length === 0) break;

    const insideWindow = customMessage
      ? await getRecipientsInsideWindow(
          campaign.userId,
          batch.map((rec) => rec.phoneNumber)
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

          // Window was actually closed -> fall back to the approved template.
          if (textResult.error.includes(OUTSIDE_WINDOW_CODE)) return sendAsTemplate();
          return textResult;
        }

        return sendAsTemplate();
      })
    );

    for (let i = 0; i < batch.length; i++) {
      const result = results[i];
      if (result.ok) {
        await db
          .update(r)
          .set({
            status: "sent",
            waMessageId: result.messageId,
            errorMessage: null,
            sentAt: new Date(),
          })
          .where(eq(r.id, batch[i].id));
      } else {
        await db
          .update(r)
          .set({ status: "failed", errorMessage: result.error })
          .where(eq(r.id, batch[i].id));
      }
    }

    await refreshCounters(campaignId);
    await sleep(250); // gentle pacing to stay within Meta rate limits
  }

  await refreshCounters(campaignId);
  const [fin] = await db
    .select({ sent: c.sent, failed: c.failed })
    .from(c)
    .where(eq(c.id, campaignId))
    .limit(1);

  await db
    .update(c)
    .set({
      status: fin && fin.sent === 0 && fin.failed > 0 ? "failed" : "completed",
      completedAt: new Date(),
    })
    .where(and(eq(c.id, campaignId), eq(c.status, "sending")));
}