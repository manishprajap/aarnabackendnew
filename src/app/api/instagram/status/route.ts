// src/app/api/instagram/status/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { instagramConnections, instagramSelectedTargets } from '@/db/schema';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const userId = getUserIdFromRequest(req);

    const connectionRows = await db
      .select({
        instagramUserId: instagramConnections.instagramUserId,
        instagramUsername: instagramConnections.instagramUsername,
        instagramName: instagramConnections.instagramName,
        instagramProfilePicture: instagramConnections.instagramProfilePicture,
        tokenExpiresAt: instagramConnections.tokenExpiresAt,
        status: instagramConnections.status,
      })
      .from(instagramConnections)
      .where(eq(instagramConnections.userId, userId));
      // .limit(1) hata diya — ab saare connected accounts aayenge

    const activeRows = connectionRows.filter(
      (r) =>
        r.status === 'active' &&
        (!r.tokenExpiresAt || new Date(r.tokenExpiresAt).getTime() > Date.now())
    );

    if (activeRows.length === 0) {
      const anyExpired = connectionRows.some(
        (r) => r.status === 'expired' || (r.tokenExpiresAt && new Date(r.tokenExpiresAt).getTime() <= Date.now())
      );

      return NextResponse.json({
        success: true,
        connected: false,
        expired: anyExpired,
        targets: [],
        selectedTargets: [],
        connection: null,
      });
    }

    const selectedRow = await db
      .select()
      .from(instagramSelectedTargets)
      .where(eq(instagramSelectedTargets.userId, userId))
      .limit(1);

    const selected: string[] = selectedRow[0]
      ? JSON.parse(selectedRow[0].targets)
      : activeRows.map((r) => r.instagramUserId); // default: sab selected

    return NextResponse.json({
      success: true,
      connected: true,
      expired: false,

      targets: activeRows.map((r) => ({
        type: 'account',
        urn: r.instagramUserId,
        name: r.instagramUsername || r.instagramName || 'Instagram account',
      })),
      selectedTargets: selected,

      // backward-compat
      connection: {
        id: activeRows[0].instagramUserId,
        username: activeRows[0].instagramUsername,
        name: activeRows[0].instagramName,
        profilePicture: activeRows[0].instagramProfilePicture,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }
    console.error('[Instagram Status] Error:', error);
    return NextResponse.json({ success: false, message: 'Failed to check Instagram connection' }, { status: 500 });
  }
}