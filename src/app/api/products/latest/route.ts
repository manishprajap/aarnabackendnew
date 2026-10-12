import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import { products, banners } from '@/db/schema';

import { asc, desc, eq } from 'drizzle-orm';

import { getUserIdFromRequest } from '@/lib/auth';
import { migrateLegacyGeneratedAdImage } from '@/lib/uploadStorage';

/*
|--------------------------------------------------------------------------
| Safe JSON parse
|--------------------------------------------------------------------------
|
| features / keywords / hashtags / visibleText are stored as
| JSON strings in MySQL text columns.
|
*/

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/*
|--------------------------------------------------------------------------
| Media URL
|--------------------------------------------------------------------------
*/

const MEDIA_ORIGIN =
  process.env.NEXT_PUBLIC_MEDIA_URL || 'https://aarnexai.com';

function toFullUrl(path: string | null): string | null {
  if (!path) return null;

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${MEDIA_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
}

/*
|--------------------------------------------------------------------------
| GET /api/products/latest
|--------------------------------------------------------------------------
|
| No productId is required.
|
| The logged-in user is identified from the JWT token.
| Then the newest product belonging to that user is returned.
|
*/

export async function GET(req: NextRequest) {
  try {
    /*
    |--------------------------------------------------------------------------
    | Get logged-in user
    |--------------------------------------------------------------------------
    */

    const userId = getUserIdFromRequest(req);

    if (!userId) {
      return NextResponse.json(
        {
          success: false,
          message: 'Unauthorized',
        },
        { status: 401 }
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Get latest product for this user
    |--------------------------------------------------------------------------
    */

    const result = await db
      .select()
      .from(products)
      .where(eq(products.userId, userId))
      .orderBy(desc(products.createdAt))
      .limit(1);

    /*
    |--------------------------------------------------------------------------
    | No product uploaded yet
    |--------------------------------------------------------------------------
    */

    if (!result.length) {
      return NextResponse.json(
        {
          success: false,
          message: 'No product found',
        },
        { status: 404 }
      );
    }

    const product = result[0];

    /*
    |--------------------------------------------------------------------------
    | Get product banners
    |--------------------------------------------------------------------------
    */

    const productBanners = await db
      .select()
      .from(banners)
      .where(eq(banners.productId, product.id))
      .orderBy(asc(banners.day));

    /*
    |--------------------------------------------------------------------------
    | Return same structure as /products/:productId
    |--------------------------------------------------------------------------
    */

    return NextResponse.json({
      success: true,

      product: {
        id: product.id,

        status: product.status,

        originalImageUrl: toFullUrl(await migrateLegacyGeneratedAdImage(product.originalImageUrl)),

        cleanImageUrl: toFullUrl(product.cleanImageUrl),

        productName: product.title,

        brand: product.brand,

        companyName: product.companyName,

        price: product.price,

        category: product.category,

        subcategory: product.subcategory,

        color: product.color,

        description: product.description,

        metaDescription: product.metaDescription,

        confidence: product.confidence,

        features: parseJsonArray(product.features),

        keywords: parseJsonArray(product.keywords),

        hashtags: parseJsonArray(product.hashtags),

        visibleText: parseJsonArray(product.visibleText),

        createdAt: product.createdAt,

        banners: await Promise.all(productBanners.map(async (banner) => ({
          id: banner.id,
          day: banner.day,
          theme: banner.theme,
          imageUrl: toFullUrl(await migrateLegacyGeneratedAdImage(banner.imageUrl)),
          caption: banner.caption,
          createdAt: banner.createdAt,
        }))),
      },
    });
  } catch (error) {
    console.error('GET LATEST PRODUCT ERROR:', error);

    return NextResponse.json(
      {
        success: false,
        message: 'Failed to fetch latest product',
      },
      { status: 500 }
    );
  }
}
