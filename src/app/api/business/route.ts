// src/app/api/business/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { getUserIdFromRequest, AuthError } from "@/lib/auth";
import {
  HttpError,
  resolveSelections,
  rowsOf,
  ensureSchema,
  saveCustomerServices,
  saveCustomerTargets,
} from "@/lib/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY: returns the real error to the browser. Set to false once fixed.
const SHOW_DEBUG = true;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (d: unknown, status = 200) => NextResponse.json(d, { status, headers: CORS });

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Drizzle wraps MySQL errors; the useful text is in e.cause (sqlMessage / code).
function debugInfo(step: string, e: unknown) {
  if (!SHOW_DEBUG) return undefined;
  const error = e && typeof e === "object" ? e as Record<string, unknown> : {};
  const cause = error.cause && typeof error.cause === "object"
    ? error.cause as Record<string, unknown>
    : {};
  const causeMessage = typeof cause.message === "string" ? cause.message : "";
  return {
    step,
    message: String(error.message ?? e).slice(0, 600),
    code: cause.code ?? error.code ?? null,
    sqlMessage: cause.sqlMessage ?? error.sqlMessage ?? causeMessage,
  };
}

async function authUserId(req: NextRequest): Promise<number | null> {
  try {
    const id = Number(await getUserIdFromRequest(req));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
}

const GOALS = [
  "Generate Leads", "Increase Sales", "Brand Awareness", "Engagement",
  "Website Traffic", "Local Customers", "Customer Retention",
];
const UPLOAD_DIR = path.join(process.cwd(), "upload");
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const LOGO_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function parseIdList(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ---------------- GET: prefill + previously saved selections ---------------- */
export async function GET(req: NextRequest) {
  let step = "auth";
  try {
    const userId = await authUserId(req);
    if (!userId) return json({ success: false, error: "Unauthorized" }, 401);

    step = "ensureSchema";
    await ensureSchema();

    step = "selectUser";
    const c = rowsOf(
      await db.execute(sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`)
    )[0];
    if (!c) return json({ success: false, error: "User not found." }, 404);

    step = "selectServices";
    const serviceIds = rowsOf(
      await db.execute(sql`
        SELECT service_id FROM customer_services
        WHERE customer_id = ${userId} ORDER BY is_primary DESC, service_id
      `)
    ).map((r) => Number(r.service_id));

    step = "selectTargets";
    const targetIds = rowsOf(
      await db.execute(sql`
        SELECT target_customer_id FROM customer_target_customers
        WHERE customer_id = ${userId} ORDER BY is_primary DESC, target_customer_id
      `)
    ).map((r) => Number(r.target_customer_id));

    return json({
      success: true,
      business: {
        name: c.name || "",
        email: c.email || "",
        mobile: c.mobile || "",
        businessName: c.business_name || "",
        country: c.country || "",
        state: c.state || "",
        city: c.city || "",
        industryId: c.industry_id != null ? Number(c.industry_id) : null,
        businessCategoryId: c.business_category_id != null ? Number(c.business_category_id) : null,
        serviceIds,
        targetCustomerIds: targetIds,
        marketingGoal: c.marketing_goal || "",
        automationMode: c.automation_mode || "AUTO",
        strategyId: c.strategy_id ? Number(c.strategy_id) : null,
        customPrompt: c.custom_prompt || "",
      },
      hasBusiness: Boolean(c.business_name && c.business_category_id),
    });
  } catch (e) {
    console.error(`GET /api/business failed at [${step}]:`, e);
    return json(
      { success: false, error: "Could not load business.", debug: debugInfo(step, e) },
      500
    );
  }
}

/* ---------------- POST: save business + services + targets ---------------- */
export async function POST(req: NextRequest) {
  let step = "auth";
  try {
    const userId = await authUserId(req);
    if (!userId) return json({ success: false, error: "Unauthorized" }, 401);

    step = "ensureSchema";
    await ensureSchema();

    step = "parseBody";
    let b: Record<string, unknown>;
    let logoFile: File | null = null;
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await req.formData();
      const value = (key: string) => form.get(key)?.toString() ?? "";
      logoFile = form.get("logo") instanceof File ? form.get("logo") as File : null;
      b = {
        name: value("name"),
        email: value("email"),
        phone: value("phone"),
        businessName: value("businessName"),
        country: value("country"),
        state: value("state"),
        city: value("city"),
        industry_id: value("industry_id"),
        business_category_id: value("business_category_id"),
        service_ids: parseIdList(form.get("service_ids")?.toString()),
        target_customer_ids: parseIdList(form.get("target_customer_ids")?.toString()),
        marketing_goal: value("marketing_goal"),
        automation_mode: value("automation_mode"),
        strategy_id: value("strategy_id"),
        custom_prompt: value("custom_prompt"),
      };
    } else {
      try {
        const body: unknown = await req.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json({ success: false, error: "Invalid JSON request body." }, 400);
        }
        b = body as Record<string, unknown>;
      } catch {
        return json({ success: false, error: "Invalid JSON request body." }, 400);
      }
    }

    const name = str(b.name, 191);
    const businessName = str(b.businessName, 190);
    const email = str(b.email, 191);
    const phone = str(b.phone, 20).replace(/[^\d+]/g, "");
    const country = str(b.country, 100) || "India";
    const state = str(b.state, 100);
    const city = str(b.city, 100);
    const customPrompt = str(b.custom_prompt, 10000);
    const automationMode = b.automation_mode === "MANUAL" ? "MANUAL" : "AUTO";
    const requestedMarketingGoal = str(b.marketing_goal, 100);
    const marketingGoal = GOALS.includes(requestedMarketingGoal) ? requestedMarketingGoal : "";
    if (!name) return json({ success: false, error: "Name is required." }, 422);
    if (!businessName) return json({ success: false, error: "Business name is required." }, 422);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return json({ success: false, error: "Invalid email address." }, 422);
    if (phone && !/^\+?\d{7,15}$/.test(phone))
      return json({ success: false, error: "Invalid phone number." }, 422);
    if (!marketingGoal) return json({ success: false, error: "Invalid marketing goal." }, 422);

    let logoFilename: string | null = null;
    if (logoFile && logoFile.size > 0) {
      const extension = LOGO_EXTENSIONS[logoFile.type];
      if (!extension) {
        return json({ success: false, error: "Logo must be a JPG, PNG, WEBP or GIF image." }, 400);
      }
      if (logoFile.size > MAX_LOGO_BYTES) {
        return json({ success: false, error: "Business logo must be 5 MB or smaller." }, 400);
      }
      logoFilename = `${userId}-${randomUUID()}${extension}`;
      await mkdir(UPLOAD_DIR, { recursive: true });
      await writeFile(
        path.join(UPLOAD_DIR, logoFilename),
        Buffer.from(await logoFile.arrayBuffer()),
        { flag: "wx" },
      );
    }

    step = "resolveSelections";
    const sel = await resolveSelections({
      industry_id: b.industry_id,
      business_category_id: b.business_category_id,
      service_ids: b.service_ids,
      target_customer_ids: b.target_customer_ids,
      strategy_id: b.strategy_id,
      automation_mode: automationMode,
    });

    if (email) {
      step = "emailCheck";
      const dup = rowsOf(
        await db.execute(sql`SELECT id FROM users WHERE email = ${email} AND id <> ${userId} LIMIT 1`)
      )[0];
      if (dup) return json({ success: false, error: "This email is already in use." }, 409);
    }

    // NOTE: `phone` is NOT written to users.mobile (login identifier, UNIQUE).
    step = "transaction";
    await db.transaction(async (tx) => {
      step = "updateUser";
      await tx.execute(sql`
        UPDATE users SET
          name = ${name},
          business_name = ${businessName},
          email = COALESCE(${email || null}, email),
          logo = COALESCE(${logoFilename}, logo),
          industry_id = ${sel.industry.id},
          business_category_id = ${sel.category.id},
          country = ${country}, state = ${state || null}, city = ${city || null},
          marketing_goal = ${marketingGoal},
          automation_mode = ${automationMode},
          strategy_id = ${sel.strategy?.id ?? null},
          custom_prompt = ${customPrompt || null},
          onboarding_completed = 1,
          status = 'ACTIVE',
          updated_at = NOW()
        WHERE id = ${userId}
      `);

      step = "saveServices";
      await saveCustomerServices(tx, userId, sel.services.map((s) => s.id));

      step = "saveTargets";
      await saveCustomerTargets(tx, userId, sel.targets.map((t) => t.id));
    });

    return json({
      success: true,
      customerId: userId,
      saved: {
        services: sel.services,
        targets: sel.targets,
        strategy: sel.strategy,
      },
    });
  } catch (e) {
    if (e instanceof HttpError) return json({ success: false, error: e.message }, e.status);
    console.error(`POST /api/business failed at [${step}]:`, e);
    return json(
      { success: false, error: "Could not save your business.", debug: debugInfo(step, e) },
      500
    );
  }
}