import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, type Part } from "@google/genai";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/db";
import { AuthError, getUserIdFromRequest } from "@/lib/auth";
import { insertIdOf, rowsOf } from "@/lib/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY ?? "").trim() });
const IMAGE_MODEL = "gemini-3.1-flash-image";
const INITIAL_BANNER_PROMPT_TYPE = "onboarding_initial_banner";
const UPLOAD_DIR = path.join(process.cwd(), "upload");
const OUTPUT_DIR = path.join(process.cwd(), "public", "uploads", "products", "ads");

type Row = Record<string, unknown>;

const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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

export async function POST(request: NextRequest) {
  let productId = 0;

  try {
    let userId: number;
    try {
      userId = Number(await getUserIdFromRequest(request));
    } catch (error) {
      if (error instanceof AuthError) return json({ success: false, error: "Unauthorized" }, 401);
      throw error;
    }
    if (!Number.isInteger(userId) || userId <= 0) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }
    if (!(process.env.GEMINI_API_KEY ?? "").trim()) {
      return json({ success: false, error: "GEMINI_API_KEY is not configured." }, 500);
    }

    const profile = rowsOf(await db.execute(sql`
      SELECT u.business_name, u.logo, u.website, u.city, u.state, u.country,
             bc.name AS category_name,
             d.topic_title, d.prompt, d.caption, d.hashtags, d.cta, d.image_prompt,
             CASE WHEN u.automation_mode = 'MANUAL' THEN u.strategy_id ELSE d.strategy_id END AS strategy_id,
             ps.name AS strategy_name, ps.objective AS strategy_objective
      FROM users u
      JOIN business_categories bc ON bc.id = u.business_category_id
      JOIN customer_marketing_plans p ON p.customer_id = u.id
      JOIN customer_marketing_days d ON d.marketing_plan_id = p.id AND d.day_number = 1
      LEFT JOIN promotion_strategies ps
        ON ps.id = CASE WHEN u.automation_mode = 'MANUAL' THEN u.strategy_id ELSE d.strategy_id END
      WHERE u.id = ${userId}
      ORDER BY p.month_number DESC, p.id DESC
      LIMIT 1
    `))[0] as Row | undefined;

    if (!profile) {
      return json({ success: false, error: "Generate the 30-day marketing plan before creating the first banner." }, 409);
    }

    const businessName = stringValue(profile.business_name, 190);
    const categoryName = stringValue(profile.category_name, 100);
    const strategyName = stringValue(profile.strategy_name, 100) || "AarnexAi AI-selected strategy";
    const strategyObjective = stringValue(profile.strategy_objective, 1000);
    const imagePrompt = stringValue(profile.image_prompt, 8000);
    if (!businessName || !imagePrompt) {
      return json({ success: false, error: "Business details or the first-day image prompt are missing." }, 409);
    }

    const claim = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
      const existing = rowsOf(await tx.execute(sql`
        SELECT id, status,
               created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE) AS is_recent
        FROM products
        WHERE user_id = ${userId} AND prompt_type = ${INITIAL_BANNER_PROMPT_TYPE}
        ORDER BY id
        LIMIT 1
      `))[0] as Row | undefined;

      if (existing) {
        const existingProductId = Number(existing.id);
        const banner = rowsOf(await tx.execute(sql`
          SELECT id, image_url FROM banners
          WHERE product_id = ${existingProductId} AND day = 1
          LIMIT 1
        `))[0] as Row | undefined;
        if (banner) {
          return { productId: existingProductId, banner, complete: true, busy: false };
        }

        const isFreshProcessing =
          existing.status === "processing" &&
          (existing.is_recent === true || Number(existing.is_recent) === 1);
        if (isFreshProcessing) {
          return { productId: existingProductId, banner: null, complete: false, busy: true };
        }

        await tx.execute(sql`
          UPDATE products SET status = 'processing', created_at = NOW()
          WHERE id = ${existingProductId} AND user_id = ${userId}
        `);
        return { productId: existingProductId, banner: null, complete: false, busy: false };
      }

      const placeholderImage = `/uploads/products/ads/onboarding-pending-${userId}.png`;
      const insert = await tx.execute(sql`
        INSERT INTO products (user_id, original_image_url, title, description, category, prompt_type, status)
        VALUES (
          ${userId}, ${placeholderImage}, ${businessName},
          ${`Initial business banner for ${businessName}`}, ${categoryName},
          ${INITIAL_BANNER_PROMPT_TYPE}, 'processing'
        )
      `);
      const id = insertIdOf(insert);
      if (!id) throw new Error("Could not reserve the initial banner.");
      return { productId: id, banner: null, complete: false, busy: false };
    });

    productId = claim.productId;
    if (claim.complete) {
      return json({
        success: true,
        alreadyGenerated: true,
        bannerId: Number(claim.banner?.id),
        imageUrl: claim.banner?.image_url,
      });
    }
    if (claim.busy) {
      return json({ success: false, error: "The initial banner is already being generated. Please wait a moment and try again." }, 409);
    }

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
      `First-day campaign topic: ${stringValue(profile.topic_title, 255)}`,
      `Campaign creative direction: ${imagePrompt}`,
      `Business location: ${[profile.city, profile.state, profile.country].map((value) => stringValue(value, 100)).filter(Boolean).join(", ")}`,
      "Use a clean square 1:1 social-media layout with readable typography and a clear visual hierarchy.",
      "Use the exact business name and preserve the supplied logo as-is; do not redraw, distort, or replace it.",
      "Do not invent prices, discounts, contact details, product claims, or additional brand names.",
    ].filter(Boolean).join("\n");

    const parts: Part[] = [{ text: prompt }];
    if (logo) {
      parts.push({
        inlineData: { mimeType: logoMimeType, data: logo.toString("base64") },
      });
    }

    const generated = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
      },
    });
    const imagePart = generated.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      throw new Error(`Gemini returned no initial banner image. Finish reason: ${generated.candidates?.[0]?.finishReason ?? "unknown"}`);
    }

    const mimeType = imagePart.inlineData.mimeType || "image/png";
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const fileName = `onboarding-${userId}-${randomUUID()}.${extension}`;
    const imageUrl = `/uploads/products/ads/${fileName}`;
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(OUTPUT_DIR, fileName), Buffer.from(imagePart.inlineData.data, "base64"), { flag: "wx" });

    const captionParts = [
      stringValue(profile.caption, 4000),
      stringValue(profile.hashtags, 1000),
    ].filter(Boolean);
    const caption = captionParts.join("\n\n");

    const bannerId = await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE products
        SET original_image_url = ${imageUrl}, title = ${businessName},
            description = ${imagePrompt}, category = ${categoryName}, status = 'done'
        WHERE id = ${productId} AND user_id = ${userId}
      `);
      const result = await tx.execute(sql`
        INSERT INTO banners (product_id, day, theme, image_url, caption, posted)
        VALUES (
          ${productId}, 1, ${strategyName}, ${imageUrl}, ${caption || null}, false
        )
      `);
      const id = insertIdOf(result);
      if (!id) throw new Error("Could not save the initial banner.");
      return id;
    });

    return json({ success: true, bannerId, imageUrl });
  } catch (error) {
    if (productId) {
      try {
        await db.execute(sql`
          UPDATE products SET status = 'failed'
          WHERE id = ${productId} AND prompt_type = ${INITIAL_BANNER_PROMPT_TYPE}
        `);
      } catch (markError) {
        console.error("Could not mark initial banner generation as failed:", markError);
      }
    }
    console.error("POST /api/business/initial-banner failed:", error);
    return json({ success: false, error: "Could not generate the initial business banner. Please try again." }, 500);
  }
}
