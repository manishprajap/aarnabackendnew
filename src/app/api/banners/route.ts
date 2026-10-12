///src/app/api/banners/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { products, banners } from '@/db/schema';
import { eq, desc, inArray, and } from 'drizzle-orm';
import { verifyToken } from '@/lib/auth';
import { migrateLegacyGeneratedAdImage } from '@/lib/uploadStorage';

export const runtime = 'nodejs';

// Domain root — images are served by Nginx from here, NOT from
// NEXT_PUBLIC_APP_URL (which includes the /bizmyntra app path prefix).
const MEDIA_ORIGIN =
  process.env.NEXT_PUBLIC_MEDIA_URL || 'https://aarnexai.com';

function toFullUrl(path: string | null): string | null {
  if (!path) return null;

  // Already absolute (safety net for any legacy rows)
  if (/^https?:\/\//i.test(path)) return path;

  // Ensure exactly one slash between origin and path
  return `${MEDIA_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
}

export async function OPTIONS() {
  // CORS headers middleware.ts se globally lagte hain (matcher: /api/:path*),
  // isliye yahan corsHeaders() dobara set nahi karna — warna header duplicate ho jata hai.
  return new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  try {
    const bearer = req.headers.get('authorization')?.replace('Bearer ', '');
    const token = bearer || req.cookies.get('token')?.value;

    if (!token) {
      return NextResponse.json(
        { success: false, message: 'Not authenticated' },
        { status: 401 }
      );
    }

    const payload = verifyToken(token);
    if (!payload) {
      return NextResponse.json(
        { success: false, message: 'Session expired' },
        { status: 401 }
      );
    }

    const userId = Number(payload.userId);

    const userProducts = await db
      .select({
        id: products.id,
        title: products.title,
        description: products.description,
        features: products.features,
        keywords: products.keywords,
        hashtags: products.hashtags,
        visibleText: products.visibleText,
        metaDescription: products.metaDescription,
        originalImageUrl: products.originalImageUrl,
      })
      .from(products)
      .where(eq(products.userId, userId));

    if (!userProducts.length) {
      return NextResponse.json({ success: true, banners: [] });
    }

    const productIds = userProducts.map((p) => p.id);
    const productById = new Map(userProducts.map((p) => [p.id, p]));

    // FIX: exclude banners that have already been posted
    // (posted = 1) so they stop showing up after a refresh.
    const rows = await db
      .select()
      .from(banners)
      .where(
        and(
          inArray(banners.productId, productIds),
          eq(banners.posted, false)
        )
      )
      .orderBy(desc(banners.createdAt));

    const result = await Promise.all(rows.map(async (banner) => {
      const product = productById.get(banner.productId);

      return {
        id: banner.id,
        productId: banner.productId,

        // product details
        productName: product?.title ?? null,
        description: product?.description ?? null,
        features: product?.features ?? [],
        keywords: product?.keywords ?? [],
        hashtags: product?.hashtags ?? [],
        visibleText: product?.visibleText ?? [],
        metaDescription: product?.metaDescription ?? null,

        productImageUrl: toFullUrl(product?.originalImageUrl ?? null),

        day: banner.day,
        theme: banner.theme,
        imageUrl: toFullUrl(await migrateLegacyGeneratedAdImage(banner.imageUrl)),
        caption: banner.caption,
        createdAt: banner.createdAt,
      };
    }));

    return NextResponse.json({ success: true, banners: result });
  } catch (error) {
    console.error('GET USER BANNERS ERROR:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch banners' },
      { status: 500 }
    );
  }
}