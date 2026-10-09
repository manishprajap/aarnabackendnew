// src/app/api/prompt-plan/generate/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import OpenAI from 'openai';
import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { corsHeaders } from '@/lib/cors';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { rowsOf } from '@/lib/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PLAN_LENGTH = 30;
const GEMINI_TEXT_MODEL = 'gemini-3.7-flash';
const OPENAI_TEXT_MODEL = 'gpt-4o-mini';
const geminiApiKey = (process.env.GEMINI_API_KEY ?? '').trim();
const openAiApiKey = (process.env.OPENAI_API_KEY ?? '').trim();

// TEMPORARY: returns the real error to the browser. Set to false when stable.
const SHOW_DEBUG = true;

type Row = Record<string, any>;

const CONTENT_TYPES = ['IMAGE', 'VIDEO', 'CAROUSEL', 'TEXT', 'REEL', 'STORY'];
const PLATFORMS = ['FACEBOOK', 'INSTAGRAM', 'THREADS', 'WHATSAPP', 'GOOGLE_BUSINESS', 'MULTI_PLATFORM'];

class HttpError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function debugInfo(step: string, e: any) {
  if (!SHOW_DEBUG) return undefined;
  return {
    step,
    message: String(e?.message ?? e).slice(0, 600),
    code: e?.cause?.code ?? e?.code ?? null,
    sqlMessage: e?.cause?.sqlMessage ?? e?.sqlMessage ?? null,
  };
}

/* ------------------------------ helpers ------------------------------ */

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const TEXT_MAX = 60000;

function isRetryableGeminiError(error: any): boolean {
  const m = String(error?.message || '').toLowerCase();
  return (
    m.includes('503') || m.includes('unavailable') || m.includes('429') ||
    m.includes('resource_exhausted') || m.includes('rate limit')
  );
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseDelayMs = 800): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      console.error(`Gemini call failed (attempt ${attempt}/${retries}):`, error?.message);
      if (!isRetryableGeminiError(error) || attempt === retries) throw error;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// YYYY-MM-DD + n days, computed in UTC.
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/* ------------------------- prompt (from PHP buildPrompt) ------------------------- */

function buildPrompt(ctx: {
  businessName: string;
  industry: string;
  category: string;
  country: string;
  state: string;
  city: string;
  services: string[];
  targets: string[];
  goal: string;
  mode: 'AUTO' | 'MANUAL';
  strategy: Row | null;
  customPrompt: string;
}): string {
  const strategy = ctx.strategy ? ctx.strategy.name : 'AUTO - choose suitable strategies';
  const custom = ctx.customPrompt || 'No additional instructions.';

  return `You are the marketing planning engine for AarnexAI, an AI marketing OS for small and medium businesses.

Create a practical 30-day social-media marketing calendar.

BUSINESS
Business name: ${ctx.businessName}
Industry: ${ctx.industry}
Business category: ${ctx.category}
Country: ${ctx.country}
State: ${ctx.state}
City: ${ctx.city}

SELECTED PRODUCTS / SERVICES
${ctx.services.join(', ')}

SELECTED TARGET CUSTOMERS
${ctx.targets.join(', ')}

MARKETING GOAL
${ctx.goal}

AUTOMATION MODE
${ctx.mode}

MONTHLY PROMOTION STRATEGY
${strategy}

CUSTOM CUSTOMER INSTRUCTIONS
${custom}

RULES
1. Produce exactly 30 days.
2. Use only the supplied services/products; do not invent unrelated products.
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
15. date_offset is 0 through 29.
16. Return exactly 30 objects in days.

RETURN ONLY VALID JSON with this structure:
{
  "plan_name": "string",
  "monthly_strategy": "string",
  "summary": "string",
  "days": [
    {
      "day": 1,
      "date_offset": 0,
      "strategy": "string",
      "service": "string",
      "topic": "string",
      "content_type": "IMAGE|VIDEO|CAROUSEL|TEXT|REEL|STORY",
      "platform": "FACEBOOK|INSTAGRAM|THREADS|WHATSAPP|GOOGLE_BUSINESS|MULTI_PLATFORM",
      "prompt": "string",
      "caption": "string",
      "hashtags": "#tag1 #tag2 #tag3",
      "cta": "string",
      "image_prompt": "string"
    }
  ]
}`;
}

