// src/app/api/prompt-plan/route.ts   (GET: load the latest saved plan for Home page)
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { corsHeaders } from '@/lib/cors';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { rowsOf } from '@/lib/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (d: unknown, status = 200) =>
  NextResponse.json(d, { status, headers: corsHeaders() });

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: NextRequest) {
  try {
    const userId = Number(await getUserIdFromRequest(req));
    if (!Number.isInteger(userId) || userId <= 0) return json({ error: 'unauthorized' }, 401);

    const plan = rowsOf(
      await db.execute(sql`
        SELECT id, month_number, start_date, end_date
        FROM customer_marketing_plans
        WHERE customer_id = ${userId}
        ORDER BY month_number DESC LIMIT 1
      `)
    )[0] as Record<string, any> | undefined;

    if (!plan) return json({ success: true, items: [], today: null, startDate: null });

    const rows = rowsOf(
      await db.execute(sql`
        SELECT day_number, topic_title, prompt, caption, scheduled_date
        FROM customer_marketing_days
        WHERE marketing_plan_id = ${Number(plan.id)}
        ORDER BY day_number
      `)
    ) as Record<string, any>[];

    const items = rows.map((r) => ({
      day: Number(r.day_number),
      theme: r.topic_title ?? null,
      prompt: String(r.prompt || r.caption || ''),
    }));

    const start = String(plan.start_date).slice(0, 10);
    const diff = Math.floor((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(start)) / 86400000);
    const today = items[Math.min(Math.max(diff, 0), items.length - 1)] ?? null;

    return json({
      success: true,
      planId: Number(plan.id),
      monthNumber: Number(plan.month_number),
      startDate: start,
      endDate: String(plan.end_date).slice(0, 10),
      items,
      today,
    });
  } catch (e: any) {
    if (e instanceof AuthError) return json({ error: e.message }, 401);
    console.error('GET /api/prompt-plan failed:', e);
    return json({ success: false, error: 'Could not load plan.' }, 500);
  }
}