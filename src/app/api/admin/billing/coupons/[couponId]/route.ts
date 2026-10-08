import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { coupons } from '@/db/schema';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

const updateSchema = z.object({
  code: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  discountType: z.enum(['percent', 'fixed']).optional(),
  discountValue: z.number().int().min(1).max(1_000_000).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (coupon) => coupon.discountType !== 'percent' || coupon.discountValue === undefined || coupon.discountValue <= 99,
  { message: 'Percentage discount cannot exceed 99%.' }
);

type RouteContext = { params: Promise<{ couponId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const couponId = Number((await context.params).couponId);
    if (!Number.isInteger(couponId) || couponId <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid coupon ID.' }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || Object.keys(parsed.data || {}).length === 0) {
      return NextResponse.json(
        { success: false, message: parsed.success ? 'No coupon changes supplied.' : parsed.error.issues[0]?.message },
        { status: 400 }
      );
    }
    const changes: Partial<typeof coupons.$inferInsert> = {
      ...(parsed.data.code ? { code: parsed.data.code.toUpperCase() } : {}),
      ...(parsed.data.discountType ? { discountType: parsed.data.discountType } : {}),
      ...(parsed.data.discountValue !== undefined ? { discountValue: parsed.data.discountValue } : {}),
      ...(parsed.data.startsAt !== undefined ? { startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null } : {}),
      ...(parsed.data.endsAt !== undefined ? { endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null } : {}),
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    };
    if (changes.startsAt && changes.endsAt && changes.startsAt >= changes.endsAt) {
      return NextResponse.json({ success: false, message: 'Coupon end date must be after its start date.' }, { status: 400 });
    }
    await db.update(coupons).set(changes).where(eq(coupons.id, couponId));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Admin Coupons] Could not update coupon:', error);
    return NextResponse.json({ success: false, message: 'Could not update coupon.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const couponId = Number((await context.params).couponId);
    if (!Number.isInteger(couponId) || couponId <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid coupon ID.' }, { status: 400 });
    }
    await db.delete(coupons).where(eq(coupons.id, couponId));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Admin Coupons] Could not delete coupon:', error);
    return NextResponse.json({ success: false, message: 'Could not delete coupon.' }, { status: 500 });
  }
}
