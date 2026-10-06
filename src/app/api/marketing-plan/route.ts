// src/app/api/marketing-plan/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { getUserIdFromRequest, AuthError } from "@/lib/auth";
import {
  HttpError,
  rowsOf,
  insertIdOf,
  ensureSchema,
  idByName,
  findTopicId,
  type Named,
} from "@/lib/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* ========================= CONFIG ========================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const GEMINI_TIMEOUT_MS = 150_000;
const GEMINI_MAX_ATTEMPTS = 2;
const TOTAL_DAYS = 30;

// Must match the MySQL ENUMs on customer_marketing_days
const CONTENT_TYPES = ["IMAGE", "VIDEO", "CAROUSEL", "TEXT", "REEL", "STORY"] as const;
const PLATFORMS = [
  "FACEBOOK", "INSTAGRAM", "THREADS", "WHATSAPP", "GOOGLE_BUSINESS", "MULTI_PLATFORM",
] as const;

/* ========================= TYPES ========================= */

type GeneratedDay = {
  day: number;
  topic: string;
  service: string;
  strategy: string;
  content_type: string;
  platform: string;
  scheduled_date: string;
  prompt: string;
  caption: string;
  hashtags: string;
  cta: string;
  image_prompt: string;
  service_id: number | null;
  strategy_id: number | null;
  topic_id: number | null;
};

/* ========================= RESPONSE ========================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/* ========================= HELPERS ========================= */

function cleanString(value: unknown, maxLength = 5000): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeHashtags(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(" ").slice(0, 2000);
  }
  return cleanString(value, 2000);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeDate(value?: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return todayUtc();
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return todayUtc();
  return date.toISOString().slice(0, 10) === value ? value : todayUtc();
}

