/**
 * File: src/app/api/whatsapp/leads/route.ts
 *
 * GET   /api/whatsapp/leads?stage=&source=&q=&limit=  -> the logged-in user's leads
 * PATCH /api/whatsapp/leads  { id, stage?, notes? }   -> update one of the user's leads
 *
 * Every query is scoped by the authenticated user's ID, so a user can never
 * read or change another user's leads.
 */

import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappLeads } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAGES = ['new', 'interested', 'follow_up', 'won', 'lost'] as const;

function json(origin: string | null, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

async function getUserId(req: NextRequest): Promise<number | null> {
  const userId = Number(await getUserIdFromRequest(req));
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await getUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    const params = new URL(req.url).searchParams;
    const stage = params.get('stage') ?? '';
    const source = (params.get('source') ?? '').trim().slice(0, 60);
    const q = (params.get('q') ?? '').trim().slice(0, 100);
    const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 20));

    const filters = [eq(whatsappLeads.userId, userId)];

    if ((STAGES as readonly string[]).includes(stage)) {
      filters.push(eq(whatsappLeads.stage, stage));
    }
    if (source) {
      filters.push(eq(whatsappLeads.source, source));
    }
    if (q) {
      const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
      const search = or(
        like(whatsappLeads.name, pattern),
        like(whatsappLeads.phoneNumber, pattern),
        like(whatsappLeads.firstMessage, pattern),
      );
      if (search) filters.push(search);
    }

    const where = and(...filters);
    const ownerOnly = eq(whatsappLeads.userId, userId);

    const [rows, [totalRow], stageRows, sourceRows] = await Promise.all([
      db
        .select()
        .from(whatsappLeads)
        .where(where)
        .orderBy(desc(whatsappLeads.lastMessageAt), desc(whatsappLeads.id))
        .limit(limit),
      db
        .select({ count: sql<number>`count(*)` })
        .from(whatsappLeads)
        .where(where),
      db
        .select({ stage: whatsappLeads.stage, count: sql<number>`count(*)` })
        .from(whatsappLeads)
        .where(ownerOnly)
        .groupBy(whatsappLeads.stage),
      db
        .selectDistinct({ source: whatsappLeads.source })
        .from(whatsappLeads)
        .where(ownerOnly),
    ]);

    const counts: Record<string, number> = { all: 0 };
    for (const stageName of STAGES) counts[stageName] = 0;
    for (const row of stageRows) {
      const count = Number(row.count) || 0;
      counts[row.stage] = count;
      counts.all += count;
    }

    return json(origin, {
      success: true,
      leads: rows,
      total: Number(totalRow?.count) || 0,
      counts,
      sources: sourceRows.map((row) => row.source).filter(Boolean),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(origin, { success: false, message: error.message }, 401);
    }

    console.error('[WhatsApp Leads GET] Failed to load leads:', error);
    return json(origin, { success: false, message: 'Could not load leads.' }, 500);
  }
}

export async function PATCH(req: NextRequest) {
  const origin = req.headers.get('origin');

  try {
    const userId = await getUserId(req);
    if (!userId) return json(origin, { success: false, message: 'Unauthorized' }, 401);

    let body: { id?: unknown; stage?: unknown; notes?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(origin, { success: false, message: 'Invalid JSON request body.' }, 400);
    }

    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return json(origin, { success: false, message: 'A valid lead id is required.' }, 400);
    }

    const updates: { stage?: string; notes?: string | null } = {};

    if (body.stage !== undefined) {
      if (typeof body.stage !== 'string' || !(STAGES as readonly string[]).includes(body.stage)) {
        return json(origin, { success: false, message: 'Invalid lead stage.' }, 400);
      }
      updates.stage = body.stage;
    }

    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string' || body.notes.length > 2000) {
        return json(
          origin,
          { success: false, message: 'Notes must be text up to 2,000 characters.' },
          400,
        );
      }
      updates.notes = body.notes.trim() || null;
    }

    if (Object.keys(updates).length === 0) {
      return json(origin, { success: false, message: 'Nothing to update.' }, 400);
    }

    const ownLead = and(eq(whatsappLeads.id, id), eq(whatsappLeads.userId, userId));

    const [existing] = await db
      .select({ id: whatsappLeads.id })
      .from(whatsappLeads)
      .where(ownLead)
      .limit(1);

    if (!existing) {
      return json(origin, { success: false, message: 'Lead not found.' }, 404);
    }

    await db.update(whatsappLeads).set(updates).where(ownLead);

    const [lead] = await db.select().from(whatsappLeads).where(ownLead).limit(1);

    return json(origin, { success: true, lead });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(origin, { success: false, message: error.message }, 401);
    }

    console.error('[WhatsApp Leads PATCH] Failed to update lead:', error);
    return json(origin, { success: false, message: 'Could not update the lead.' }, 500);
  }
}