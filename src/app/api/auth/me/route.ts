// src/app/api/auth/me/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq, and, desc, gte } from 'drizzle-orm';
import { db } from '@/db';
import { users, subscriptions, plans } from '@/db/schema';
import { verifyToken } from '@/lib/auth';
import { getSubscriptionAccess } from '@/lib/subscriptionAccess';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function OPTIONS() {
  // CORS headers middleware.ts se globally lagte hain (matcher: /api/:path*),
  // isliye yahan corsHeaders() dobara set nahi karna.
  return new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    const bearer = req.headers
      .get('authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim();
    const token = bearer || req.cookies.get('token')?.value;

    if (!token) {
      return json({ error: 'Not authenticated' }, 401);
    }

    let payload: ReturnType<typeof verifyToken> = null;
    try {
      payload = verifyToken(token);
    } catch {
      payload = null;
    }

    if (!payload) {
      return json({ error: 'Session expired' }, 401);
    }

    const [row] = await db
      .select({
        id: users.id,
        name: users.name,
        mobile: users.mobile,
        email: users.email,
        plan: users.plan,
        credits: users.credits,
        businessName: users.businessName,
        category: users.business_category,
        businessCategoryId: users.businessCategoryId,
        city: users.city,
        website: users.website,
        language: users.language,
        logo: users.logo,
      })
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (!row) {
      return json({ error: 'Not authenticated' }, 401);
    }

    const [activeSub] = await db
      .select({
        id: subscriptions.id,
        endDate: subscriptions.endDate,
        startDate: subscriptions.startDate,
        planName: plans.name,
        monthlyLimit: plans.posters,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(
        and(
          eq(subscriptions.userId, row.id),
          eq(subscriptions.status, 'active'),
          gte(subscriptions.endDate, new Date())
        )
      )
      .orderBy(desc(subscriptions.endDate))
      .limit(1);

    // Same rule as GET /api/business
    const hasBusiness = Boolean(row.businessName && row.businessCategoryId);
    const hasSubscription = Boolean(activeSub);
    const subscriptionAccess = hasSubscription
      ? await getSubscriptionAccess(row.id)
      : null;
    const daysRemaining = activeSub?.endDate
      ? Math.max(0, Math.ceil((activeSub.endDate.getTime() - Date.now()) / 86_400_000))
      : null;

    return json({
      user: row,
      hasBusiness,
      hasSubscription,
      subscription: activeSub
        ? {
            planName: activeSub.planName,
            startDate: activeSub.startDate,
            endDate: activeSub.endDate,
            daysRemaining,
            monthlyLimit: activeSub.monthlyLimit,
            used: subscriptionAccess?.allowed ? subscriptionAccess.used : subscriptionAccess?.used ?? 0,
            remaining: subscriptionAccess?.allowed ? subscriptionAccess.remaining : 0,
          }
        : null,
    });
  } catch (error) {
    console.error('[auth/me] Unexpected error:', error);
    return json({ error: 'Server error' }, 500);
  }
}