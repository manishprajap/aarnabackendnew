import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, type Part } from "@google/genai";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/db";
import { AuthError, getUserIdFromRequest } from "@/lib/auth";
import { ensureColumns, insertIdOf, rowsOf } from "@/lib/onboarding";
import {
  getPoliticalBannerInstructions,
  isPoliticalCategory,
  isProfessionalPortraitCategory,
  validatePoliticianPortrait,
} from "@/lib/politicalBanner";
import { getProfessionalBannerInstructions, readProfessionalBannerPhoto } from "@/lib/businessBanner";
import { getBannerLanguageInstructions, normalizeBannerLanguage } from "@/lib/bannerLanguage";
import {
  addBusinessContactOverlay,
  addFestivalGreetingOverlay,
  detectFestival,
  getFestivalBannerInstructions,
} from "@/lib/festivalBanner";
import {
  getUploadPublicPath,
  getUploadStoragePath,
  migrateLegacyGeneratedAdImage,
  UPLOAD_BASE_DIR,
} from "@/lib/uploadStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY ?? "").trim() });
const IMAGE_MODEL = "gemini-3.1-flash-image";
const INITIAL_BANNER_PROMPT_TYPE = "onboarding_initial_banner";
const UPLOAD_DIR = getUploadStoragePath();
const OUTPUT_DIR = getUploadStoragePath("products", "ads");

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
    await ensureColumns("users", {
      business_address: "VARCHAR(500) NULL",
      professional_photo: "VARCHAR(255) NULL",
      banner_language: "VARCHAR(16) NOT NULL DEFAULT 'English'",
    });
    let portrait: File | null;
    try {
      const formData = request.headers.get("content-type")?.includes("multipart/form-data")
        ? await request.formData()
        : null;
      portrait = validatePoliticianPortrait(formData?.get("portrait") ?? null);
    } catch (error) {
      return json({ success: false, error: error instanceof Error ? error.message : "Invalid politician portrait." }, 422);
    }

    const profile = rowsOf(await db.execute(sql`
      SELECT u.business_name, u.logo, u.website, u.city, u.state, u.country,
             u.mobile, u.business_address, u.professional_photo, u.banner_language,
             i.name AS industry_name,
             bc.name AS category_name,
             d.scheduled_date, d.topic_title, d.prompt, d.caption, d.hashtags, d.cta, d.image_prompt,
             CASE WHEN u.automation_mode = 'MANUAL' THEN u.strategy_id ELSE d.strategy_id END AS strategy_id,
             ps.name AS strategy_name, ps.objective AS strategy_objective
      FROM users u
      JOIN business_categories bc ON bc.id = u.business_category_id
      LEFT JOIN industries i ON i.id = bc.industry_id
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
    const bannerLanguage = normalizeBannerLanguage(profile.banner_language);
    const professionalCategory = isProfessionalPortraitCategory(`${stringValue(profile.industry_name, 100)} ${categoryName}`);
    const politicalCategory = isPoliticalCategory(`${stringValue(profile.industry_name, 100)} ${categoryName}`);
    const topic = [
      profile.topic_title,
      profile.prompt,
      profile.caption,
      profile.hashtags,
      profile.image_prompt,
    ].map((value) => stringValue(value, 8000)).join("\n");
    const festival = detectFestival(profile.scheduled_date, topic);
    let professionalPhoto: { buffer: Buffer; mimeType: string } | null = null;
    if (professionalCategory) {
      professionalPhoto = portrait
        ? { buffer: Buffer.from(await portrait.arrayBuffer()), mimeType: portrait.type }
        : await readProfessionalBannerPhoto(userId, profile.professional_photo);
      if (!professionalPhoto) {
        return json({ success: false, error: "Upload a professional photo in Business Setup before creating this banner." }, 422);
      }
    }
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

      const placeholderImage = getUploadPublicPath("products", "ads", `onboarding-pending-${userId}.png`);
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
        imageUrl: await migrateLegacyGeneratedAdImage(claim.banner?.image_url),
      });
    }
    if (claim.busy) {
      return json({ success: false, error: "The initial banner is already being generated. Please wait a moment and try again." }, 409);
    }

    const logoFileName = stringValue(profile.logo, 255).replace(/\\/g, "/").split("/").pop() ?? "";
    let logo: Buffer | null = null;
    let logoMimeType = "";
    if (logoFileName) {
      try {
        logo = await readFile(path.join(UPLOAD_DIR, path.basename(logoFileName)));
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        logo = await readFile(path.join(UPLOAD_BASE_DIR, "upload", path.basename(logoFileName)));
      }
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
      ...(professionalCategory ? getProfessionalBannerInstructions(`${stringValue(profile.industry_name, 100)} ${categoryName}`) : []),
      ...getBannerLanguageInstructions(bannerLanguage),
      ...(festival ? getFestivalBannerInstructions(festival, bannerLanguage) : []),
      ...(politicalCategory ? getPoliticalBannerInstructions(stringValue(profile.topic_title, 255)) : []),
      "Use a clean square 1:1 social-media layout with readable typography and a clear visual hierarchy.",
      "Use the exact business name and preserve the supplied logo as-is; do not redraw, distort, or replace it.",
      "Do not invent prices, discounts, contact details, product claims, or additional brand names.",
    ].filter(Boolean).join("\n");

    const parts: Part[] = [{ text: prompt }];
    if (professionalPhoto) {
      parts.push({
        inlineData: { mimeType: professionalPhoto.mimeType, data: professionalPhoto.buffer.toString("base64") },
      });
    }
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

    const rawImage = Buffer.from(imagePart.inlineData.data, "base64");
    const festivalImage = festival ? await addFestivalGreetingOverlay(rawImage, festival, bannerLanguage) : rawImage;
    const address = [
      stringValue(profile.business_address, 500),
      stringValue(profile.city, 100),
      stringValue(profile.state, 100),
      stringValue(profile.country, 100),
    ].filter(Boolean).join(", ");
    const imageBuffer = professionalCategory
      ? await addBusinessContactOverlay(festivalImage, {
          mobile: stringValue(profile.mobile, 24),
          address,
          language: bannerLanguage,
        })
      : festivalImage;
    const mimeType = imagePart.inlineData.mimeType || "image/png";
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const fileName = `onboarding-${userId}-${randomUUID()}.${extension}`;
    const imageUrl = getUploadPublicPath("products", "ads", fileName);
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(OUTPUT_DIR, fileName), imageBuffer, { flag: "wx" });

    const captionParts = [
      festival ? `${festival.greeting} · ${festival.hindiGreeting}` : "",
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
        ${productId}, 1, ${festival?.name || strategyName}, ${imageUrl}, ${caption || null}, false
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
