import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const [connection] = await db
      .select({
        accountName: socialAccounts.accountName,
        providerAccountId: socialAccounts.providerAccountId,
        metadata: socialAccounts.metadata,
        expiresAt: socialAccounts.expiresAt,
      })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.userId, userId), eq(socialAccounts.provider, 'youtube')))
      .limit(1);

    const metadata =
      connection?.metadata && typeof connection.metadata === 'object'
        ? connection.metadata as Record<string, unknown>
        : {};
    const availableChannels = Array.isArray(metadata.availableChannels)
      ? metadata.availableChannels
          .filter((channel): channel is Record<string, unknown> =>
            Boolean(channel && typeof channel === 'object' && typeof channel.id === 'string')
          )
          .map((channel) => ({
            id: String(channel.id),
            title: typeof channel.title === 'string' ? channel.title : 'YouTube channel',
            customUrl: typeof channel.customUrl === 'string' ? channel.customUrl : null,
            thumbnailUrl: typeof channel.thumbnailUrl === 'string' ? channel.thumbnailUrl : null,
          }))
      : [];
    const selectionRequired = metadata.channelSelectionRequired === true;

    return NextResponse.json({
      success: true,
      connected: Boolean(connection) && !selectionRequired,
      needsChannelSelection: selectionRequired,
      channels: availableChannels,
      connection: connection
        ? {
            accountName: connection.accountName,
            providerAccountId: connection.providerAccountId,
            expiresAt: connection.expiresAt,
            channelId: typeof metadata.channelId === 'string' ? metadata.channelId : null,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }

    console.error('[YouTube Status] Error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to check YouTube connection' },
      { status: 500 }
    );
  }
}
