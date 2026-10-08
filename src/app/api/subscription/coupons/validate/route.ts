import { NextRequest, NextResponse } from 'next/server';

import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { CouponValidationError, getValidCouponDiscount } from '@/lib/coupons';
import { corsHeaders } from '@/lib/cors';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: NextRequest) {
  try {
    getUserIdFromRequest(request);
    const body = await request.json().catch(() => null);
    const planId = Number(body?.planId);
    if (!Number.isInteger(planId) || planId <= 0 || typeof body?.code !== 'string') {
      return json({ success: false, message: 'Choose a plan and enter a coupon code.' }, 400);
    }

    const result = await getValidCouponDiscount(planId, body.code);
    return json({
      success: true,
      code: result.coupon?.code,
      discountType: result.coupon?.discountType,
      discountValue: result.coupon?.discountValue,
      originalAmount: result.pricePaise,
      discountAmount: result.discountPaise,
      payableAmount: result.pricePaise! - result.discountPaise,
    });
  } catch (error) {
    if (error instanceof AuthError) return json({ success: false, message: error.message }, 401);
    if (error instanceof CouponValidationError) {
      return json({ success: false, message: error.message }, 400);
    }
    console.error('COUPON VALIDATION ERROR:', error);
    return json({ success: false, message: 'Could not validate coupon.' }, 500);
  }
}
