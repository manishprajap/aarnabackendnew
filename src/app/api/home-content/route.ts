import { NextResponse } from 'next/server';
import { and, asc, eq, lte, or, isNull, gte } from 'drizzle-orm';

import { db } from '@/db';
import { homeContent } from '@/db/schema';

export const dynamic = 'force-dynamic';

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

    return NextResponse.json({ success: true, data: items });
  } catch (error) {
    console.error('Public home-content API error:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load home content.' },
      { status: 500 },
    );
  }
}
