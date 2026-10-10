import { NextResponse } from 'next/server';
import { and, asc, eq, lte, or, isNull, gte } from 'drizzle-orm';

import { db } from '@/db';
import { homeContent } from '@/db/schema';

export const dynamic = 'force-dynamic';
const MEDIA_ORIGIN = process.env.NEXT_PUBLIC_MEDIA_URL || 'https://aarnexai.com';

function toFullMediaUrl(value: string | null): string | null {
  if (!value?.trim()) return null;

  const mediaUrl = value.trim();
  if (/^https?:\/\//i.test(mediaUrl)) {
    try {
      const url = new URL(mediaUrl);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return `${MEDIA_ORIGIN}${url.pathname}${url.search}${url.hash}`;
      }
      return url.toString();
    } catch {
      return `${MEDIA_ORIGIN}/${mediaUrl.replace(/^\/+/, '')}`;
    }
  }

  return `${MEDIA_ORIGIN}/${mediaUrl.replace(/^\/+/, '')}`;
}

export async function GET() {
  try {
    const now = new Date();
    const items = await db
      .select({
        id: homeContent.id,
        contentType: homeContent.contentType,
        title: homeContent.title,
        description: homeContent.description,
        mediaUrl: homeContent.mediaUrl,
        mediaType: homeContent.mediaType,
        buttonText: homeContent.buttonText,
        buttonUrl: homeContent.buttonUrl,
        newsUrl: homeContent.newsUrl,
        displayOrder: homeContent.displayOrder,
      })
      .from(homeContent)
      .where(and(
        eq(homeContent.isActive, true),
        or(isNull(homeContent.startDate), lte(homeContent.startDate, now)),
        or(isNull(homeContent.endDate), gte(homeContent.endDate, now)),
      ))
      .orderBy(asc(homeContent.contentType), asc(homeContent.displayOrder), asc(homeContent.id));

    return NextResponse.json({
      success: true,
      data: items.map((item) => ({
        ...item,
        mediaUrl: toFullMediaUrl(item.mediaUrl),
      })),
    });
  } catch (error) {
    console.error('Public home-content API error:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load home content.' },
      { status: 500 },
    );
  }
}
