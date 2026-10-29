// Shared helpers for /api/whatsapp/campaigns/* and /api/whatsapp/analytics (Drizzle + MySQL).
// NOTE: the actual sending logic lives in "@/lib/whatsappCampaignDispatch".
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  plans,
  subscriptions,
  whatsappConnections,
  whatsappCampaigns,
  whatsappCampaignRecipients,
} from "@/db/schema";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

export const GRAPH_URL = "https://graph.facebook.com/v20.0";

/** 10-digit numbers get this country code prefixed. Change/remove if you serve other countries. */
export const DEFAULT_COUNTRY_CODE = "91";

export const PLAN_LIMITS = {
  free: { monthlyLimit: 1000 as number | null, activeLimit: 1 as number | null },
  pro: { monthlyLimit: null as number | null, activeLimit: null as number | null },
};

export const ACTIVE_STATUSES = ["scheduled", "sending"] as const;

export type Campaign = typeof whatsappCampaigns.$inferSelect;

const PAID_PLAN_NAMES = new Set(["pro", "paid", "premium", "business", "enterprise"]);

type MetaTemplateResponse = {
  name?: string;
  language?: string;
  status?: string;
  components?: { type?: string; text?: string }[];
};

/* ------------------------------ responses ------------------------------ */

export const ok = (data: unknown, status = 200) =>
  NextResponse.json({ success: true, data }, { status });

export const fail = (message: string, status = 400) =>
  NextResponse.json({ success: false, message }, { status });

/* ------------------------------ helpers ------------------------------ */

export function isPaidSubscriptionPlan(name: string, price: number): boolean {
  return price > 0 || PAID_PLAN_NAMES.has(name.trim().toLowerCase());
}

export async function getPlan(userId: number): Promise<"free" | "pro"> {
  const [activeSubscription] = await db
    .select({ name: plans.name, price: plans.price })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
        gte(subscriptions.endDate, new Date()),
      ),
    )
    .orderBy(desc(subscriptions.endDate))
    .limit(1);

  if (!activeSubscription) return "free";
  return isPaidSubscriptionPlan(activeSubscription.name, activeSubscription.price)
    ? "pro"
    : "free";
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
    `${GRAPH_URL}/${encodeURIComponent(templateId)}?fields=name,language,status,components`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }
  );
  const body = (await res.json().catch(() => null)) as MetaTemplateResponse | null;
  if (!res.ok || typeof body?.name !== "string") return null;
  return {
    name: body.name,
    language: body.language ?? "en",
    status: body.status?.toUpperCase() ?? "",
    components: Array.isArray(body.components) ? body.components : [],
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
    customMessage: c.customMessage ?? null,
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

/* ------------------------------ dispatch ------------------------------ */

/**
 * Thin wrapper so any existing `import { dispatchCampaign } from "@/lib/whatsappCampaigns"`
 * keeps working. The real implementation (custom message + template fallback) lives in
 * "@/lib/whatsappCampaignDispatch". Imported lazily to avoid a circular import.
 */
export async function dispatchCampaign(campaignId: number): Promise<void> {
  const { dispatchCampaign: run } = await import("@/lib/whatsappCampaignDispatch");
  await run(campaignId);
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
  errorMessage?: string,
  eventDate = new Date()
): Promise<boolean> {
  const r = whatsappCampaignRecipients;
  const [rec] = await db.select().from(r).where(eq(r.waMessageId, waMessageId)).limit(1);
  if (!rec) return false;

  // Webhooks can arrive out of order — never downgrade (e.g. read -> delivered).
  const currentStatus = String(rec.status ?? "").toLowerCase();
  if (
    (status === "failed" && (currentStatus === "delivered" || currentStatus === "read")) ||
    (status !== "failed" &&
      RANK[currentStatus] !== undefined &&
      RANK[currentStatus] >= RANK[status])
  ) {
    return true;
  }

  await db
    .update(r)
    .set({
      status,
      errorMessage: status === "failed" ? (errorMessage ?? "Delivery failed").slice(0, 500) : null,
      ...(status === "sent" ? { sentAt: eventDate } : {}),
      ...(status === "delivered" ? { deliveredAt: eventDate } : {}),
      ...(status === "read"
        ? { readAt: eventDate, deliveredAt: rec.deliveredAt ?? eventDate }
        : {}),
    })
    .where(eq(r.id, rec.id));

  await refreshCounters(rec.campaignId);
  return true;
}