import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  facebookConnections,
  facebookSelectedTargets,
  instagramConnections,
  instagramSelectedTargets,
  socialAccounts,
  whatsappConnections,
} from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';

const SOCIAL_PLATFORMS = new Set([
  'facebook',
  'instagram',
  'whatsapp',
  'google_business',
  'google_analytics',
  'youtube',
  'youtube_analytics',
  'linkedin',
]);

type RouteContext = {
  params: Promise<{ platform: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const userId = getUserIdFromRequest(request);
    const { platform } = await context.params;

    if (!SOCIAL_PLATFORMS.has(platform)) {
      return NextResponse.json(
        { success: false, message: 'Unsupported social platform' },
        { status: 400 }
      );
    }

    switch (platform) {
      case 'facebook':
        await db.delete(facebookConnections).where(eq(facebookConnections.userId, userId));
        await db.delete(facebookSelectedTargets).where(eq(facebookSelectedTargets.userId, userId));
        break;
      case 'instagram':
        await db.delete(instagramConnections).where(eq(instagramConnections.userId, userId));
        await db.delete(instagramSelectedTargets).where(eq(instagramSelectedTargets.userId, userId));
        break;
      case 'whatsapp':
        await db.delete(whatsappConnections).where(eq(whatsappConnections.userId, userId));
        break;
      default:
        await db
          .delete(socialAccounts)
          .where(
            and(
              eq(socialAccounts.userId, userId),
              eq(socialAccounts.provider, platform)
            )
          );
    }

    return NextResponse.json({ success: true, disconnected: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 401 }
      );
    }

    console.error('[Social Disconnect] Failed to disconnect account:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to disconnect this account' },
      { status: 500 }
    );
  }
}
