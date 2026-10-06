// src/app/api/auth/me/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq, and, gt, desc } from 'drizzle-orm';
import { db } from '@/db';
import { users, subscriptions } from '@/db/schema';
import { verifyToken } from '@/lib/auth';

export const runtime = 'nodejs';

export async function OPTIONS() {
  // CORS headers middleware.ts se globally lagte hain (matcher: /api/:path*),
  // isliye yahan corsHeaders() dobara set nahi karna.
  return new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  const bearer = req.headers.get('authorization')?.replace('Bearer ', '');
  const token = bearer || req.cookies.get('token')?.value;

  if (!token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 });
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
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
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

  return NextResponse.json({
    user: row,
    hasBusiness,
    hasSubscription,
  });
}