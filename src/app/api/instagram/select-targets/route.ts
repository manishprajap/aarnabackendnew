// src/app/api/instagram/select-targets/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { instagramSelectedTargets, instagramConnections } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const userId = getUserIdFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const targets: string[] = Array.isArray(body?.targets)
      ? body.targets.filter((t: unknown) => typeof t === 'string')
      : [];

    const ownedAccounts = await db
      .select({ instagramUserId: instagramConnections.instagramUserId })
      .from(instagramConnections)
      .where(eq(instagramConnections.userId, userId));

    const ownedIds = new Set(ownedAccounts.map((a) => a.instagramUserId));
    const validTargets = targets.filter((t) => ownedIds.has(t));

    const existing = await db
      .select({ userId: instagramSelectedTargets.userId })
      .from(instagramSelectedTargets)
      .where(eq(instagramSelectedTargets.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(instagramSelectedTargets)
        .set({ targets: JSON.stringify(validTargets), updatedAt: new Date() })
        .where(eq(instagramSelectedTargets.userId, userId));
    } else {
      await db.insert(instagramSelectedTargets).values({
        userId,
        targets: JSON.stringify(validTargets),
      });
    }

    return NextResponse.json({ success: true, targets: validTargets });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }
    console.error('Instagram select-targets error:', error);
    return NextResponse.json({ success: false, message: 'Failed to save selection' }, { status: 500 });
  }
}