const S = { type: Type.STRING };
const DAY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    day: { type: Type.INTEGER },
    date_offset: { type: Type.INTEGER },
    strategy: S,
    service: S,
    topic: S,
    content_type: { type: Type.STRING, enum: CONTENT_TYPES },
    platform: { type: Type.STRING, enum: PLATFORMS },
    prompt: S,
    caption: S,
    hashtags: S,
    cta: S,
    image_prompt: S,
  },
  required: [
    'day', 'date_offset', 'strategy', 'service', 'topic', 'content_type',
    'platform', 'prompt', 'caption', 'hashtags', 'cta', 'image_prompt',
  ],
};
const PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    plan_name: S,
    monthly_strategy: S,
    summary: S,
    days: { type: Type.ARRAY, items: DAY_SCHEMA },
  },
  required: ['plan_name', 'monthly_strategy', 'summary', 'days'],
};

/* --------------------------------------------------------------------------
 | POST /api/prompt-plan/generate
 | Body (all optional): { startDate: "YYYY-MM-DD", monthNumber: 2, replace: true }
 | Everything else comes from users + customer_services + customer_target_customers
 | (saved by /api/business). users.id is the customer_id.
 -------------------------------------------------------------------------- */
export async function POST(req: NextRequest) {
  let step = 'auth';
  try {
    const userId = Number(await getUserIdFromRequest(req));
    if (!Number.isInteger(userId) || userId <= 0) return json({ error: 'unauthorized' }, 401);

    if (!geminiApiKey && !openAiApiKey) {
      return json({ error: 'Configure GEMINI_API_KEY or OPENAI_API_KEY to generate a plan.' }, 500);
    }

    let body: Row = {};
    try {
      body = (await req.json()) ?? {};
    } catch {
      /* empty body is fine */
    }

    const today = new Date().toISOString().slice(0, 10);
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(body.startDate || '') ? body.startDate : today;
    const endDate = addDays(startDate, PLAN_LENGTH - 1);
    const replace = body.replace === true;

    step = 'checkActivePlan';
    const latestPlan = rowsOf(
      await db.execute(sql`
        SELECT end_date
        FROM customer_marketing_plans
        WHERE customer_id = ${userId}
        ORDER BY start_date DESC, id DESC
        LIMIT 1
      `)
    )[0] as Row | undefined;
    const latestEndDate = latestPlan?.end_date instanceof Date
      ? latestPlan.end_date.toISOString().slice(0, 10)
      : String(latestPlan?.end_date || '').slice(0, 10);

    if (latestEndDate && latestEndDate >= today) {
      throw new HttpError(
        409,
        `Your 30-day prompt plan is active until ${latestEndDate}. You can generate a new plan after it ends.`,
        { endDate: latestEndDate }
      );
    }

    /* ---------- load profile ---------- */
    step = 'loadProfile';
    const user = rowsOf(
      await db.execute(sql`
        SELECT u.id, u.business_name, u.city, u.state, u.country, u.marketing_goal,
               u.automation_mode, u.custom_prompt, u.strategy_id, u.business_category_id,
               i.name  AS industry_name,
               bc.name AS category_name
        FROM users u
        LEFT JOIN industries i           ON i.id  = u.industry_id
        LEFT JOIN business_categories bc ON bc.id = u.business_category_id
        WHERE u.id = ${userId} LIMIT 1
      `)
    )[0] as Row | undefined;

    if (!user) throw new HttpError(404, 'User not found.');
    if (!user.business_name || !user.category_name) {
      throw new HttpError(400, 'Please complete your business details first.');
    }
    const categoryId = Number(user.business_category_id);

    step = 'loadServices';
    const services = rowsOf(
      await db.execute(sql`
        SELECT s.id, s.name
        FROM customer_services cs JOIN services s ON s.id = cs.service_id
        WHERE cs.customer_id = ${userId} AND s.status = 'ACTIVE'
        ORDER BY cs.is_primary DESC, s.id
      `)
    ) as Row[];
    if (!services.length) throw new HttpError(400, 'Please select at least one product/service.');

    step = 'loadTargets';
    const targets = rowsOf(
      await db.execute(sql`
        SELECT t.id, t.name
        FROM customer_target_customers ct JOIN target_customers t ON t.id = ct.target_customer_id
        WHERE ct.customer_id = ${userId} AND t.status = 'ACTIVE'
        ORDER BY ct.is_primary DESC, t.id
      `)
    ) as Row[];
    if (!targets.length) throw new HttpError(400, 'Please select at least one target customer.');

    const mode: 'AUTO' | 'MANUAL' = user.automation_mode === 'MANUAL' ? 'MANUAL' : 'AUTO';

    let strategy: Row | null = null;
    if (user.strategy_id) {
      step = 'loadStrategy';
      strategy =
        (rowsOf(
          await db.execute(sql`
            SELECT id, name, objective FROM promotion_strategies
            WHERE id = ${Number(user.strategy_id)} AND status = 'ACTIVE' LIMIT 1
          `)
        )[0] as Row | undefined) ?? null;
    }
    if (mode === 'MANUAL' && !strategy) {
      throw new HttpError(400, 'Please select a promotion strategy for MANUAL mode.');
    }

    // all active strategies, to map Gemini's per-day strategy name -> id
    step = 'loadAllStrategies';
    const allStrategies = rowsOf(
      await db.execute(sql`SELECT id, name FROM promotion_strategies WHERE status = 'ACTIVE'`)
    ) as Row[];
    const strategyByName = new Map(allStrategies.map((s) => [String(s.name).trim().toLowerCase(), Number(s.id)]));
    const serviceByName = new Map(services.map((s) => [String(s.name).trim().toLowerCase(), Number(s.id)]));

    /* ---------- month number ---------- */
    step = 'monthNumber';
    let monthNumber = Number(body.monthNumber);
    if (!Number.isInteger(monthNumber) || monthNumber <= 0) {
      const r = rowsOf(
        await db.execute(sql`
          SELECT COALESCE(MAX(month_number), 0) + 1 AS n
          FROM customer_marketing_plans WHERE customer_id = ${userId}
        `)
      )[0] as Row;
      monthNumber = Number(r.n) || 1;
    }

    const existing = rowsOf(
      await db.execute(sql`
        SELECT id FROM customer_marketing_plans
        WHERE customer_id = ${userId} AND month_number = ${monthNumber} LIMIT 1
      `)
    )[0] as Row | undefined;
    if (existing && !replace) {
      throw new HttpError(409, `A plan for month ${monthNumber} already exists.`, {
        planId: Number(existing.id),
        monthNumber,
      });
    }

    /* ---------- AI plan generation ---------- */
    step = 'buildPrompt';
    const businessName = String(user.business_name);
    const goal = String(user.marketing_goal || 'Generate Leads');
    const prompt = buildPrompt({
      businessName,
      industry: String(user.industry_name || ''),
      category: String(user.category_name),
      country: String(user.country || 'India'),
      state: String(user.state || ''),
      city: String(user.city || ''),
      services: services.map((s) => String(s.name)),
      targets: targets.map((t) => String(t.name)),
      goal,
      mode,
      strategy,
      customPrompt: String(user.custom_prompt || '').trim(),
    });

    let rawText = '';
    if (geminiApiKey) {
      step = 'gemini';
      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: GEMINI_TEXT_MODEL,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            temperature: 0.7,
            maxOutputTokens: 32000,
            responseMimeType: 'application/json',
            responseSchema: PLAN_SCHEMA,
          },
        })
      );
      rawText = response.text?.trim() ?? '';
    } else {
      step = 'openai';
      const openai = new OpenAI({ apiKey: openAiApiKey });
      const response = await openai.chat.completions.create({
        model: OPENAI_TEXT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_completion_tokens: 16000,
        response_format: { type: 'json_object' },
      });
      rawText = response.choices[0]?.message?.content?.trim() ?? '';
    }
    if (!rawText) throw new HttpError(502, 'Empty response from the AI provider. Please try again.');

    step = 'parse';
    let plan: any;
    try {
      plan = JSON.parse(rawText);
    } catch {
      try {
        plan = JSON.parse(rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
      } catch {
        throw new HttpError(502, 'The AI provider returned invalid or cut-off JSON. Please try again.');
      }
    }
    if (!plan || !Array.isArray(plan.days)) {
      throw new HttpError(502, 'The AI provider did not return the expected JSON calendar.');
    }
    if (plan.days.length < PLAN_LENGTH) {
      throw new HttpError(502, `The AI provider returned ${plan.days.length} days instead of ${PLAN_LENGTH}. Please try again.`);
    }
    const days = plan.days.slice(0, PLAN_LENGTH) as Row[];

    /* ---------- save plan + 30 days ---------- */
    step = 'save';
    const strategyId = strategy ? Number(strategy.id) : null;
    const planName = str(plan.plan_name, 190) || `${businessName} - 30 Day Marketing Plan - Month ${monthNumber}`;
    let planId = 0;

    await db.transaction(async (tx) => {
      if (existing && replace) {
        step = 'deleteOldPlan'; // days removed by ON DELETE CASCADE
        await tx.execute(sql`
          DELETE FROM customer_marketing_plans WHERE customer_id = ${userId} AND month_number = ${monthNumber}
        `);
      }

      step = 'insertPlan';
      await tx.execute(sql`
        INSERT INTO customer_marketing_plans
          (customer_id, strategy_id, month_number, plan_name, start_date, end_date,
           automation_mode, marketing_goal, custom_prompt, status)
        VALUES
          (${userId}, ${strategyId}, ${monthNumber}, ${planName}, ${startDate}, ${endDate},
           ${mode}, ${goal}, ${user.custom_prompt || null}, 'ACTIVE')
      `);

      const planRow = rowsOf(
        await tx.execute(sql`
          SELECT id FROM customer_marketing_plans
          WHERE customer_id = ${userId} AND month_number = ${monthNumber} LIMIT 1
        `)
      )[0] as Row;
      planId = Number(planRow.id);

      step = 'insertDays';
      for (let i = 0; i < PLAN_LENGTH; i++) {
        const d = days[i] ?? {};

        // service: match Gemini's name against the customer's selected services, else rotate
        const serviceId =
          serviceByName.get(String(d.service ?? '').trim().toLowerCase()) ??
          Number(services[i % services.length].id);

        // strategy: match by name, else the plan's strategy
        const dayStrategyId =
          strategyByName.get(String(d.strategy ?? '').trim().toLowerCase()) ?? strategyId;

        // topic_id lookup (same as PHP topicId())
        let topicId: number | null = null;
        const title = str(d.topic, 255);
        if (dayStrategyId && title) {
          const r = rowsOf(
            await tx.execute(sql`
              SELECT id FROM marketing_topics
              WHERE business_category_id = ${categoryId} AND service_id = ${serviceId}
                AND strategy_id = ${dayStrategyId} AND title = ${title} LIMIT 1
            `)
          )[0] as Row | undefined;
          if (r) topicId = Number(r.id);
        }
        if (topicId === null && dayStrategyId) {
          const r = rowsOf(
            await tx.execute(sql`
              SELECT id FROM marketing_topics
              WHERE business_category_id = ${categoryId} AND service_id IS NULL
                AND strategy_id = ${dayStrategyId} ORDER BY id LIMIT 1
            `)
          )[0] as Row | undefined;
          if (r) topicId = Number(r.id);
        }

        let contentType = String(d.content_type ?? 'IMAGE').trim().toUpperCase();
        if (!CONTENT_TYPES.includes(contentType)) contentType = 'IMAGE';
        let platform = String(d.platform ?? 'INSTAGRAM').trim().toUpperCase();
        if (!PLATFORMS.includes(platform)) platform = 'INSTAGRAM';

        await tx.execute(sql`
          INSERT INTO customer_marketing_days
            (marketing_plan_id, day_number, topic_id, service_id, strategy_id, content_type, platform,
             scheduled_date, prompt, caption, hashtags, cta, image_prompt, topic_title, status)
          VALUES
            (${planId}, ${i + 1}, ${topicId}, ${serviceId}, ${dayStrategyId}, ${contentType}, ${platform},
             ${addDays(startDate, i)},
             ${str(d.prompt, TEXT_MAX) || null},
             ${str(d.caption, TEXT_MAX) || null},
             ${str(d.hashtags, TEXT_MAX) || null},
             ${str(d.cta, 190) || null},
             ${str(d.image_prompt, TEXT_MAX) || null},
             ${title || null},
             'GENERATED')
        `);
      }
    });

    const items = days.map((d, i) => ({
      day: i + 1,
      theme: str(d.topic, 255) || null,
      prompt: str(d.prompt, TEXT_MAX) || str(d.caption, TEXT_MAX),
    }));
    const diff = Math.floor(
      (Date.parse(today) - Date.parse(startDate)) / 86400000
    );
    const todayItem = items[Math.min(Math.max(diff, 0), PLAN_LENGTH - 1)] ?? items[0];

    return json({
      success: true,
      planId,
      monthNumber,
      planName,
      summary: plan.summary ?? '',
      startDate,
      endDate,
      days: PLAN_LENGTH,
      items,
      today: todayItem,
    });
  } catch (e: any) {
    if (e instanceof AuthError) return json({ error: e.message }, 401);
    if (e instanceof HttpError) return json({ success: false, error: e.message, ...e.extra }, e.status);
    if (e?.cause?.code === 'ER_DUP_ENTRY') {
      return json({ success: false, error: 'This month already has a plan.' }, 409);
    }
    console.error(`POST /api/prompt-plan/generate failed at [${step}]:`, e);
    return json(
      { success: false, error: 'Could not generate your plan.', debug: debugInfo(step, e) },
      500
    );
  }
}