/** All date math in UTC so IST servers don't shift dates by one day. */
function addDays(startDate: string, offset: number): string {
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function getAuthenticatedUserId(request: NextRequest): Promise<number | null> {
  try {
    return positiveInt(await getUserIdFromRequest(request));
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}

/* ========================= PROMPT ========================= */

function buildMasterPrompt(input: {
  businessName: string;
  ownerName: string;
  email: string;
  phone: string;
  website: string;
  country: string;
  state: string;
  city: string;
  industry: string;
  category: string;
  services: string[];
  targets: string[];
  strategyNames: string[];
  marketingGoal: string;
  automationMode: string;
  strategy: string;
  customPrompt: string;
  startDate: string;
}) {
  const list = (items: string[], fallback: string) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${fallback}`;

  return `
You are the marketing planning engine for AarnexAI, an AI marketing OS for small and medium businesses.

Create a practical ${TOTAL_DAYS}-day social-media marketing calendar.

BUSINESS
Business name: ${input.businessName}
Owner / Contact: ${input.ownerName}
Email: ${input.email || "N/A"}
Phone: ${input.phone || "N/A"}
Website: ${input.website || "N/A"}
Industry: ${input.industry}
Business category: ${input.category}
Country: ${input.country}
State: ${input.state || "N/A"}
City: ${input.city || "N/A"}

SELECTED PRODUCTS / SERVICES
${list(input.services, "Not specified")}

SELECTED TARGET CUSTOMERS
${list(input.targets, "General customers")}

MARKETING GOAL
${input.marketingGoal}

AUTOMATION MODE
${input.automationMode}

MONTHLY PROMOTION STRATEGY
${input.strategy}

AVAILABLE STRATEGY NAMES (the "strategy" field must be exactly one of these)
${list(input.strategyNames, "Not specified")}

CUSTOM CUSTOMER INSTRUCTIONS
${input.customPrompt || "No additional instructions."}

START DATE
${input.startDate}

RULES
1. Produce exactly ${TOTAL_DAYS} days, numbered 1 to ${TOTAL_DAYS}.
2. Use only the supplied services/products; the "service" field must be exactly one of them.
3. Rotate the selected services/products across the month.
4. Target the selected customer groups.
5. Avoid repeating the same topic or sales angle.
6. Mix awareness, education, trust, FAQs, problem/solution, promotion and lead generation.
7. If MANUAL, keep the selected monthly strategy as the main focus.
8. If AUTO, intelligently choose the best strategy for each day.
9. Captions must be ready to publish.
10. Hashtags must be relevant and not spammy.
11. Use a clear CTA such as WhatsApp, Call, Book Now, Learn More, Get Quote or Visit Store.
12. image_prompt must describe a realistic marketing creative that can later be sent to an image model.
13. Localize examples to the city where useful.
14. Do not make unsupported medical, legal, financial or performance guarantees.
15. content_type must be one of: ${CONTENT_TYPES.join(", ")}.
16. platform must be one of: ${PLATFORMS.join(", ")}.
17. scheduled_date must be YYYY-MM-DD, starting at ${input.startDate}, one per day.

Return ONLY valid JSON with exactly ${TOTAL_DAYS} items in "days".
`.trim();
}

/* ========================= GEMINI ========================= */

function extractJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(cleaned.slice(first, last + 1));
  }
  throw new Error("Gemini returned invalid JSON.");
}

const DAY_SCHEMA = {
  type: "OBJECT",
  properties: {
    day: { type: "INTEGER" },
    topic: { type: "STRING" },
    service: { type: "STRING" },
    strategy: { type: "STRING" },
    content_type: { type: "STRING", enum: [...CONTENT_TYPES] },
    platform: { type: "STRING", enum: [...PLATFORMS] },
    scheduled_date: { type: "STRING" },
    prompt: { type: "STRING" },
    caption: { type: "STRING" },
    hashtags: { type: "ARRAY", items: { type: "STRING" } },
    cta: { type: "STRING" },
    image_prompt: { type: "STRING" },
  },
  required: [
    "day", "topic", "service", "strategy", "content_type", "platform",
    "scheduled_date", "prompt", "caption", "hashtags", "cta", "image_prompt",
  ],
};

async function callGemini(masterPrompt: string): Promise<unknown> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: masterPrompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 65536,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                plan_name: { type: "STRING" },
                monthly_strategy: { type: "STRING" },
                summary: { type: "STRING" },
                days: { type: "ARRAY", items: DAY_SCHEMA },
              },
              required: ["days"],
            },
          },
        }),
      }
    );

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini API error ${response.status}: ${responseText.slice(0, 1000)}`);
    }

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error("Gemini returned an invalid API response.");
    }

    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new Error("Gemini output was truncated (MAX_TOKENS).");
    }

    const text = candidate?.content?.parts?.map((p: any) => p?.text || "").join("") || "";
    if (!text) throw new Error("Gemini returned an empty response.");

    return extractJson(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Shape check only; catalog IDs are resolved afterwards. */
function validateGeneratedDays(value: any): any[] {
  if (!value || !Array.isArray(value.days)) {
    throw new Error("Gemini response does not contain a days array.");
  }
  if (value.days.length !== TOTAL_DAYS) {
    throw new Error(`Gemini generated ${value.days.length} days instead of ${TOTAL_DAYS}.`);
  }
  return [...value.days].sort((a: any, b: any) => (Number(a?.day) || 0) - (Number(b?.day) || 0));
}

async function generatePlanDays(masterPrompt: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await callGemini(masterPrompt);
      return { rawDays: validateGeneratedDays(raw), raw: raw as any };
    } catch (error) {
      lastError = error;
      console.error(`Gemini attempt ${attempt} failed:`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Gemini generation failed.");
}

/**
 * Maps Gemini output to catalog IDs:
 *  - service  -> services.id (fallback: rotate through selected services)
 *  - strategy -> promotion_strategies.id (fallback: plan strategy)
 *  - topic    -> marketing_topics.id (nullable)
 *  - enums validated, dates computed on the server
 */
async function normalizeDays(
  rawDays: any[],
  startDate: string,
  ctx: {
    categoryId: number;
    services: Named[];
    strategies: Named[];
    planStrategyId: number | null;
  }
): Promise<GeneratedDay[]> {
  const out: GeneratedDay[] = [];

  for (let index = 0; index < rawDays.length; index++) {
    const item = rawDays[index];
    const day = index + 1;

    const serviceName = cleanString(item?.service, 500);
    const serviceId =
      idByName(ctx.services, serviceName) ?? ctx.services[index % ctx.services.length].id;
    const serviceLabel = ctx.services.find((s) => s.id === serviceId)?.name ?? serviceName;

    const strategyName = cleanString(item?.strategy, 500);
    const strategyId = idByName(ctx.strategies, strategyName) ?? ctx.planStrategyId;

    const topic = cleanString(item?.topic, 255) || `Day ${day} Marketing Content`;
    const topicId = await findTopicId(db, ctx.categoryId, serviceId, strategyId, topic);

    const contentType = cleanString(item?.content_type, 50).toUpperCase();
    const platform = cleanString(item?.platform, 50).toUpperCase();

    out.push({
      day,
      topic,
      service: serviceLabel,
      strategy: strategyName,
      content_type: (CONTENT_TYPES as readonly string[]).includes(contentType) ? contentType : "IMAGE",
      platform: (PLATFORMS as readonly string[]).includes(platform) ? platform : "INSTAGRAM",
      scheduled_date: addDays(startDate, index),
      prompt: cleanString(item?.prompt, 10000),
      caption: cleanString(item?.caption, 10000),
      hashtags: normalizeHashtags(item?.hashtags),
      cta: cleanString(item?.cta, 190),
      image_prompt: cleanString(item?.image_prompt, 10000),
      service_id: serviceId,
      strategy_id: strategyId,
      topic_id: topicId,
    });
  }
  return out;
}

/* ========================= POST ========================= */

export async function POST(request: NextRequest) {
  let planId = 0;
  let promptLogId = 0;

  // On failure the GENERATING placeholder row (status DRAFT) is removed,
  // or marked CANCELLED if it cannot be deleted.
  const markFailed = async (message: string) => {
    const msg = message.slice(0, 1000);
    try {
      if (promptLogId) {
        await db.execute(sql`
          UPDATE customer_marketing_prompts
          SET status = 'FAILED', error_message = ${msg}, updated_at = NOW()
          WHERE id = ${promptLogId}
        `);
      }
    } catch (e) {
      console.error("Could not mark prompt log as failed:", e);
    }
    if (!planId) return;
    try {
      await db.execute(sql`
        DELETE FROM customer_marketing_plans WHERE id = ${planId} AND status = 'DRAFT'
      `);
    } catch {
      try {
        await db.execute(sql`
          UPDATE customer_marketing_plans SET status = 'CANCELLED', updated_at = NOW()
          WHERE id = ${planId}
        `);
      } catch (e) {
        console.error("Could not close failed plan:", e);
      }
    }
  };

  try {
    /* ---------- AUTH ---------- */
    const userId = await getAuthenticatedUserId(request);
    if (!userId) return json({ success: false, error: "Unauthorized" }, 401);
    await ensureSchema();

    /* ---------- BODY (optional overrides only) ---------- */
    let body: { startDate?: string; customPrompt?: string } = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    /* ---------- LOAD SAVED PROFILE (users table) ---------- */
    const customer = rowsOf(
      await db.execute(sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`)
    )[0];

    if (!customer || !customer.business_name || !customer.business_category_id) {
      return json({ success: false, error: "Complete onboarding first." }, 409);
    }
    if (!customer.marketing_goal) {
      return json({ success: false, error: "Marketing goal is missing. Complete onboarding again." }, 409);
    }

    // customer_id everywhere == users.id
    const customerId = Number(customer.id);
    const categoryId = Number(customer.business_category_id);

    const names = rowsOf(
      await db.execute(sql`
        SELECT i.name AS industry, bc.name AS category
        FROM business_categories bc
        JOIN industries i ON i.id = bc.industry_id
        WHERE bc.id = ${categoryId} LIMIT 1
      `)
    )[0];
    if (!names) return json({ success: false, error: "Business category no longer exists." }, 409);

    /* ---------- SAVED SERVICES / TARGETS (by ID, joined to names) ---------- */
    const services: Named[] = rowsOf(
      await db.execute(sql`
        SELECT s.id, s.name
        FROM customer_services cs
        JOIN services s ON s.id = cs.service_id
        WHERE cs.customer_id = ${customerId} AND s.status = 'ACTIVE'
        ORDER BY cs.is_primary DESC, s.name
      `)
    ).map((r) => ({ id: Number(r.id), name: String(r.name) }));

    const targets: Named[] = rowsOf(
      await db.execute(sql`
        SELECT t.id, t.name
        FROM customer_target_customers ct
        JOIN target_customers t ON t.id = ct.target_customer_id
        WHERE ct.customer_id = ${customerId} AND t.status = 'ACTIVE'
        ORDER BY ct.is_primary DESC, t.name
      `)
    ).map((r) => ({ id: Number(r.id), name: String(r.name) }));

    if (!services.length) {
      return json({ success: false, error: "No saved services. Complete onboarding again." }, 409);
    }
    if (!targets.length) {
      return json({ success: false, error: "No saved target customers. Complete onboarding again." }, 409);
    }

    /* ---------- STRATEGY (promotion_strategies) ---------- */
    const automationMode = customer.automation_mode === "MANUAL" ? "MANUAL" : "AUTO";

    const allStrategies: Named[] = rowsOf(
      await db.execute(sql`
        SELECT id, name FROM promotion_strategies
        WHERE status = 'ACTIVE' ORDER BY strategy_order, name
      `)
    ).map((r) => ({ id: Number(r.id), name: String(r.name) }));

    let planStrategyId: number | null = null;
    let strategyText =
      "AUTO - choose and rotate suitable strategies (educational, promotional, engagement, lead generation) across the month.";

    if (customer.strategy_id) {
      const s = rowsOf(
        await db.execute(sql`
          SELECT id, name, objective FROM promotion_strategies
          WHERE id = ${Number(customer.strategy_id)} AND status = 'ACTIVE' LIMIT 1
        `)
      )[0];
      if (s) {
        planStrategyId = Number(s.id);
        strategyText = `${s.name} — ${s.objective}`;
      }
    }
    if (automationMode === "MANUAL" && !planStrategyId) {
      return json({ success: false, error: "Select a promotion strategy for MANUAL mode." }, 409);
    }

    const customPrompt = body.customPrompt
      ? cleanString(body.customPrompt, 10000)
      : cleanString(customer.custom_prompt, 10000);
    const startDate = safeDate(body.startDate);
    const endDate = addDays(startDate, TOTAL_DAYS - 1);
    const marketingGoal = String(customer.marketing_goal);

    const masterPrompt = buildMasterPrompt({
      businessName: String(customer.business_name),
      ownerName: String(customer.name || ""),
      email: String(customer.email || ""),
      phone: String(customer.mobile || ""),
      website: String(customer.website || ""),
      country: String(customer.country || "India"),
      state: String(customer.state || ""),
      city: String(customer.city || ""),
      industry: String(names.industry),
      category: String(names.category),
      services: services.map((s) => s.name),
      targets: targets.map((t) => t.name),
      strategyNames: allStrategies.map((s) => s.name),
      marketingGoal,
      automationMode,
      strategy: strategyText,
      customPrompt,
      startDate,
    });

    /* ---------- TRANSACTION 1: guard + month number + plan row ---------- */
    const { monthNumber, planName } = await db.transaction(async (tx) => {
      // lock the user row so two parallel requests cannot create the same month
      await tx.execute(sql`SELECT id FROM users WHERE id = ${customerId} FOR UPDATE`);

      // DRAFT = "currently generating" (plans ENUM: DRAFT/ACTIVE/COMPLETED/CANCELLED)
      const running = rowsOf(
        await tx.execute(sql`
          SELECT id FROM customer_marketing_plans
          WHERE customer_id = ${customerId}
            AND status = 'DRAFT'
            AND created_at > (NOW() - INTERVAL 10 MINUTE)
          LIMIT 1
        `)
      )[0];
      if (running) {
        throw new HttpError("A marketing plan is already being generated. Please wait.", 409);
      }

      const monthRow = rowsOf(
        await tx.execute(sql`
          SELECT COALESCE(MAX(month_number), 0) + 1 AS next_month
          FROM customer_marketing_plans WHERE customer_id = ${customerId}
        `)
      )[0];
      const month = Number(monthRow?.next_month) || 1;
      const name = `${customer.business_name} - 30 Day Marketing Plan - Month ${month}`.slice(0, 190);

      const planInsert = await tx.execute(sql`
        INSERT INTO customer_marketing_plans (
          customer_id, strategy_id, month_number, plan_name, start_date, end_date,
          automation_mode, marketing_goal, custom_prompt, status, created_at, updated_at
        ) VALUES (
          ${customerId}, ${planStrategyId}, ${month}, ${name}, ${startDate}, ${endDate},
          ${automationMode}, ${marketingGoal}, ${customPrompt || null}, 'DRAFT', NOW(), NOW()
        )
      `);

      planId = insertIdOf(planInsert);
      if (!planId) throw new Error("Could not create marketing plan.");
      return { monthNumber: month, planName: name };
    });

    /* ---------- PROMPT LOG (non-fatal) ---------- */
    try {
      const promptInsert = await db.execute(sql`
        INSERT INTO customer_marketing_prompts (
          customer_id, marketing_plan_id, prompt_type, prompt,
          model_name, status, created_at, updated_at
        ) VALUES (
          ${customerId}, ${planId}, 'MASTER_30_DAY', ${masterPrompt},
          ${GEMINI_MODEL}, 'PROCESSING', NOW(), NOW()
        )
      `);
      promptLogId = insertIdOf(promptInsert);
    } catch (e) {
      console.error("Prompt logging failed:", e);
    }

    /* ---------- GEMINI + catalog mapping ---------- */
    let days: GeneratedDay[];
    let raw: any;
    try {
      const generated = await generatePlanDays(masterPrompt);
      raw = generated.raw;
      days = await normalizeDays(generated.rawDays, startDate, {
        categoryId,
        services,
        strategies: allStrategies,
        planStrategyId,
      });
    } catch (error) {
      await markFailed(error instanceof Error ? error.message : "Gemini generation failed.");
      return json(
        { success: false, error: "Could not generate the marketing plan. Please try again." },
        502
      );
    }

    /* ---------- TRANSACTION 2: save days + activate plan ---------- */
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM customer_marketing_days WHERE marketing_plan_id = ${planId}`);

        await tx.execute(sql`
          INSERT INTO customer_marketing_days (
            marketing_plan_id, day_number, topic_id, topic_title, service_id, strategy_id,
            content_type, platform, scheduled_date, prompt, caption,
            hashtags, cta, image_prompt, status, created_at, updated_at
          ) VALUES ${sql.join(
            days.map(
              (d) => sql`(
                ${planId}, ${d.day}, ${d.topic_id}, ${d.topic}, ${d.service_id}, ${d.strategy_id},
                ${d.content_type}, ${d.platform}, ${d.scheduled_date}, ${d.prompt}, ${d.caption},
                ${d.hashtags}, ${d.cta}, ${d.image_prompt}, 'GENERATED', NOW(), NOW()
              )`
            ),
            sql`, `
          )}
        `);

        await tx.execute(sql`
          UPDATE customer_marketing_plans
          SET status = 'ACTIVE', updated_at = NOW()
          WHERE id = ${planId}
        `);
      });
    } catch (error) {
      await markFailed(error instanceof Error ? error.message : "Could not save plan days.");
      throw error;
    }

    if (promptLogId) {
      await db
        .execute(sql`
          UPDATE customer_marketing_prompts
          SET response = ${JSON.stringify(raw)}, status = 'COMPLETED', updated_at = NOW()
          WHERE id = ${promptLogId}
        `)
        .catch((e) => console.error("Prompt log update failed:", e));
    }

    return json({
      success: true,
      message: "30-day marketing plan generated successfully.",
      plan: {
        id: planId,
        customerId,
        monthNumber,
        planName,
        summary: cleanString(raw?.summary, 5000),
        marketingGoal,
        automationMode,
        strategyId: planStrategyId,
        startDate,
        endDate,
        totalDays: TOTAL_DAYS,
        status: "ACTIVE",
      },
      services,
      targets,
      days,
      prompt: {
        id: promptLogId || null,
        type: "MASTER_30_DAY",
        model: GEMINI_MODEL,
        saved: Boolean(promptLogId),
      },
    });
  } catch (error) {
    console.error("POST /api/marketing-plan error:", error);

    if (error instanceof HttpError) {
      return json({ success: false, error: error.message }, error.status);
    }
    if (planId) {
      await markFailed(error instanceof Error ? error.message : "Unknown error");
    }
    return json({ success: false, error: "Could not generate marketing plan." }, 500);
  }
}

