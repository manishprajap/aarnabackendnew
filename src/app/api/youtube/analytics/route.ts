import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';

const DEFAULT_METRICS = 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained';

function validDate(value: string | null, fallback: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const { searchParams } = new URL(request.url);
    const endDate = validDate(searchParams.get('endDate'), new Date().toISOString().slice(0, 10));
    const startDate = validDate(
      searchParams.get('startDate'),
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    );
    const dimensions = searchParams.get('dimensions') || 'day';
    const metrics = searchParams.get('metrics') || DEFAULT_METRICS;

    if (dimensions !== 'day' || !/^[a-zA-Z,]+$/.test(metrics)) {
      return NextResponse.json(
        { success: false, message: 'Invalid dimensions or metrics' },
        { status: 400 }
      );
    }

    const [account] = await db
      .select({
        accessToken: socialAccounts.accessToken,
        expiresAt: socialAccounts.expiresAt,
        metadata: socialAccounts.metadata,
      })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.userId, userId), eq(socialAccounts.provider, 'youtube')))
      .limit(1);

    if (!account?.accessToken) {
      return NextResponse.json(
        { success: false, message: 'YouTube is not connected' },
        { status: 404 }
      );
    }

    const metadata =
      account.metadata && typeof account.metadata === 'object'
        ? account.metadata as Record<string, unknown>
        : {};
    if (metadata.channelSelectionRequired === true) {
      return NextResponse.json(
        { success: false, message: 'Choose a YouTube channel before loading analytics' },
        { status: 409 }
      );
    }
    const channelId = typeof metadata.channelId === 'string' ? metadata.channelId : null;

    const params = new URLSearchParams({
      ids: channelId ? `channel==${channelId}` : 'channel==MINE',
      startDate,
      endDate,
      metrics,
      dimensions,
      sort: 'day',
    });

    const response = await fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${account.accessToken}` },
        cache: 'no-store',
      }
    );

    const data = await response.json();
    if (!response.ok) {
      console.error('[YouTube Analytics] Provider error:', response.status, data);
      return NextResponse.json(
        { success: false, message: 'Unable to fetch YouTube Analytics data', details: data },
        { status: response.status === 401 ? 401 : 502 }
      );
    }

    return NextResponse.json({ success: true, startDate, endDate, data });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }

    console.error('[YouTube Analytics] Error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch YouTube Analytics data' },
      { status: 500 }
    );
  }
}
