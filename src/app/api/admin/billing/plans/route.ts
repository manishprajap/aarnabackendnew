import { asc } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { plans } from '@/db/schema';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

const planSchema = z.object({
  name: z.string().trim().min(2).max(100),
  price: z.number().int().min(1).max(10_000_000),
  posters: z.number().int().min(1).max(1_000_000),
  durationDays: z.number().int().min(1).max(3650),
  features: z.array(z.string().trim().min(1).max(250)).max(30),
});

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const rows = await db.select().from(plans).orderBy(asc(plans.price));
    return NextResponse.json({ success: true, plans: rows });
  } catch (error) {
    console.error('[Admin Plans] Could not load plans:', error);
    return NextResponse.json({ success: false, message: 'Could not load plans.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const parsed = planSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: parsed.error.issues[0]?.message || 'Invalid plan.' },
        { status: 400 }
      );
    }
    const [result] = await db.insert(plans).values({
      ...parsed.data,
      features: parsed.data.features.join('\n'),
      isActive: true,
    });
    return NextResponse.json({ success: true, id: result.insertId }, { status: 201 });
  } catch (error) {
    console.error('[Admin Plans] Could not create plan:', error);
    return NextResponse.json({ success: false, message: 'Could not create plan.' }, { status: 500 });
  }
}
