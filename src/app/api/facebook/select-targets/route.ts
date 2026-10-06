// src/app/api/facebook/select-targets/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { facebookSelectedTargets, facebookConnections } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const userId = getUserIdFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const targets: string[] = Array.isArray(body?.targets)
      ? body.targets.filter((t: unknown) => typeof t === 'string')
      : [];

    // Sirf wahi pageIds accept karo jo actually is user se connected hain
    const ownedPages = await db
      .select({ pageId: facebookConnections.pageId })
      .from(facebookConnections)
      .where(eq(facebookConnections.userId, userId));

    const ownedPageIds = new Set(ownedPages.map((p) => p.pageId));
    const validTargets = targets.filter((t) => ownedPageIds.has(t));

    const existing = await db
      .select({ userId: facebookSelectedTargets.userId })
      .from(facebookSelectedTargets)
      .where(eq(facebookSelectedTargets.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(facebookSelectedTargets)
        .set({ targets: JSON.stringify(validTargets), updatedAt: new Date() })
        .where(eq(facebookSelectedTargets.userId, userId));
    } else {
      await db.insert(facebookSelectedTargets).values({
        userId,
        targets: JSON.stringify(validTargets),
      });
    }

    return NextResponse.json({ success: true, targets: validTargets });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }
    console.error('Facebook select-targets error:', error);
    return NextResponse.json({ success: false, message: 'Failed to save selection' }, { status: 500 });
  }
}