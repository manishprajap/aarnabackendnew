import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const body = await request.json().catch(() => null) as { channelId?: unknown } | null;
    const channelId = typeof body?.channelId === 'string' ? body.channelId.trim() : '';

    if (!channelId) {
      return NextResponse.json(
        { success: false, message: 'Select a YouTube channel first' },
        { status: 400 }
      );
    }

    const [account] = await db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.userId, userId), eq(socialAccounts.provider, 'youtube')))
      .limit(1);

    if (!account) {
      return NextResponse.json(
        { success: false, message: 'Connect YouTube before selecting a channel' },
        { status: 404 }
      );
    }

    const metadata =
      account.metadata && typeof account.metadata === 'object'
        ? account.metadata as Record<string, unknown>
        : {};
    const channels = Array.isArray(metadata.availableChannels)
      ? metadata.availableChannels.filter(
          (channel): channel is Record<string, unknown> =>
            Boolean(channel && typeof channel === 'object' && typeof channel.id === 'string')
        )
      : [];
    const channel = channels.find((candidate) => candidate.id === channelId);

    if (!metadata.channelSelectionRequired || !channel) {
      return NextResponse.json(
        { success: false, message: 'That channel is not available for this YouTube connection' },
        { status: 400 }
      );
    }

    const nextMetadata = {
      ...metadata,
      channelSelectionRequired: false,
      availableChannels: [],
      channelId,
      channelTitle: typeof channel.title === 'string' ? channel.title : 'YouTube channel',
      channelCustomUrl: typeof channel.customUrl === 'string' ? channel.customUrl : null,
      channelThumbnailUrl: typeof channel.thumbnailUrl === 'string' ? channel.thumbnailUrl : null,
      uploadsPlaylistId:
        typeof channel.uploadsPlaylistId === 'string' ? channel.uploadsPlaylistId : null,
    };

    await db
      .update(socialAccounts)
      .set({
        providerAccountId: channelId,
        accountName: String(nextMetadata.channelTitle),
        metadata: nextMetadata,
      })
      .where(eq(socialAccounts.id, account.id));

    return NextResponse.json({
      success: true,
      connected: true,
      channel: {
        id: channelId,
        title: nextMetadata.channelTitle,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }

    console.error('[YouTube Select Channel] Error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to save the selected YouTube channel' },
      { status: 500 }
    );
  }
}
