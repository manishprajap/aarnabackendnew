import { NextResponse } from 'next/server';
import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';

import { db } from '@/db';
import { coupons, plans } from '@/db/schema';

export async function GET() {
  try {
    const now = new Date();
    const activePlans = await db
      .select()
      .from(plans)
      .where(eq(plans.isActive, true))
      .orderBy(asc(plans.price));
    const activeCoupons = await db
      .select({
        discountType: coupons.discountType,
        discountValue: coupons.discountValue,
      })
      .from(coupons)
      .where(and(
        eq(coupons.isActive, true),
        or(isNull(coupons.startsAt), lte(coupons.startsAt, now)),
        or(isNull(coupons.endsAt), gte(coupons.endsAt, now)),
      ));

    return NextResponse.json({
      success: true,
      plans: activePlans.map((plan) => ({
        ...plan,
        hasAvailableCoupons: activeCoupons.some((coupon) => {
          const planAmountPaise = plan.price * 100;
          const discountPaise = coupon.discountType === 'percent'
            ? Math.floor((planAmountPaise * coupon.discountValue) / 100)
            : coupon.discountValue * 100;
          return Math.min(discountPaise, Math.max(0, planAmountPaise - 100)) > 0;
        }),
        features: plan.features
          ? plan.features.split('\n').map((feature) => feature.trim()).filter(Boolean)
          : [],
      })),
    });
  } catch (error) {
    console.error('[Subscription Plans] Could not load plans:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load subscription plans.' },
      { status: 500 }
    );
  }
}
