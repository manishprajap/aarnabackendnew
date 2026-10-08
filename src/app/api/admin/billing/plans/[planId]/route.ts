import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { plans } from '@/db/schema';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  price: z.number().int().min(1).max(10_000_000).optional(),
  posters: z.number().int().min(1).max(1_000_000).optional(),
  durationDays: z.number().int().min(1).max(3650).optional(),
  features: z.array(z.string().trim().min(1).max(250)).max(30).optional(),
  isActive: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ planId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const planId = Number((await context.params).planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid plan ID.' }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || Object.keys(parsed.data || {}).length === 0) {
      return NextResponse.json(
        { success: false, message: parsed.success ? 'No plan changes supplied.' : parsed.error.issues[0]?.message },
        { status: 400 }
      );
    }
    const changes: Partial<typeof plans.$inferInsert> = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.price !== undefined ? { price: parsed.data.price } : {}),
      ...(parsed.data.posters !== undefined ? { posters: parsed.data.posters } : {}),
      ...(parsed.data.durationDays !== undefined ? { durationDays: parsed.data.durationDays } : {}),
      ...(parsed.data.features !== undefined ? { features: parsed.data.features.join('\n') } : {}),
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    };
    await db.update(plans).set(changes).where(eq(plans.id, planId));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Admin Plans] Could not update plan:', error);
    return NextResponse.json({ success: false, message: 'Could not update plan.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const planId = Number((await context.params).planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid plan ID.' }, { status: 400 });
    }
    await db.update(plans).set({ isActive: false }).where(eq(plans.id, planId));
    return NextResponse.json({ success: true, message: 'Plan hidden from new subscriptions.' });
  } catch (error) {
    console.error('[Admin Plans] Could not archive plan:', error);
    return NextResponse.json({ success: false, message: 'Could not archive plan.' }, { status: 500 });
  }
}
