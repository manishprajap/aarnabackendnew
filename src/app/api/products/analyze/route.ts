import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

import { db } from '@/db';
import {
  products,
  banners,
  users,
  businessCategories,
} from '@/db/schema';
import { corsHeaders } from '@/lib/cors';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';
export const maxDuration = 120;

/*
|--------------------------------------------------------------------------
| Gemini Configuration
|--------------------------------------------------------------------------
*/

const GEMINI_TEXT_MODEL = 'gemini-3.7-flash';
const GEMINI_IMAGE_LITE_MODEL = 'gemini-3.1-flash-lite-image';

const UPLOAD_BASE_DIR =
  process.env.UPLOAD_DIR || '/var/www/aarnexai.com/aarnexai-backend/upload';

const UPLOAD_URL_PREFIX = '/upload';

type AspectRatio = '1:1' | '4:5' | '9:16' | '16:9';

const ALLOWED_ASPECT_RATIOS: AspectRatio[] = ['1:1', '4:5', '9:16', '16:9'];

const DEFAULT_ASPECT_RATIO: AspectRatio = '1:1';

const MAX_PROMPT_LENGTH = 500;

interface BannerOptions {
  categoryName: string | null;
  userPrompt: string | null;
  bannerColor: string | null;
  promptType: string | null;
  aspectRatio: AspectRatio;
}

/*
|--------------------------------------------------------------------------
| Gemini Client
|--------------------------------------------------------------------------
*/

const apiKey = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey,
});

/*
|--------------------------------------------------------------------------
| CORS Preflight
|--------------------------------------------------------------------------
*/

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

/*
|--------------------------------------------------------------------------
| Small helpers
|--------------------------------------------------------------------------
*/

const isAspectRatio = (value: unknown): value is AspectRatio =>
  typeof value === 'string' && (ALLOWED_ASPECT_RATIOS as string[]).includes(value);

/*
|--------------------------------------------------------------------------
| Retry Helper
|--------------------------------------------------------------------------
*/

