import { asc } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/db';
import { coupons } from '@/db/schema';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

const couponSchema = z.object({
  code: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, underscores, or hyphens for coupon codes.'),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().int().min(1).max(1_000_000),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (coupon) => coupon.discountType !== 'percent' || coupon.discountValue <= 99,
  { message: 'Percentage discount cannot exceed 99%.' }
);

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const rows = await db.select().from(coupons).orderBy(asc(coupons.code));
    return NextResponse.json({ success: true, coupons: rows });
  } catch (error) {
    console.error('[Admin Coupons] Could not load coupons:', error);
    return NextResponse.json({ success: false, message: 'Could not load coupons.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  try {
    const parsed = couponSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: parsed.error.issues[0]?.message || 'Invalid coupon.' },
        { status: 400 }
      );
    }
    const coupon = parsed.data;
    if (coupon.startsAt && coupon.endsAt && new Date(coupon.startsAt) >= new Date(coupon.endsAt)) {
      return NextResponse.json({ success: false, message: 'Coupon end date must be after its start date.' }, { status: 400 });
    }
    const [result] = await db.insert(coupons).values({
      code: coupon.code.toUpperCase(),
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      startsAt: coupon.startsAt ? new Date(coupon.startsAt) : null,
      endsAt: coupon.endsAt ? new Date(coupon.endsAt) : null,
      isActive: coupon.isActive ?? true,
    });
    return NextResponse.json({ success: true, id: result.insertId }, { status: 201 });
  } catch (error) {
    console.error('[Admin Coupons] Could not create coupon:', error);
    return NextResponse.json({ success: false, message: 'Could not create coupon. The code may already exist.' }, { status: 500 });
  }
}
