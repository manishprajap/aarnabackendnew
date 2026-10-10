import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, type Part } from "@google/genai";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/db";
import { AuthError, getUserIdFromRequest } from "@/lib/auth";
import { insertIdOf, rowsOf } from "@/lib/onboarding";
import { reserveBannerGeneration, subscriptionDeniedResponse } from "@/lib/subscriptionAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const IMAGE_MODEL = "gemini-3.1-flash-image";
const INITIAL_BANNER_PROMPT_TYPE = "onboarding_initial_banner";
const UPLOAD_DIR = path.join(process.cwd(), "upload");
const OUTPUT_DIR = path.join(process.cwd(), "public", "uploads", "products", "ads");
const MEDIA_ORIGIN = process.env.NEXT_PUBLIC_MEDIA_URL || "https://aarnexai.com";
const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY ?? "").trim() });

type Row = Record<string, unknown>;

const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function toFullUrl(value: unknown): string {
  const url = stringValue(value, 1000);
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${MEDIA_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}

function getLogoMimeType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

async function getAuthenticatedUserId(request: NextRequest): Promise<number> {
  const userId = Number(await getUserIdFromRequest(request));
  if (!Number.isInteger(userId) || userId <= 0) throw new AuthError("Unauthorized");
  return userId;
}

export async function GET(request: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId(request);
    const rows = rowsOf(await db.execute(sql`
      SELECT p.id AS plan_id, p.start_date, p.end_date,
             d.day_number, d.scheduled_date, d.topic_title, d.prompt, d.caption,
             d.hashtags, d.cta, d.image_prompt, d.status AS day_status,
             b.id AS banner_id, b.image_url AS banner_image_url,
             b.caption AS banner_caption, b.posted AS banner_posted
      FROM customer_marketing_plans p
      JOIN customer_marketing_days d ON d.marketing_plan_id = p.id
      LEFT JOIN products product
        ON product.user_id = p.customer_id
       AND product.prompt_type = ${INITIAL_BANNER_PROMPT_TYPE}
      LEFT JOIN banners b
        ON b.product_id = product.id
       AND b.day = d.day_number
      WHERE p.customer_id = ${userId}
        AND p.status <> 'CANCELLED'
        AND p.id = (
          SELECT id FROM customer_marketing_plans
          WHERE customer_id = ${userId} AND status <> 'CANCELLED'
          ORDER BY month_number DESC, id DESC LIMIT 1
        )
      ORDER BY d.day_number ASC
    `)) as Row[];

    if (!rows.length) return json({ success: true, plan: null, days: [] });
    const first = rows[0];

    return json({
      success: true,
      plan: {
        startDate: String(first.start_date).slice(0, 10),
        endDate: String(first.end_date).slice(0, 10),
      },
      days: rows.map((row) => ({
        day: Number(row.day_number),
        date: String(row.scheduled_date).slice(0, 10),
        theme: row.topic_title ?? null,
        prompt: row.prompt ?? null,
        caption: row.caption ?? null,
        hashtags: row.hashtags ?? null,
        cta: row.cta ?? null,
        imagePrompt: row.image_prompt ?? null,
        status: row.day_status ?? "PLANNED",
        banner: row.banner_id
          ? {
              id: Number(row.banner_id),
              imageUrl: toFullUrl(row.banner_image_url),
              caption: row.banner_caption,
              posted: row.banner_posted === true || Number(row.banner_posted) === 1,
            }
          : null,
      })),
    });
  } catch (error) {
    if (error instanceof AuthError) return json({ success: false, error: error.message }, 401);
    console.error("GET /api/marketing-calendar failed:", error);
    return json({ success: false, error: "Could not load the marketing calendar." }, 500);
  }
}