function isRetryableGeminiError(error: any): boolean {
  const message = String(error?.message || '').toLowerCase();
  const status = String(error?.status || '').toLowerCase();

  return (
    message.includes('503') ||
    message.includes('unavailable') ||
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('rate limit') ||
    message.includes('temporarily unavailable') ||
    status.includes('503') ||
    status.includes('429') ||
    status.includes('unavailable')
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  {
    retries = 3,
    baseDelayMs = 1500,
    label = 'Gemini call',
  }: {
    retries?: number;
    baseDelayMs?: number;
    label?: string;
  } = {}
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      console.error(`${label} failed (attempt ${attempt}/${retries})`);
      console.error('Code:', error?.code);

      try {
        console.error(
          'Full error:',
          JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
        );
      } catch {
        console.error('Full error object:', error);
      }

      console.error('====================================\n');

      const retryable = isRetryableGeminiError(error);

      if (!retryable || attempt === retries) {
        throw error;
      }

      const delay =
        baseDelayMs * Math.pow(2, attempt - 1) +
        Math.floor(Math.random() * 500);

      console.log(`${label}: retrying in ${delay}ms...`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/*
|--------------------------------------------------------------------------
| Humanize a prompt-type value like "festive_sale" -> "Festive Sale"
|--------------------------------------------------------------------------
*/

function humanizePromptType(value: string | null): string | null {
  if (!value) return null;

  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/*
|--------------------------------------------------------------------------
| Build the creative (banner) prompt
|--------------------------------------------------------------------------
*/

function buildCreativePrompt(aiData: any, options: BannerOptions): string {
  const productName = aiData.productName || 'this product';

  const brand = aiData.brand ? ` by ${aiData.brand}` : '';

  const headline = aiData.marketingTitle || `Discover ${productName}`;

  const colorText = aiData.color
    ? `The visible product color is ${aiData.color}.`
    : '';

  const features =
    Array.isArray(aiData.features) && aiData.features.length > 0
      ? aiData.features.slice(0, 3).join(', ')
      : '';

  const categoryLine = options.categoryName ? `Business category: ${options.categoryName}.` : '';

  const brandColorLine = options.bannerColor
    ? `Use ${options.bannerColor} as the dominant accent/background color for text, badges, or backdrop elements — keep it tasteful and premium, not overpowering the product.`
    : '';

  const promptTypeLabel = humanizePromptType(options.promptType);

  const promptTypeLine = promptTypeLabel
    ? `Banner style/theme requested by the merchant: "${promptTypeLabel}". Design the banner's mood, background and layout to match this style.`
    : '';

  const userDirectionLine = options.userPrompt
    ? `Additional details/creative direction from the merchant: "${options.userPrompt}". Follow this direction as closely as possible.`
    : '';

  return `
Create a premium commercial advertising banner using the supplied product image as the primary reference.

PRODUCT:
"${productName}"${brand}
${categoryLine}

PRODUCT PRESERVATION — VERY IMPORTANT:
- Preserve the exact product shown in the supplied reference image.
- Do not redesign, replace, or invent another product.
- Preserve the recognizable shape, proportions, visible colors, logo, and product text.
- The supplied product must remain the main focal point.

AD DESIGN:
- Professional, high-end commercial advertisement quality.
- Change only the advertising environment/background around the product.
- Premium lighting, realistic shadows, subtle depth of field.
- Polished e-commerce / social-media advertising design.
${promptTypeLine}
${brandColorLine}
${userDirectionLine}

TEXT:
- Main headline: "${headline}"
- Add a short supporting marketing sentence.
- Add a "SHOP NOW" style CTA (or a discount-style CTA if the requested style is an offer/sale theme).
${
  features
    ? `- Highlight these visible product features as short callouts: ${features}.`
    : ''
}
${colorText}

LAYOUT:
- Composition and aspect ratio: ${options.aspectRatio}.
- Modern typography, strong visual hierarchy, readable text.
- Product should occupy a significant, clearly visible portion of the banner.

DO NOT:
- Add watermarks, stock-photo logos, or unrelated brand names.
- Add or invent another product, or change the product into something else.
- Create misleading specifications or invent technical details.
`.trim();
}

/*
|--------------------------------------------------------------------------
| Generate the single banner
|--------------------------------------------------------------------------
*/

async function generateCreativeBanner(
  productId: number,
  aiData: any,
  mimeType: string,
  base64Image: string,
  options: BannerOptions
) {
  const headline =
    aiData.marketingTitle || `Discover ${aiData.productName || 'this product'}`;

  const themeLabel = humanizePromptType(options.promptType) || 'Custom';

  try {
    console.log(`Generating banner for product ${productId}`);

    if (!base64Image) {
      throw new Error('Base64 product image is empty');
    }

    const creativePrompt = buildCreativePrompt(aiData, options);

    console.log('Calling Gemini image generation...');

    const bannerResponse = await withRetry(
      () =>
        ai.models.generateContent({
          model: GEMINI_IMAGE_LITE_MODEL,

          contents: [
            {
              role: 'user',

              parts: [
                {
                  text: creativePrompt,
                },

                {
                  inlineData: {
                    mimeType,
                    data: base64Image,
                  },
                },
              ],
            },
          ],

          config: {
            responseModalities: ['TEXT', 'IMAGE'],

            imageConfig: {
              aspectRatio: options.aspectRatio,
              imageSize: '1K',
            },
          },
        }),

      {
        label: 'Gemini creative',
        retries: 3,
        baseDelayMs: 1500,
      }
    );

    console.log('Gemini response received');

    const candidate = bannerResponse.candidates?.[0];

    if (!candidate) {
      throw new Error('Gemini returned no candidates');
    }

    console.log('Gemini finish reason:', candidate.finishReason || 'none');

    if (candidate.safetyRatings) {
      console.log('Gemini safety ratings:', candidate.safetyRatings);
    }

    const parts = candidate.content?.parts || [];

    console.log(`Gemini returned ${parts.length} parts`);

    const imagePart = parts.find((part: any) => part?.inlineData?.data);

    const textParts = parts
      .filter((part: any) => typeof part?.text === 'string')
      .map((part: any) => part.text);

    if (textParts.length > 0) {
      console.log('Gemini text response:', textParts.join('\n'));
    }

    if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
      throw new Error(
        [
          'Gemini returned no image data.',
          `Finish reason: ${candidate.finishReason || 'unknown'}`,
          `Parts: ${parts.length}`,
          `Text: ${textParts.join(' ') || 'none'}`,
        ].join(' ')
      );
    }

    const generatedMimeType = imagePart.inlineData.mimeType || 'image/png';

    console.log('Generated image MIME:', generatedMimeType);

    let extension = 'png';

    if (generatedMimeType === 'image/jpeg' || generatedMimeType === 'image/jpg') {
      extension = 'jpg';
    } else if (generatedMimeType === 'image/webp') {
      extension = 'webp';
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');

    if (!imageBuffer || imageBuffer.length === 0) {
      throw new Error('Generated banner image buffer is empty');
    }

    console.log(`Generated banner size: ${imageBuffer.length} bytes`);

    /*
    |--------------------------------------------------------------------------
    | Save file to the SAME shared upload folder as the original product
    | image (UPLOAD_BASE_DIR/products/banners), served by Nginx at
    | UPLOAD_URL_PREFIX ("/upload").
    |--------------------------------------------------------------------------
    */

    const bannerDir = path.join(
      /*turbopackIgnore: true*/ UPLOAD_BASE_DIR,
      'products',
      'banners'
    );

    await fs.mkdir(bannerDir, { recursive: true });

    const bannerFileName = `${productId}-banner.${extension}`;

    const bannerFilePath = path.join(/*turbopackIgnore: true*/ bannerDir, bannerFileName);

    await fs.writeFile(bannerFilePath, imageBuffer);

    console.log(`Banner file saved: ${bannerFilePath}`);

    const savedFile = await fs.stat(bannerFilePath);

    if (savedFile.size === 0) {
      throw new Error('Banner file was created but is empty');
    }

    console.log(`Verified banner file size: ${savedFile.size} bytes`);

    // Root-relative path only — same convention as originalImageUrl in
    // /api/upload. Turned into a full URL later by GET APIs (domain
    // root + this path, NOT the /bizmyntra app path).
    const imageUrl = `${UPLOAD_URL_PREFIX}/products/banners/${bannerFileName}`;

    const insertResult = await db.insert(banners).values({
      productId,
      day: 1,
      theme: themeLabel,
      imageUrl,
      caption: headline,
    });

    const bannerId = (insertResult as any)[0]?.insertId as number;

    return {
      id: bannerId,
      day: 1,
      theme: themeLabel,
      imageUrl,
      caption: headline,
      status: 'done' as const,
      error: null,
    };
  } catch (error: any) {
    console.error('Banner generation error code:', error?.code);

    try {
      console.error(
        'Full error:',
        JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      );
    } catch {
      console.error('Full error object:', error);
    }

    console.error('==============================================\n');

    return {
      id: null,
      day: 1,
      theme: themeLabel,
      imageUrl: null,
      caption: null,
      status: 'failed' as const,
      error: error?.message || 'Banner generation failed',
    };
  }
}

/*
|--------------------------------------------------------------------------
| POST /api/products/analyze
|
| Body:
| {
|   productId,                 // required
|   aspectRatio,               // optional: "1:1" | "4:5" | "9:16" | "16:9"
|   promptDescription          // optional, max 500 chars
| }
|--------------------------------------------------------------------------
*/

export async function POST(req: NextRequest) {
  let productId: number | undefined;

  const origin = req.headers.get('origin');

  // Every response (success AND error) goes through this helper so the
  // Android WebView always receives CORS headers and can read the real
  // error message instead of a generic "Failed to fetch".
  const json = (body: any, init: { status?: number } = {}) =>
    NextResponse.json(body, {
      status: init.status ?? 200,
      headers: corsHeaders(origin),
    });

  try {
    if (!process.env.GEMINI_API_KEY) {
      return json(
        {
          success: false,
          message: 'GEMINI_API_KEY is not configured',
        },
        { status: 500 }
      );
    }

    const body = await req.json();

    const rawProductId = body?.productId;

    if (rawProductId === undefined || rawProductId === null || rawProductId === '') {
      return json(
        {
          success: false,
          message: 'productId is required',
        },
        { status: 400 }
      );
    }

    const parsedProductId = Number(rawProductId);

    if (!Number.isInteger(parsedProductId)) {
      return json(
        {
          success: false,
          message: 'productId must be a valid integer',
        },
        { status: 400 }
      );
    }

    productId = parsedProductId;

    let aspectRatioInput: AspectRatio | null = null;

    if (body?.aspectRatio !== undefined && body?.aspectRatio !== null && body?.aspectRatio !== '') {
      const ar = String(body.aspectRatio).trim();

      if (!isAspectRatio(ar)) {
        return json(
          {
            success: false,
            message: `aspectRatio must be one of: ${ALLOWED_ASPECT_RATIOS.join(', ')}`,
          },
          { status: 400 }
        );
      }

      aspectRatioInput = ar;
    }

    const promptInput: string | null =
      typeof body?.promptDescription === 'string'
        ? body.promptDescription.trim().slice(0, MAX_PROMPT_LENGTH) || null
        : null;

    console.log('\n==============================================');
    console.log('STARTING PRODUCT ANALYSIS');
    console.log('Product ID:', productId);
    console.log('==============================================\n');

    /*
    |--------------------------------------------------------------------------
    | Get Product
    |--------------------------------------------------------------------------
    */

    const result = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (!result.length) {
      return json(
        {
          success: false,
          message: 'Product not found',
        },
        { status: 404 }
      );
    }

    const product = result[0] as any;

    if (!product.originalImageUrl) {
      return json(
        {
          success: false,
          message: 'Product image not found',
        },
        { status: 400 }
      );
    }

    const aspectRatio: AspectRatio =
      aspectRatioInput ??
      (isAspectRatio(product.aspectRatio) ? product.aspectRatio : DEFAULT_ASPECT_RATIO);

    const userPrompt: string | null = promptInput ?? product.prompt ?? null;
    const bannerColor: string | null = product.bannerColor || null;
    const promptType: string | null = product.promptType || null;

    const businessCategoryRows = await db
      .select({ name: businessCategories.name })
      .from(users)
      .innerJoin(businessCategories, eq(users.businessCategoryId, businessCategories.id))
      .where(eq(users.id, product.userId))
      .limit(1);
    const businessCategoryName = businessCategoryRows[0]?.name ?? null;

    /*
    |--------------------------------------------------------------------------
    | Resolve Image Path
    |--------------------------------------------------------------------------
    |
    | product.originalImageUrl is a root-relative URL like
    | "/upload/products/xyz.jpg" — strip the leading UPLOAD_URL_PREFIX
    | and resolve what's left against UPLOAD_BASE_DIR on disk.
    |
    */

    const relativeImagePath = product.originalImageUrl
      .replace(new RegExp(`^${UPLOAD_URL_PREFIX}/?`), '')
      .replace(/^\/+/, '');

    const imagePath = path.join(/*turbopackIgnore: true*/ UPLOAD_BASE_DIR, relativeImagePath);

    console.log('Product image path:', imagePath);

    try {
      await fs.access(imagePath);
    } catch {
      return json(
        {
          success: false,
          message: 'Uploaded image file does not exist',
          imagePath,
        },
        { status: 404 }
      );
    }

    const imageBuffer = await fs.readFile(/*turbopackIgnore: true*/ imagePath);

    if (imageBuffer.length === 0) {
      return json(
        {
          success: false,
          message: 'Uploaded image is empty',
        },
        { status: 400 }
      );
    }

    let mimeType = 'image/jpeg';

    const extension = path.extname(imagePath).toLowerCase();

    if (extension === '.png') {
      mimeType = 'image/png';
    } else if (extension === '.webp') {
      mimeType = 'image/webp';
    } else if (extension === '.jpg' || extension === '.jpeg') {
      mimeType = 'image/jpeg';
    }

    console.log('Image extension:', extension);
    console.log('Image MIME type:', mimeType);
    console.log('Image size:', imageBuffer.length, 'bytes');
    console.log('Aspect ratio:', aspectRatio);

    const base64Image = imageBuffer.toString('base64');

    /*
    |--------------------------------------------------------------------------
    | Save the selections on the product + mark it as processing
    | (requires `aspect_ratio` column on the products table)
    |--------------------------------------------------------------------------
    */

    await db
      .update(products)
      .set({
        prompt: userPrompt,
        aspectRatio,
        status: 'processing',
      })
      .where(eq(products.id, productId));

    /*
    |--------------------------------------------------------------------------
    | STEP 1
    | Gemini Product Analysis
    |--------------------------------------------------------------------------
    */

    const analysisPrompt = `
You are an expert product identification and marketing assistant.

Analyze the uploaded product image carefully.

Your job is to identify ONLY information that is visible in the image or can be reasonably inferred from the visual appearance.

IMPORTANT RULES:

1. Do NOT invent a brand.
2. If the brand name or logo is not visible, return null.
3. Do NOT invent an exact price.
4. If a price is visible in the image, return it.
5. If price is not visible, return null.
6. Carefully read all visible text.
7. Identify the product category.
8. Identify the product subcategory.
9. Identify the visible product color.
10. Extract useful product features.
11. Create marketing-friendly content based only on what can reasonably be determined.
12. Do not claim technical specifications that cannot be determined from the image.
13. confidence must be a number from 0 to 100.
14. Return ONLY valid JSON.

Use exactly this structure:

{
  "productName": "",
  "brand": null,
  "companyName": null,
  "price": null,
  "category": "",
  "subcategory": "",
  "color": "",
  "features": [],
  "description": "",
  "marketingTitle": "",
  "metaDescription": "",
  "keywords": [],
  "hashtags": [],
  "visibleText": [],
  "confidence": 0
}
`.trim();

    console.log('Starting Gemini product analysis...');

    const analysisResponse = await withRetry(
      () =>
        ai.models.generateContent({
          model: GEMINI_TEXT_MODEL,

          contents: [
            {
              role: 'user',

              parts: [
                { text: analysisPrompt },

                {
                  inlineData: {
                    mimeType,
                    data: base64Image,
                  },
                },
              ],
            },
          ],

          config: {
            responseMimeType: 'application/json',

            responseSchema: {
              type: 'OBJECT',

              properties: {
                productName: { type: 'STRING' },
                brand: { type: 'STRING', nullable: true },
                companyName: { type: 'STRING', nullable: true },
                price: { type: 'STRING', nullable: true },
                category: { type: 'STRING' },
                subcategory: { type: 'STRING' },
                color: { type: 'STRING' },
                features: { type: 'ARRAY', items: { type: 'STRING' } },
                description: { type: 'STRING' },
                marketingTitle: { type: 'STRING' },
                metaDescription: { type: 'STRING' },
                keywords: { type: 'ARRAY', items: { type: 'STRING' } },
                hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
                visibleText: { type: 'ARRAY', items: { type: 'STRING' } },
                confidence: { type: 'NUMBER' },
              },

              required: [
                'productName',
                'brand',
                'companyName',
                'price',
                'category',
                'subcategory',
                'color',
                'features',
                'description',
                'marketingTitle',
                'metaDescription',
                'keywords',
                'hashtags',
                'visibleText',
                'confidence',
              ],
            },
          },
        }),

      {
        label: 'Gemini product analysis',
        retries: 3,
        baseDelayMs: 1000,
      }
    );

    const rawText = analysisResponse.text?.trim() || '';

    if (!rawText) {
      throw new Error('Gemini returned an empty response');
    }

    console.log('Gemini analysis response:', rawText);

    let aiData: any;

    try {
      aiData = JSON.parse(rawText);
    } catch {
      const cleanedText = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      try {
        aiData = JSON.parse(cleanedText);
      } catch {
        await db
          .update(products)
          .set({ status: 'failed' })
          .where(eq(products.id, productId));

        return json(
          {
            success: false,
            message: 'AI returned invalid JSON',
            rawResponse: rawText,
          },
          { status: 500 }
        );
      }
    }

    /*
    |--------------------------------------------------------------------------
    | Normalize AI Data
    |--------------------------------------------------------------------------
    */

    const productName = aiData.productName || null;
    const brand = aiData.brand || null;
    const companyName = aiData.companyName || null;
    const price = aiData.price || null;

    // Use the business profile's category as context; the AI still identifies the uploaded item.
    const category = businessCategoryName || aiData.category || null;
    const subcategory = aiData.subcategory || null;

    const color = aiData.color || null;

    const features = Array.isArray(aiData.features) ? aiData.features : [];

    const description = aiData.description || null;
    const marketingTitle = aiData.marketingTitle || null;
    const metaDescription = aiData.metaDescription || null;

    const keywords = Array.isArray(aiData.keywords) ? aiData.keywords : [];
    const hashtags = Array.isArray(aiData.hashtags) ? aiData.hashtags : [];
    const visibleText = Array.isArray(aiData.visibleText) ? aiData.visibleText : [];

    let confidence = Number(aiData.confidence);

    if (Number.isNaN(confidence)) {
      confidence = 0;
    }

    confidence = Math.max(0, Math.min(100, Math.round(confidence)));

    /*
    |--------------------------------------------------------------------------
    | STEP 2
    | Generate exactly ONE banner, using the merchant's own selections
    |--------------------------------------------------------------------------
    */

    const bannerResult = await generateCreativeBanner(
      productId,
      aiData,
      mimeType,
      base64Image,
      {
        categoryName: category,
        userPrompt,
        bannerColor,
        promptType,
        aspectRatio,
      }
    );

    /*
    |--------------------------------------------------------------------------
    | STEP 3
    | Save AI Analysis
    |--------------------------------------------------------------------------
    */

    await db
      .update(products)
      .set({
        title: productName,
        brand,
        companyName,
        price,
        category,
        subcategory,
        color,
        description,
        features: JSON.stringify(features),
        keywords: JSON.stringify(keywords),
        hashtags: JSON.stringify(hashtags),
        visibleText: JSON.stringify(visibleText),
        metaDescription,
        confidence,
        status: bannerResult.status === 'done' ? 'done' : 'failed',
      })
      .where(eq(products.id, productId));

    /*
    |--------------------------------------------------------------------------
    | Final Response
    |
    | `banner`  -> single object (backwards compatible)
    | `banners` -> array (what Upload.tsx reads)
    |--------------------------------------------------------------------------
    */

    return json(
      {
        success: bannerResult.status === 'done',
        message:
          bannerResult.status === 'done'
            ? 'Product analyzed and banner generated successfully'
            : bannerResult.error
              ? `Product analyzed but banner generation failed: ${bannerResult.error}`
              : 'Product analyzed but banner generation failed',
        productId,
        status: bannerResult.status,

        product: {
          productName,
          brand,
          companyName,
          price,
          category,
          subcategory,
          color,
          features,
          description,
          marketingTitle,
          metaDescription,
          keywords,
          hashtags,
          visibleText,
          confidence,
          prompt: userPrompt,
          promptType,
          bannerColor,
          aspectRatio,
        },

        banner: bannerResult,
        banners: [bannerResult],
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('Analyze error code:', error?.code);

    try {
      console.error(
        'Full error:',
        JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      );
    } catch {
      console.error('Full error object:', error);
    }

    console.error('==============================================\n');

    if (productId) {
      try {
        await db
          .update(products)
          .set({ status: 'failed' })
          .where(eq(products.id, productId));
      } catch (dbError) {
        console.error('FAILED STATUS UPDATE:', dbError);
      }
    }

    return json(
      {
        success: false,
        message: error?.message || 'Product analysis failed',
        productId: productId ?? null,
      },
      { status: 500 }
    );
  }
}