import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { bannerPublications, banners, products } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const requestedLimit = Number(request.nextUrl.searchParams.get('limit') || 30);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 50)
      : 30;

    const rows = await db
      .select({
        id: bannerPublications.id,
        bannerId: bannerPublications.bannerId,
        platform: bannerPublications.platform,
        externalId: bannerPublications.externalId,
        permalink: bannerPublications.permalink,
        publishedAt: bannerPublications.publishedAt,
        caption: banners.caption,
        imageUrl: banners.imageUrl,
        productTitle: products.title,
      })
      .from(bannerPublications)
      .innerJoin(banners, eq(bannerPublications.bannerId, banners.id))
      .innerJoin(products, eq(banners.productId, products.id))
      .where(eq(bannerPublications.userId, userId))
      .orderBy(desc(bannerPublications.publishedAt))
      .limit(limit);

    return NextResponse.json({ success: true, posts: rows });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 401 }
      );
    }

    console.error('[Analytics Posts] Failed to load published posts:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to load published posts' },
      { status: 500 }
    );
  }
}
