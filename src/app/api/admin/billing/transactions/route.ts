import { count, desc, eq, sql } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import { coupons, plans, transactions, users } from '@/db/schema';
import { adminUnauthorized, isAdminRequest } from '@/lib/adminApi';

const statuses = ['all', 'created', 'paid', 'failed'] as const;

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) return adminUnauthorized();

  const params = request.nextUrl.searchParams;
  const rawPage = Number(params.get('page') || 1);
  const rawLimit = Number(params.get('limit') || 20);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
  const requestedStatus = params.get('status') || 'all';

  if (!statuses.includes(requestedStatus as (typeof statuses)[number])) {
    return NextResponse.json({ success: false, message: 'Invalid transaction status.' }, { status: 400 });
  }

  const filter = requestedStatus === 'all'
    ? undefined
    : eq(transactions.status, requestedStatus as Exclude<(typeof statuses)[number], 'all'>);

  try {
    const [rows, [totalRow], [totals]] = await Promise.all([
      db
        .select({
          id: transactions.id,
          userId: transactions.userId,
          customerName: users.name,
          customerMobile: users.mobile,
          customerEmail: users.email,
          businessName: users.businessName,
          planName: plans.name,
          amount: transactions.amount,
          currency: transactions.currency,
          status: transactions.status,
          method: transactions.method,
          orderId: transactions.razorpayOrderId,
          paymentId: transactions.razorpayPaymentId,
          couponCode: coupons.code,
          discountAmount: transactions.discountAmount,
          createdAt: transactions.createdAt,
        })
        .from(transactions)
        .innerJoin(users, eq(transactions.userId, users.id))
        .innerJoin(plans, eq(transactions.planId, plans.id))
        .leftJoin(coupons, eq(transactions.couponId, coupons.id))
        .where(filter)
        .orderBy(desc(transactions.createdAt), desc(transactions.id))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(transactions).where(filter),
      db.select({
        paidCount: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.status} = 'paid' THEN 1 ELSE 0 END), 0)`,
        paidAmount: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.status} = 'paid' THEN ${transactions.amount} ELSE 0 END), 0)`,
      }).from(transactions),
    ]);

    const total = Number(totalRow?.total || 0);
    return NextResponse.json({
      success: true,
      transactions: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      summary: {
        paidCount: Number(totals?.paidCount || 0),
        paidAmount: Number(totals?.paidAmount || 0),
      },
    });
  } catch (error) {
    console.error('[Admin Transactions] Could not load transactions:', error);
    return NextResponse.json({ success: false, message: 'Could not load transactions.' }, { status: 500 });
  }
}
