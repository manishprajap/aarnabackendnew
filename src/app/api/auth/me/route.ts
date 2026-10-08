// src/app/api/auth/me/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq, and, gt, desc } from 'drizzle-orm';
import { db } from '@/db';
import { users, subscriptions } from '@/db/schema';
import { verifyToken } from '@/lib/auth';

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
        businessCategoryId: users.businessCategoryId,
        city: users.city,
      })
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (!row) {
      return json({ error: 'Not authenticated' }, 401);
    }

    const [activeSub] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, row.id),
          eq(subscriptions.status, 'active'),
          gt(subscriptions.endDate, new Date())
        )
      )
      .orderBy(desc(subscriptions.endDate))
      .limit(1);

    // Same rule as GET /api/business
    const hasBusiness = Boolean(row.businessName && row.businessCategoryId);
    const hasSubscription = Boolean(activeSub);

    return json({
      user: row,
      hasBusiness,
      hasSubscription,
    });
  } catch (error) {
    console.error('[auth/me] Unexpected error:', error);
    return json({ error: 'Server error' }, 500);
  }
}