export async function POST(request: NextRequest) {
  let productId = 0;
  let creativeId: number | undefined;
  try {
    const userId = await getAuthenticatedUserId(request);
    const body = await request.json().catch(() => null) as { day?: unknown } | null;
    const day = Number(body?.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return json({ success: false, error: "Choose a valid plan date." }, 422);
    }
    if (!(process.env.GEMINI_API_KEY ?? "").trim()) {
      return json({ success: false, error: "GEMINI_API_KEY is not configured." }, 500);
    }

    const profile = rowsOf(await db.execute(sql`
      SELECT u.business_name, u.logo, u.website, u.city, u.state, u.country,
             bc.name AS category_name,
             d.scheduled_date, d.topic_title, d.prompt, d.caption, d.hashtags,
             d.cta, d.image_prompt,
             CASE WHEN u.automation_mode = 'MANUAL' THEN u.strategy_id ELSE d.strategy_id END AS strategy_id,
             ps.name AS strategy_name, ps.objective AS strategy_objective
      FROM users u
      LEFT JOIN business_categories bc ON bc.id = u.business_category_id
      JOIN customer_marketing_plans p ON p.customer_id = u.id AND p.status <> 'CANCELLED'
      JOIN customer_marketing_days d ON d.marketing_plan_id = p.id AND d.day_number = ${day}
      LEFT JOIN promotion_strategies ps
        ON ps.id = CASE WHEN u.automation_mode = 'MANUAL' THEN u.strategy_id ELSE d.strategy_id END
      WHERE u.id = ${userId}
        AND p.id = (
          SELECT id FROM customer_marketing_plans
          WHERE customer_id = ${userId} AND status <> 'CANCELLED'
          ORDER BY month_number DESC, id DESC LIMIT 1
        )
      LIMIT 1
    `))[0] as Row | undefined;

    if (!profile) return json({ success: false, error: "No planned content was found for that date." }, 404);

    const businessName = stringValue(profile.business_name, 190);
    const categoryName = stringValue(profile.category_name, 100);
    const strategyName = stringValue(profile.strategy_name, 100) || "AarnexAi AI-selected strategy";
    const strategyObjective = stringValue(profile.strategy_objective, 1000);
    const imagePrompt = stringValue(profile.image_prompt, 8000);
    if (!businessName || !imagePrompt) {
      return json({ success: false, error: "Business details or the campaign image prompt are missing." }, 409);
    }

    const claim = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
      const existingProduct = rowsOf(await tx.execute(sql`
        SELECT id, status,
               created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE) AS is_recent
        FROM products
        WHERE user_id = ${userId} AND prompt_type = ${INITIAL_BANNER_PROMPT_TYPE}
        ORDER BY id LIMIT 1
      `))[0] as Row | undefined;

      if (existingProduct) {
        const existingId = Number(existingProduct.id);
        const existingBanner = rowsOf(await tx.execute(sql`
          SELECT id, image_url FROM banners
          WHERE product_id = ${existingId} AND day = ${day}
          LIMIT 1
        `))[0] as Row | undefined;
        if (existingBanner) {
          return { productId: existingId, banner: existingBanner, complete: true, busy: false, previousStatus: String(existingProduct.status ?? "done") };
        }

        const isFreshProcessing = existingProduct.status === "processing"
          && (existingProduct.is_recent === true || Number(existingProduct.is_recent) === 1);
        if (isFreshProcessing) return { productId: existingId, banner: null, complete: false, busy: true, previousStatus: String(existingProduct.status ?? "done") };

        await tx.execute(sql`
          UPDATE products SET status = 'processing', created_at = NOW()
          WHERE id = ${existingId} AND user_id = ${userId}
        `);
        const previousStatus = existingProduct.status === "processing"
          ? "failed"
          : String(existingProduct.status ?? "done");
        return { productId: existingId, banner: null, complete: false, busy: false, previousStatus };
      }

      const insert = await tx.execute(sql`
        INSERT INTO products (user_id, original_image_url, title, description, category, prompt_type, status)
        VALUES (
          ${userId}, ${`/uploads/products/ads/onboarding-pending-${userId}.png`},
          ${businessName}, ${`Marketing calendar banner for ${businessName}`},
          ${categoryName || null}, ${INITIAL_BANNER_PROMPT_TYPE}, 'processing'
        )
      `);
      const id = insertIdOf(insert);
      if (!id) throw new Error("Could not reserve the calendar banner.");
      return { productId: id, banner: null, complete: false, busy: false, previousStatus: "failed" };
    });

    productId = claim.productId;
    if (claim.complete) {
      return json({
        success: true,
        alreadyGenerated: true,
        banner: { id: Number(claim.banner?.id), imageUrl: toFullUrl(claim.banner?.image_url) },
      });
    }
    if (claim.busy) {
      return json({ success: false, error: "A banner is already being generated. Please wait a moment." }, 409);
    }

    const reservation = await reserveBannerGeneration(userId, {
      productId,
      presetId: null,
      suggestionId: null,
      presetKey: `marketing_calendar_day_${day}`,
      platform: "calendar",
      price: null,
      discount: null,
      phone: null,
      website: null,
      cta: stringValue(profile.cta, 128) || null,
      logoImageUrl: null,
      status: "processing",
    });
    if (!reservation.allowed) {
      await db.execute(sql`
        UPDATE products SET status = ${claim.previousStatus}
        WHERE id = ${productId} AND user_id = ${userId}
      `);
      return subscriptionDeniedResponse(reservation.access);
    }
    creativeId = reservation.creativeId;

    const logoFileName = stringValue(profile.logo, 255).replace(/\\/g, "/").split("/").pop() ?? "";
    let logo: Buffer | null = null;
    let logoMimeType = "";
    if (logoFileName) {
      logo = await readFile(path.join(UPLOAD_DIR, path.basename(logoFileName)));
      logoMimeType = getLogoMimeType(logoFileName);
    }

    const prompt = [
      "Create one polished, professional social-media marketing banner for this business.",
      `Business name (spell exactly): ${businessName}`,
      `Business category: ${categoryName}`,
      `Selected promotion strategy: ${strategyName}${strategyObjective ? ` — ${strategyObjective}` : ""}`,
      `Campaign topic: ${stringValue(profile.topic_title, 255)}`,
      `Campaign creative direction: ${imagePrompt}`,
      `Business location: ${[profile.city, profile.state, profile.country].map((value) => stringValue(value, 100)).filter(Boolean).join(", ")}`,
      "Use a clean square 1:1 social-media layout with readable typography and clear visual hierarchy.",
      "Use the exact business name and preserve the supplied logo as-is; do not redraw, distort, or replace it.",
      "Do not invent prices, discounts, contact details, product claims, or additional brand names.",
    ].filter(Boolean).join("\n");
    const parts: Part[] = [{ text: prompt }];
    if (logo) parts.push({ inlineData: { mimeType: logoMimeType, data: logo.toString("base64") } });

    const generated = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: "user", parts }],
      config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } },
    });
    const imagePart = generated.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      throw new Error(`Gemini returned no banner image. Finish reason: ${generated.candidates?.[0]?.finishReason ?? "unknown"}`);
    }

    const mimeType = imagePart.inlineData.mimeType || "image/png";
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const fileName = `calendar-${userId}-${day}-${randomUUID()}.${extension}`;
    const imageUrl = `/uploads/products/ads/${fileName}`;
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(OUTPUT_DIR, fileName), Buffer.from(imagePart.inlineData.data, "base64"), { flag: "wx" });

    const caption = [
      stringValue(profile.caption, 4000),
      stringValue(profile.hashtags, 1000),
    ].filter(Boolean).join("\n\n");
    const banner = await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE products
        SET original_image_url = ${imageUrl}, title = ${businessName},
            description = ${imagePrompt}, category = ${categoryName || null}, status = 'done'
        WHERE id = ${productId} AND user_id = ${userId}
      `);
      const result = await tx.execute(sql`
        INSERT INTO banners (product_id, day, theme, image_url, caption, posted)
        VALUES (${productId}, ${day}, ${stringValue(profile.topic_title, 100) || strategyName}, ${imageUrl}, ${caption || null}, false)
      `);
      const bannerId = insertIdOf(result);
      if (!bannerId) throw new Error("Could not save the generated calendar banner.");
      await tx.execute(sql`
        UPDATE ad_creatives SET status = 'done', image_url = ${imageUrl}
        WHERE id = ${creativeId} AND product_id = ${productId}
      `);
      await tx.execute(sql`
        UPDATE customer_marketing_days
        SET status = 'GENERATED'
        WHERE marketing_plan_id = (
          SELECT id FROM customer_marketing_plans
          WHERE customer_id = ${userId} AND status <> 'CANCELLED'
          ORDER BY month_number DESC, id DESC LIMIT 1
        ) AND day_number = ${day}
      `);
      return { id: bannerId, imageUrl };
    });

    return json({ success: true, banner: { ...banner, imageUrl: toFullUrl(banner.imageUrl) } });
  } catch (error) {
    if (error instanceof AuthError) return json({ success: false, error: error.message }, 401);
    if (creativeId) {
      try {
        await db.execute(sql`
          UPDATE ad_creatives SET status = 'failed', error = ${error instanceof Error ? error.message : "Banner generation failed"}
          WHERE id = ${creativeId}
        `);
      } catch (markError) {
        console.error("Could not mark calendar creative as failed:", markError);
      }
    }
    if (productId) {
      try {
        await db.execute(sql`
          UPDATE products SET status = 'failed'
          WHERE id = ${productId} AND prompt_type = ${INITIAL_BANNER_PROMPT_TYPE}
        `);
      } catch (markError) {
        console.error("Could not mark calendar banner generation as failed:", markError);
      }
    }
    console.error("POST /api/marketing-calendar failed:", error);
    return json({ success: false, error: "Could not generate the banner. Please try again." }, 500);
  }
}
