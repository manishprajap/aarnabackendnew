// Shared helpers for /api/whatsapp/campaigns/* and /api/whatsapp/analytics (Drizzle + MySQL).
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  users,
  whatsappConnections,
  whatsappCampaigns,
  whatsappCampaignRecipients,
} from "@/db/schema";
import { and, eq, inArray, lte, ne, sql, gte } from "drizzle-orm";

export const GRAPH_URL = "https://graph.facebook.com/v20.0";

/** 10-digit numbers get this country code prefixed. Change/remove if you serve other countries. */
export const DEFAULT_COUNTRY_CODE = "91";

export const PLAN_LIMITS = {
  free: { monthlyLimit: 1000 as number | null, activeLimit: 1 as number | null },
  pro: { monthlyLimit: null as number | null, activeLimit: null as number | null },
};

export const ACTIVE_STATUSES = ["scheduled", "sending"] as const;

export type Campaign = typeof whatsappCampaigns.$inferSelect;

/* ------------------------------ responses ------------------------------ */

export const ok = (data: unknown, status = 200) =>
  NextResponse.json({ success: true, data }, { status });

export const fail = (message: string, status = 400) =>
  NextResponse.json({ success: false, message }, { status });

/* ------------------------------ helpers ------------------------------ */

export async function getPlan(userId: number): Promise<"free" | "pro"> {
  const [user] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return String(user?.plan ?? "free").toLowerCase() === "free" ? "free" : "pro";
}

export function normalizePhone(raw: unknown): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) digits = DEFAULT_COUNTRY_CODE + digits;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

export function monthStart(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export async function getActiveConnection(userId: number) {
  const [conn] = await db
    .select()
    .from(whatsappConnections)
    .where(and(eq(whatsappConnections.userId, userId), eq(whatsappConnections.status, "active")))
    .limit(1);
  return conn ?? null;
}

/** If you store whatsapp_connections.access_token encrypted, decrypt it here. */
export function getAccessToken(stored: string): string {
  return stored;
}

/** Templates live in Meta. Returns null if it doesn't exist / can't be read. */
export async function fetchTemplate(templateId: string, accessToken: string) {
  const res = await fetch(
    `${GRAPH_URL}/${encodeURIComponent(templateId)}?fields=name,language,status`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }
  );
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.name) return null;
  return {
    name: String(body.name),
    language: String(body.language ?? "en"),
    status: String(body.status ?? "").toUpperCase(),
  };
}

export async function computeQuota(userId: number) {
  const plan = await getPlan(userId);
  const limits = PLAN_LIMITS[plan];
  const c = whatsappCampaigns;

  const [usedRow] = await db
    .select({
      used: sql<number>`COALESCE(SUM(CASE WHEN ${c.status} = 'cancelled' THEN ${c.sent} ELSE ${c.total} END), 0)`,
    })
    .from(c)
    .where(and(eq(c.userId, userId), gte(c.createdAt, monthStart())));

  const [activeRow] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(c)
    .where(and(eq(c.userId, userId), inArray(c.status, [...ACTIVE_STATUSES])));

  return {
    plan,
    monthlyLimit: limits.monthlyLimit,
    usedThisMonth: Number(usedRow?.used ?? 0),
    activeLimit: limits.activeLimit,
    activeCount: Number(activeRow?.n ?? 0),
  };
}

