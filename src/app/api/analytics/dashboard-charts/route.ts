import { sql } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { rowsOf } from '@/lib/onboarding';

export const dynamic = 'force-dynamic';

const PLATFORMS = [
  'facebook',
  'instagram',
  'google_business',
  'youtube',
  'linkedin',
  'whatsapp',
] as const;

function dateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export async function GET(request: NextRequest) {
  try {
    const userId = Number(await getUserIdFromRequest(request));
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
    }

    const params = new URL(request.url).searchParams;
    const mode = params.get('mode') === 'year' ? 'year' : 'month';
    const currentYear = new Date().getUTCFullYear();
    const year = Number(params.get('year') || currentYear);
    const month = Number(params.get('month') || new Date().getUTCMonth() + 1);
    if (!Number.isInteger(year) || year < 2000 || year > currentYear + 1) {
      return NextResponse.json({ success: false, message: 'Invalid year' }, { status: 400 });
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ success: false, message: 'Invalid month' }, { status: 400 });
    }

    const startDate = mode === 'year' ? dateString(year, 1, 1) : dateString(year, month, 1);
    const endDate = mode === 'year'
      ? dateString(year + 1, 1, 1)
      : month === 12
        ? dateString(year + 1, 1, 1)
        : dateString(year, month + 1, 1);
    const bucketFormat = mode === 'year' ? '%Y-%m' : '%Y-%m-%d';

    const [bucketRows, yearRows, userRows] = await Promise.all([
      db.execute(sql`
        SELECT platform, DATE_FORMAT(published_at, ${bucketFormat}) AS bucket, COUNT(*) AS total
        FROM banner_publications
        WHERE user_id = ${userId} AND published_at >= ${startDate} AND published_at < ${endDate}
        GROUP BY platform, bucket
        ORDER BY bucket ASC
      `),
      db.execute(sql`
        SELECT DISTINCT YEAR(published_at) AS year
        FROM banner_publications
        WHERE user_id = ${userId}
        ORDER BY year DESC
      `),
      db.execute(sql`
        SELECT city, state, country FROM users WHERE id = ${userId} LIMIT 1
      `),
    ]);

    const bucketCount = mode === 'year'
      ? 12
      : new Date(Date.UTC(year, month, 0)).getUTCDate();
    const labels = mode === 'year'
      ? Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'))
      : Array.from({ length: bucketCount }, (_, index) =>
          dateString(year, month, index + 1)
        );
    const platformCounts = Object.fromEntries(
      PLATFORMS.map((platform) => [platform, Array.from({ length: bucketCount }, () => 0)])
    ) as Record<(typeof PLATFORMS)[number], number[]>;

    for (const row of rowsOf(bucketRows)) {
      const platform = String(row.platform) as (typeof PLATFORMS)[number];
      if (!PLATFORMS.includes(platform)) continue;
      const bucket = String(row.bucket || '');
      const index = mode === 'year'
        ? Number(bucket.slice(5, 7)) - 1
        : Number(bucket.slice(8, 10)) - 1;
      if (index >= 0 && index < bucketCount) {
        platformCounts[platform][index] = Number(row.total) || 0;
      }
    }

    const years = rowsOf(yearRows)
      .map((row) => Number(row.year))
      .filter((value) => Number.isInteger(value) && value >= 2000);
    if (!years.includes(currentYear)) years.unshift(currentYear);

    const user = rowsOf(userRows)[0] as
      | { city?: string | null; state?: string | null; country?: string | null }
      | undefined;

    return NextResponse.json({
      success: true,
      mode,
      year,
      month,
      labels,
      platforms: platformCounts,
      years: Array.from(new Set(years)).sort((a, b) => b - a),
      location: {
        city: user?.city || '',
        state: user?.state || '',
        country: user?.country || '',
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }

    console.error('[DashboardCharts] Failed to load chart data:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load dashboard analytics charts.' },
      { status: 500 }
    );
  }
}