/* ========================= GET ========================= */

export async function GET(request: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId(request);
    if (!userId) return json({ success: false, error: "Unauthorized" }, 401);

    const planIdParam = new URL(request.url).searchParams.get("planId");

    // customer_id == users.id, so no profile lookup is needed beyond auth
    const customerId = userId;
    let planResult;

    if (planIdParam) {
      const planId = positiveInt(planIdParam);
      if (!planId) return json({ success: false, error: "Invalid planId." }, 422);

      planResult = await db.execute(sql`
        SELECT * FROM customer_marketing_plans
        WHERE id = ${planId} AND customer_id = ${customerId}
        LIMIT 1
      `);
    } else {
      planResult = await db.execute(sql`
        SELECT * FROM customer_marketing_plans
        WHERE customer_id = ${customerId} AND status <> 'CANCELLED'
        ORDER BY id DESC
        LIMIT 1
      `);
    }

    const plan = rowsOf(planResult)[0];
    if (!plan) return json({ success: false, error: "Marketing plan not found." }, 404);

    const days = rowsOf(
      await db.execute(sql`
        SELECT d.*,
               s.name  AS service_name,
               ps.name AS strategy_name,
               COALESCE(d.topic_title, t.title) AS topic
        FROM customer_marketing_days d
        LEFT JOIN services s ON s.id = d.service_id
        LEFT JOIN promotion_strategies ps ON ps.id = d.strategy_id
        LEFT JOIN marketing_topics t ON t.id = d.topic_id
        WHERE d.marketing_plan_id = ${plan.id}
        ORDER BY d.day_number ASC
      `)
    );

    return json({ success: true, plan, days });
  } catch (error) {
    console.error("GET /api/marketing-plan error:", error);
    return json({ success: false, error: "Could not fetch marketing plan." }, 500);
  }
}