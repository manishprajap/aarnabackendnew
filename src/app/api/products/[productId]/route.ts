import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import { products, banners } from '@/db/schema';

import { asc, eq } from 'drizzle-orm';
import { migrateLegacyGeneratedAdImage } from '@/lib/uploadStorage';

/*
|--------------------------------------------------------------------------
| Safe JSON parse
|--------------------------------------------------------------------------
|
| features / keywords / hashtags / visibleText are stored as
| JSON strings in MySQL (text columns). This safely turns them
| back into arrays, falling back to [] if null/invalid.
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
const MEDIA_ORIGIN =
  process.env.NEXT_PUBLIC_MEDIA_URL || 'https://aarnexai.com';

function toFullUrl(path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${MEDIA_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
}


export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      productId: string;
    }>;
  }
) {
  try {
    const { productId: rawProductId } = await params;
    const productId = Number(rawProductId);

    if (!rawProductId || Number.isNaN(productId)) {
      return NextResponse.json(
        {
          success: false,
          message: 'productId is required',
        },
        { status: 400 }
      );
    }

    const result = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (!result.length) {
      return NextResponse.json(
        {
          success: false,
          message: 'Product not found',
        },
        { status: 404 }
      );
    }

    const product = result[0];

    const productBanners = await db
      .select()
      .from(banners)
      .where(eq(banners.productId, productId))
      .orderBy(asc(banners.day));

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
          theme: banner.theme, // the 'YYYY-MM-DD' this banner is for
          imageUrl: toFullUrl(await migrateLegacyGeneratedAdImage(banner.imageUrl)),
          caption: banner.caption,
          createdAt: banner.createdAt,
        }))),
      },
    });
  } catch (error) {
    console.error('GET PRODUCT ERROR:', error);

    return NextResponse.json(
      {
        success: false,
        message: 'Failed to fetch product',
      },
      { status: 500 }
    );
  }
}