export function serializeCampaign(c: Campaign) {
  return {
    id: c.id,
    name: c.name,
    templateId: c.templateId,
    templateName: c.templateName,
    status: c.status,
    total: c.total,
    sent: c.sent,
    delivered: c.delivered,
    read: c.read,
    failed: c.failed,
    scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Recompute the denormalised counters on the campaign from its recipient rows. */
export async function refreshCounters(campaignId: number) {
  const r = whatsappCampaignRecipients;
  const rows = await db
    .select({ status: r.status, n: sql<number>`COUNT(*)` })
    .from(r)
    .where(eq(r.campaignId, campaignId))
    .groupBy(r.status);

  const n = (s: string) => Number(rows.find((x) => x.status === s)?.n ?? 0);
  const read = n("read");
  const delivered = n("delivered") + read; // delivered is cumulative (includes read)
  const sent = n("sent") + delivered; // sent is cumulative (includes delivered + read)

  await db
    .update(whatsappCampaigns)
    .set({ sent, delivered, read, failed: n("failed") })
    .where(eq(whatsappCampaigns.id, campaignId));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ dispatch ------------------------------ */
export async function dispatchCampaign(campaignId: number) {
  const c = whatsappCampaigns;
  const r = whatsappCampaignRecipients;

  const [campaign] = await db.select().from(c).where(eq(c.id, campaignId)).limit(1);
  if (!campaign || campaign.status === "cancelled") return;

  const conn = await getActiveConnection(campaign.userId);
  if (!conn) {
    await db.update(c).set({ status: "failed" }).where(eq(c.id, campaignId));
    return;
  }
  const accessToken = getAccessToken(conn.accessToken);

  await db
    .update(c)
    .set({ status: "sending", startedAt: campaign.startedAt ?? new Date() })
    .where(and(eq(c.id, campaignId), ne(c.status, "cancelled")));

  const parameters = campaign.parameters ?? [];
  const BATCH = 20;

  while (true) {
    // Stop if cancelled (or otherwise moved out of 'sending') mid-flight
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
      .limit(BATCH);
    if (batch.length === 0) break;

    await Promise.all(
      batch.map(async (rec) => {
        try {
          const res = await fetch(`${GRAPH_URL}/${conn.phoneNumberId}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: rec.phoneNumber,
              type: "template",
              template: {
                name: campaign.templateName,
                language: { code: campaign.templateLanguage },
                components: parameters.length
                  ? [
                      {
                        type: "body",
                        parameters: parameters.map((text) => ({ type: "text", text })),
                      },
                    ]
                  : [],
              },
            }),
          });
          const body: any = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);

          await db
            .update(r)
            .set({
              status: "sent",
              waMessageId: body?.messages?.[0]?.id ?? null,
              errorMessage: null,
              sentAt: new Date(),
            })
            .where(eq(r.id, rec.id));
        } catch (err: any) {
          await db
            .update(r)
            .set({ status: "failed", errorMessage: String(err?.message ?? err).slice(0, 500) })
            .where(eq(r.id, rec.id));
        }
      })
    );

    await refreshCounters(campaignId);
    await sleep(1000); // gentle rate limiting
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

/** Picks up scheduled campaigns whose time has come. Used by the cron route. */
export async function dispatchDueCampaigns() {
  const c = whatsappCampaigns;
  const due = await db
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.status, "scheduled"), lte(c.scheduledAt, new Date())))
    .limit(20);

  let started = 0;
  for (const { id } of due) {
    // Atomic claim so two cron runs can't dispatch the same campaign
    const [res] = await db
      .update(c)
      .set({ status: "sending" })
      .where(and(eq(c.id, id), eq(c.status, "scheduled")));
    if ((res as any).affectedRows === 1) {
      started++;
      await dispatchCampaign(id);
    }
  }
  return started;
}

/* ------------------------------ webhook hook ------------------------------ */

const RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
export async function applyDeliveryStatus(
  waMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  errorMessage?: string
) {
  const r = whatsappCampaignRecipients;
  const [rec] = await db.select().from(r).where(eq(r.waMessageId, waMessageId)).limit(1);
  if (!rec) return;

  // Webhooks can arrive out of order — never downgrade (e.g. read -> delivered).
  if (status !== "failed" && (RANK[rec.status] ?? 0) >= RANK[status]) return;

  const now = new Date();
  await db
    .update(r)
    .set({
      status,
      errorMessage: status === "failed" ? (errorMessage ?? "Delivery failed").slice(0, 500) : null,
      ...(status === "delivered" ? { deliveredAt: now } : {}),
      ...(status === "read" ? { readAt: now, deliveredAt: rec.deliveredAt ?? now } : {}),
    })
    .where(eq(r.id, rec.id));

  await refreshCounters(rec.campaignId);
}