// app/api/products/generate-ad/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

import { db } from '@/db';
import { products, adPresets, adSuggestions, adCreatives } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import {
  getSubscriptionAccess,
  reserveBannerGeneration,
  subscriptionDeniedResponse,
} from '@/lib/subscriptionAccess';

import fs from 'fs/promises';
import path from 'path';

const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

const PLATFORM_ASPECT_RATIO: Record<string, string> = {
  google: '1:1',
  facebook: '1:1',
  instagram: '1:1',
  youtube: '16:9',
};

function isRetryableGeminiError(error: any): boolean {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('503') ||
    message.includes('unavailable') ||
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('rate limit')
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, baseDelayMs = 1500 }: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      console.error(`Gemini ad-generate error (attempt ${attempt}/${retries}):`, error?.message);

      if (!isRetryableGeminiError(error) || attempt === retries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function buildAdPrompt(opts: {
  product: typeof products.$inferSelect;
  conceptPrompt: string;
  aspectRatio: string;
  overlay: {
    price?: string | null;
    discount?: string | null;
    phone?: string | null;
    website?: string | null;
    cta?: string | null;
  };
  hasLogo: boolean;
}) {
  const { product, conceptPrompt, aspectRatio, overlay, hasLogo } = opts;

  const name = product.title || 'this product';
  const brand = product.brand ? ` by ${product.brand}` : '';

  const overlayLines: string[] = [];

  if (overlay.price) overlayLines.push(`- Display the price clearly: "${overlay.price}"`);
  if (overlay.discount) overlayLines.push(`- Display a discount badge: "${overlay.discount}"`);
  if (overlay.cta) overlayLines.push(`- Add a call-to-action button/text: "${overlay.cta}"`);
  if (overlay.phone) overlayLines.push(`- Include the contact number in small text: "${overlay.phone}"`);
  if (overlay.website) overlayLines.push(`- Include the website/handle in small text: "${overlay.website}"`);
  if (hasLogo) overlayLines.push('- Place the supplied logo image in a corner as a small, tasteful watermark. Do not distort or recolor the logo.');

  return `
Create a professional advertising banner using the supplied reference image(s).

SUBJECT: "${name}"${brand}

PRESERVATION — VERY IMPORTANT:
- Preserve the exact subject shown in the first reference image (shape, proportions, visible colors, visible text/logo).
- Do not invent or substitute a different subject.

${conceptPrompt}

OVERLAY ELEMENTS:
${overlayLines.length ? overlayLines.join('\n') : '- No price/discount/CTA overlay requested — keep the design clean.'}

LAYOUT:
- Aspect ratio: ${aspectRatio}.
- Modern, readable typography.
- Strong visual hierarchy, balanced composition.

DO NOT:
- Add unrelated stock-photo watermarks or brand names.
- Invent technical specifications or claims not supported by the reference image.
`.trim();
}

export async function POST(req: NextRequest) {
  // adCreatives.id is autoincrement int — we only know it once we've
  // inserted the "processing" row, so this stays undefined until then.
  let creativeId: number | undefined;

  try {
    let userId: number;
    try {
      userId = getUserIdFromRequest(req);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 401 });
      }
      throw error;
    }

    const subscriptionAccess = await getSubscriptionAccess(userId);
    if (!subscriptionAccess.allowed) {
      return subscriptionDeniedResponse(subscriptionAccess);
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { success: false, message: 'GEMINI_API_KEY is not configured' },
        { status: 500 }
      );
    }

    const formData = await req.formData();

    /*
    |------------------------------------------------------------------
    | productId / suggestionId are now int FKs (products.id and
    | adSuggestions.id are both int autoincrement), but formData
    | always gives us strings — coerce + validate them here.
    |------------------------------------------------------------------
    */

    const productIdRaw = formData.get('productId') as string | null;
    const suggestionIdRaw = (formData.get('suggestionId') as string | null) || null;
    const presetKey = (formData.get('presetKey') as string | null) || null; // fallback path
    const platform = (formData.get('platform') as string | null) || null;

    const price = (formData.get('price') as string | null) || null;
    const discount = (formData.get('discount') as string | null) || null;
    const phone = (formData.get('phone') as string | null) || null;
    const website = (formData.get('website') as string | null) || null;
    const cta = (formData.get('cta') as string | null) || null;

    const logoFile = formData.get('logo') as File | null;

    if (!productIdRaw || (!suggestionIdRaw && !presetKey)) {
      return NextResponse.json(
        { success: false, message: 'productId and either suggestionId or presetKey are required' },
        { status: 400 }
      );
    }

    const productId = Number(productIdRaw);

    if (!Number.isInteger(productId)) {
      return NextResponse.json(
        { success: false, message: 'productId must be a valid integer' },
        { status: 400 }
      );
    }

    let suggestionId: number | null = null;

    if (suggestionIdRaw) {
      suggestionId = Number(suggestionIdRaw);

      if (!Number.isInteger(suggestionId)) {
        return NextResponse.json(
          { success: false, message: 'suggestionId must be a valid integer' },
          { status: 400 }
        );
      }
    }

    const productRows = await db.select().from(products).where(eq(products.id, productId)).limit(1);
    if (!productRows.length) {
      return NextResponse.json({ success: false, message: 'Product not found' }, { status: 404 });
    }
    const product = productRows[0];
    if (product.userId !== userId) {
      return NextResponse.json({ success: false, message: 'Product does not belong to this account' }, { status: 403 });
    }

    /*
    |------------------------------------------------------------------
    | Resolve the creative concept — dynamic suggestion takes priority
    | over the static preset catalog
    |------------------------------------------------------------------
    */

    let conceptTitle: string;
    let conceptPrompt: string;
    let conceptAspectRatio: string;
    let conceptRequiresOffer: boolean;
    let presetId: number | null = null;
    let presetKeyValue: string | null = null;

    if (suggestionId) {
      const suggestionRows = await db
        .select()
        .from(adSuggestions)
        .where(eq(adSuggestions.id, suggestionId))
        .limit(1);

      if (!suggestionRows.length) {
        return NextResponse.json({ success: false, message: 'Suggestion not found' }, { status: 404 });
      }

      const suggestion = suggestionRows[0];

      conceptTitle = suggestion.title;
      conceptPrompt = suggestion.promptModifier;
      conceptAspectRatio = suggestion.aspectRatio;
      conceptRequiresOffer = !!suggestion.requiresOffer;
    } else {
      const presetRows = await db
        .select()
        .from(adPresets)
        .where(eq(adPresets.presetKey, presetKey as string))
        .limit(1);

      if (!presetRows.length) {
        return NextResponse.json({ success: false, message: 'Preset not found' }, { status: 404 });
      }

      const preset = presetRows[0];

      conceptTitle = preset.name;
      conceptPrompt = preset.promptModifier;
      conceptAspectRatio = preset.aspectRatio;
      conceptRequiresOffer = !!preset.requiresOffer;
      presetId = preset.id;
      presetKeyValue = preset.presetKey;
    }

    if (conceptRequiresOffer && !price && !discount) {
      return NextResponse.json(
        { success: false, message: 'This concept requires price and/or discount info' },
        { status: 400 }
      );
    }

    if (!product.originalImageUrl) {
      return NextResponse.json({ success: false, message: 'Product has no source image' }, { status: 400 });
    }

    const relativeImagePath = product.originalImageUrl.replace(/^\/+/, '');
    const imagePath = path.join(process.cwd(), 'public', relativeImagePath);
    const imageBuffer = await fs.readFile(imagePath);
    const productBase64 = imageBuffer.toString('base64');

    let productMime = 'image/jpeg';
    const ext = path.extname(imagePath).toLowerCase();
    if (ext === '.png') productMime = 'image/png';
    if (ext === '.webp') productMime = 'image/webp';

    let logoBase64: string | null = null;
    let logoMime = 'image/png';
    let logoImageUrl: string | null = null;

    if (logoFile) {
      const logoDir = path.join(process.cwd(), 'public', 'uploads', 'logos');
      await fs.mkdir(logoDir, { recursive: true });

      // This is just a filename, not a DB id, so createId() is still fine here.
      const logoExt = logoFile.type === 'image/png' ? 'png' : logoFile.type === 'image/webp' ? 'webp' : 'jpg';
      const logoFileName = `${createId()}.${logoExt}`;
      const logoPath = path.join(logoDir, logoFileName);

      const logoBuffer = Buffer.from(await logoFile.arrayBuffer());
      await fs.writeFile(logoPath, logoBuffer);

      logoBase64 = logoBuffer.toString('base64');
      logoMime = logoFile.type;
      logoImageUrl = `/uploads/logos/${logoFileName}`;
    }

    const aspectRatio =
      (platform && PLATFORM_ASPECT_RATIO[platform] && conceptAspectRatio !== '9:16')
        ? PLATFORM_ASPECT_RATIO[platform]
        : conceptAspectRatio;

    /*
    |------------------------------------------------------------------
    | adCreatives.id is autoincrement int — insert without an id and
    | read the assigned id back from insertId.
    |------------------------------------------------------------------
    */

    const reservation = await reserveBannerGeneration(userId, {
      productId,
      presetId,
      presetKey: presetKeyValue || conceptTitle,
      suggestionId,
      platform,
      price,
      discount,
      phone,
      website,
      cta,
      logoImageUrl,
      status: 'processing',
    });
    if (!reservation.allowed) {
      return subscriptionDeniedResponse(reservation.access);
    }
    creativeId = reservation.creativeId;

    const prompt = buildAdPrompt({
      product,
      conceptPrompt,
      aspectRatio,
      overlay: { price, discount, phone, website, cta },
      hasLogo: !!logoBase64,
    });

    const parts: any[] = [
      { text: prompt },
      { inlineData: { mimeType: productMime, data: productBase64 } },
    ];

    if (logoBase64) {
      parts.push({ inlineData: { mimeType: logoMime, data: logoBase64 } });
    }

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio, imageSize: '1K' },
        },
      })
    );

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find((p: any) => p?.inlineData?.data);

    if (!imagePart?.inlineData?.data) {
      throw new Error(`Gemini returned no image. Finish reason: ${candidate?.finishReason || 'unknown'}`);
    }

    const generatedMime = imagePart.inlineData.mimeType || 'image/png';
    const outExt = generatedMime === 'image/jpeg' ? 'jpg' : generatedMime === 'image/webp' ? 'webp' : 'png';

    const adDir = path.join(process.cwd(), 'public', 'uploads', 'products', 'ads');
    await fs.mkdir(adDir, { recursive: true });

    const adFileName = `${productId}-${creativeId}.${outExt}`;
    const adFilePath = path.join(adDir, adFileName);

    await fs.writeFile(adFilePath, Buffer.from(imagePart.inlineData.data, 'base64'));

    const imageUrl = `/uploads/products/ads/${adFileName}`;

    await db.update(adCreatives).set({ imageUrl, status: 'done' }).where(eq(adCreatives.id, creativeId));

    return NextResponse.json({
      success: true,
      creative: {
        id: creativeId,
        title: conceptTitle,
        platform,
        aspectRatio,
        imageUrl,
        price,
        discount,
        phone,
        website,
        cta,
        logoImageUrl,
        status: 'done',
      },
    });
  } catch (error: any) {
    console.error('GENERATE AD ERROR:', error);

    if (creativeId) {
      try {
        await db
          .update(adCreatives)
          .set({ status: 'failed', error: error?.message || 'Ad generation failed' })
          .where(eq(adCreatives.id, creativeId));
      } catch (dbErr) {
        console.error('FAILED STATUS UPDATE:', dbErr);
      }
    }

    return NextResponse.json(
      { success: false, message: error?.message || 'Ad generation failed' },
      { status: 500 }
    );
  }
}