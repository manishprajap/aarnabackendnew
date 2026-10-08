import { and, eq, lte, or, isNull, gte } from 'drizzle-orm';

import { db } from '@/db';
import { coupons, plans } from '@/db/schema';

export class CouponValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouponValidationError';
  }
}

export async function getValidCouponDiscount(
  planId: number,
  rawCode: unknown,
  now = new Date()
) {
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  if (!code) return { coupon: null, discountPaise: 0 };

  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.isActive, true)))
    .limit(1);
  if (!plan) throw new CouponValidationError('Plan is unavailable.');

  const [coupon] = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.code, code),
        eq(coupons.isActive, true),
        or(isNull(coupons.startsAt), lte(coupons.startsAt, now)),
        or(isNull(coupons.endsAt), gte(coupons.endsAt, now))
      )
    )
    .limit(1);
  if (!coupon) throw new CouponValidationError('Coupon is invalid, inactive, or expired.');

  const pricePaise = plan.price * 100;
  const requestedDiscount = coupon.discountType === 'percent'
    ? Math.floor((pricePaise * coupon.discountValue) / 100)
    : coupon.discountValue * 100;
  const discountPaise = Math.min(requestedDiscount, Math.max(0, pricePaise - 100));
  if (discountPaise <= 0) throw new CouponValidationError('Coupon is not applicable to this plan.');

  return { coupon, discountPaise, pricePaise, plan };
}
