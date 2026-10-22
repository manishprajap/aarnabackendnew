import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  whatsappMessages,
  whatsappCampaigns,
  whatsappCampaignRecipients,
  whatsappProducts,
} from "@/db/schema";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/auth";
import { ok, fail, getPlan } from "@/lib/whatsappCampaigns";

export const dynamic = "force-dynamic";

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const INBOUND = new Set(["inbound", "incoming", "in"]); // adjust if your webhook stores something else

/* GET /api/whatsapp/analytics?days=N
   Basic stats for everyone; the `advanced` block is only returned for paid plans. */
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return fail("Unauthorized", 401);

    const raw = Number(new URL(request.url).searchParams.get("days") ?? 7);
    const days = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 365) : 7;

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    const daily = new Map<string, { date: string; sent: number; received: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      daily.set(dayKey(d), { date: dayKey(d), sent: 0, received: 0 });
    }

    let sent = 0,
      received = 0,
      delivered = 0,
      read = 0,
      failed = 0;
    const conversations = new Set<number>();

    /* ---------- 1) inbox / chat messages ---------- */
    const m = whatsappMessages;
    const messages = await db
      .select({
        direction: m.direction,
        status: m.status,
        createdAt: m.createdAt,
        conversationId: m.conversationId,
        productId: m.productId,
      })
      .from(m)
      .where(and(eq(m.userId, userId), gte(m.createdAt, since)));

    for (const msg of messages) {
      const bucket = daily.get(dayKey(msg.createdAt));
      conversations.add(msg.conversationId);

      if (INBOUND.has(String(msg.direction).toLowerCase())) {
        received++;
        if (bucket) bucket.received++;
        continue;
      }
      sent++;
      if (bucket) bucket.sent++;
      if (msg.status === "failed") failed++;
      if (msg.status === "delivered" || msg.status === "read") delivered++;
      if (msg.status === "read") read++;
    }

    /* ---------- 2) campaign messages (kept in their own table) ---------- */
    const r = whatsappCampaignRecipients;
    const c = whatsappCampaigns;
    const campaignRows = await db
      .select({
        status: r.status,
        sentAt: r.sentAt,
        updatedAt: r.updatedAt,
        templateName: c.templateName,
      })
      .from(r)
      .innerJoin(c, eq(r.campaignId, c.id))
      .where(
        and(
          eq(c.userId, userId),
          ne(r.status, "pending"),
          ne(r.status, "cancelled"),
          gte(sql`COALESCE(${r.sentAt}, ${r.updatedAt})`, since)
        )
      );

    for (const row of campaignRows) {
      const bucket = daily.get(dayKey(row.sentAt ?? row.updatedAt));
      sent++;
      if (bucket) bucket.sent++;
      if (row.status === "failed") failed++;
      if (row.status === "delivered" || row.status === "read") delivered++;
      if (row.status === "read") read++;
    }

    const summary: Record<string, unknown> = {
      days,
      sent,
      received,
      delivered,
      read,
      failed,
      activeConversations: conversations.size,
      daily: Array.from(daily.values()),
    };

    /* ---------- paid-only block ---------- */
    if ((await getPlan(userId)) !== "free") {
      // Top templates (from campaigns): sends + read rate
      const tpl = new Map<string, { sent: number; read: number }>();
      for (const row of campaignRows) {
        if (row.status === "failed") continue;
        const t = tpl.get(row.templateName) ?? { sent: 0, read: 0 };
        t.sent++;
        if (row.status === "read") t.read++;
        tpl.set(row.templateName, t);
      }
      const topTemplates = [...tpl.entries()]
        .map(([name, t]) => ({
          name,
          sent: t.sent,
          readRate: t.sent ? Math.round((t.read / t.sent) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.sent - a.sent)
        .slice(0, 5);

      // Campaign performance in range
      const campaigns = await db
        .select({
          id: c.id,
          name: c.name,
          sent: c.sent,
          delivered: c.delivered,
          read: c.read,
          failed: c.failed,
        })
        .from(c)
        .where(and(eq(c.userId, userId), gte(c.createdAt, since)))
        .orderBy(desc(c.createdAt))
        .limit(20);

      // Average first-response time: customer message -> next reply in the same conversation
      const byConv = new Map<number, typeof messages>();
      for (const msg of messages) {
        const list = byConv.get(msg.conversationId) ?? [];
        list.push(msg);
        byConv.set(msg.conversationId, list);
      }
      const gaps: number[] = [];
      for (const list of byConv.values()) {
        list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        let waitingSince: number | null = null;
        for (const msg of list) {
          if (INBOUND.has(String(msg.direction).toLowerCase())) {
            if (waitingSince === null) waitingSince = msg.createdAt.getTime();
          } else if (waitingSince !== null) {
            gaps.push((msg.createdAt.getTime() - waitingSince) / 60000);
            waitingSince = null;
          }
        }
      }
      const avgResponseMinutes = gaps.length
        ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10
        : null;

      // Top shared products: outbound messages that carried a catalog product
      const shareCounts = new Map<number, number>();
      for (const msg of messages) {
        if (msg.productId && !INBOUND.has(String(msg.direction).toLowerCase())) {
          shareCounts.set(msg.productId, (shareCounts.get(msg.productId) ?? 0) + 1);
        }
      }
      let topProducts: { name: string; shares: number }[] = [];
      if (shareCounts.size > 0) {
        const products = await db
          .select({ id: whatsappProducts.id, name: whatsappProducts.name })
          .from(whatsappProducts)
          .where(inArray(whatsappProducts.id, [...shareCounts.keys()]));
        topProducts = products
          .map((p) => ({ name: p.name, shares: shareCounts.get(p.id) ?? 0 }))
          .sort((a, b) => b.shares - a.shares)
          .slice(0, 5);
      }

      summary.advanced = { avgResponseMinutes, topTemplates, campaigns, topProducts };
    }

    return ok(summary);
  } catch (error) {
    console.error("[WhatsApp Analytics GET]", error);
    return fail("Failed to load analytics", 500);
  }
}