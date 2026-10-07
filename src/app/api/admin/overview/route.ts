import { count, eq, sql } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import { banners, products, subscriptions, transactions, users } from '@/db/schema';
import { hasValidAdminSession, SESSION_COOKIE_NAME } from '@/lib/adminAuth';

export async function GET(request: NextRequest) {
  if (!hasValidAdminSession(request.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return NextResponse.json(
      { success: false, message: 'Admin session expired. Please sign in again.' },
      { status: 401 }
    );
  }

  try {
    const [
      [vendorCount],
      [activeVendors],
      [suspendedVendors],
      [productCount],
      [bannerCount],
      [subscriptionCount],
      [revenue],
    ] = await Promise.all([
      db.select({ total: count() }).from(users),
      db.select({ total: count() }).from(users).where(eq(users.status, 'ACTIVE')),
      db.select({ total: count() }).from(users).where(eq(users.status, 'SUSPENDED')),
      db.select({ total: count() }).from(products),
      db.select({ total: count() }).from(banners),
      db.select({ total: count() }).from(subscriptions),
      db
        .select({
          amount: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.status} = 'paid' THEN ${transactions.amount} ELSE 0 END), 0)`,
          paidCount: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.status} = 'paid' THEN 1 ELSE 0 END), 0)`,
        })
        .from(transactions),
    ]);

    return NextResponse.json({
      success: true,
      overview: {
        vendors: Number(vendorCount?.total || 0),
        activeVendors: Number(activeVendors?.total || 0),
        suspendedVendors: Number(suspendedVendors?.total || 0),
        products: Number(productCount?.total || 0),
        banners: Number(bannerCount?.total || 0),
        subscriptions: Number(subscriptionCount?.total || 0),
        paidTransactions: Number(revenue?.paidCount || 0),
        grossRevenuePaise: Number(revenue?.amount || 0),
      },
    });
  } catch (error) {
    console.error('[Admin Overview] Could not load dashboard metrics:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load admin dashboard metrics.' },
      { status: 500 }
    );
  }
}
