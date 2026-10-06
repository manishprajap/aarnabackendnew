///src/app/api/facebook/status/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { facebookConnections, facebookSelectedTargets } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);

    const rows = await db
      .select({
        pageId: facebookConnections.pageId,
        pageName: facebookConnections.pageName,
        pageProfilePicture: facebookConnections.pageProfilePicture,
        status: facebookConnections.status,
        connectedAt: facebookConnections.connectedAt,
        lastVerifiedAt: facebookConnections.lastVerifiedAt,
        lastPublishAt: facebookConnections.lastPublishAt,
        lastError: facebookConnections.lastError,
      })
      .from(facebookConnections)
      .where(eq(facebookConnections.userId, userId));
      // .limit(1) hata diya — ab saari Pages aayengi

    const activeRows = rows.filter((r) => r.status === 'active');

    if (activeRows.length === 0) {
      return NextResponse.json({
        success: true,
        connected: false,
        targets: [],
        selectedTargets: [],
        connection: null,
      });
    }

    const selectedRow = await db
      .select()
      .from(facebookSelectedTargets)
      .where(eq(facebookSelectedTargets.userId, userId))
      .limit(1);

    const selected: string[] = selectedRow[0]
      ? JSON.parse(selectedRow[0].targets)
      : activeRows.map((r) => r.pageId); // default: sab pages selected

    return NextResponse.json({
      success: true,
      connected: true,

      targets: activeRows.map((r) => ({
        type: 'page',
        urn: r.pageId,
        name: r.pageName || 'Page',
      })),
      selectedTargets: selected,

      // backward-compat — purana frontend jo `connection.pageName` padhta hai
      connection: {
        pageId: activeRows[0].pageId,
        pageName: activeRows[0].pageName,
        pageProfilePicture: activeRows[0].pageProfilePicture,
        status: 'active',
        connectedAt: activeRows[0].connectedAt,
        lastVerifiedAt: activeRows[0].lastVerifiedAt,
        lastPublishAt: activeRows[0].lastPublishAt,
        lastError: activeRows[0].lastError,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }
    console.error('Facebook status error:', error);
    return NextResponse.json({ success: false, message: 'Unable to get Facebook status' }, { status: 500 });
  }
}