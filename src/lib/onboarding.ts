// src/lib/onboarding.ts
import { sql } from "drizzle-orm";
import { db } from "@/db";

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** mysql2 returns [rows, fields] */
export const rowsOf = (r: unknown): any[] => {
  const first = Array.isArray(r) ? r[0] : (r as any)?.rows;
  return Array.isArray(first) ? first : [];
};

export const insertIdOf = (r: unknown): number =>
  Number((((Array.isArray(r) ? r[0] : r) as any)?.insertId)) || 0;

/** db or a transaction object */
export type Executor = { execute: (query: any) => Promise<any> };

const ids = (v: unknown, max = 50): number[] => {
  if (!Array.isArray(v)) return [];
  const out = v.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return Array.from(new Set(out)).slice(0, max);
};

const inList = (list: number[]) => sql.join(list.map((i) => sql`${i}`), sql`, `);

const norm = (s: string) => s.trim().toLowerCase();

/* ============ Schema guard: adds missing columns once per process ============ */

const ensured = new Set<string>();

export async function ensureColumns(table: string, wanted: Record<string, string>) {
  if (ensured.has(table)) return;
  if (!/^[a-z_]+$/.test(table)) throw new Error("Bad table name");

  const existing = rowsOf(
    await db.execute(sql`
      SELECT COLUMN_NAME AS col FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
    `)
  ).map((r) => String(r.col ?? r.COLUMN_NAME ?? r.column_name));

  for (const [column, definition] of Object.entries(wanted)) {
    if (!/^[a-z_]+$/.test(column)) continue;
    if (!existing.includes(column)) {
      await db.execute(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
    }
  }
  ensured.add(table);
}

/**
 * Customer data now lives in `users` (users.id is the customer id).
 * customer_services / customer_target_customers / customer_marketing_plans
 * keep a `customer_id` column that stores users.id.
 */
export async function ensureSchema() {
  await ensureColumns("users", {
    marketing_goal: "VARCHAR(100) NULL",
    custom_prompt: "TEXT NULL",
    strategy_id: "BIGINT UNSIGNED NULL",
    logo: "VARCHAR(255) NULL",
  });
  await ensureColumns("customer_marketing_plans", {
    marketing_goal: "VARCHAR(100) NULL",
    custom_prompt: "TEXT NULL",
  });
  // Gemini's own topic text (marketing_topics may not have a matching row)
  await ensureColumns("customer_marketing_days", {
    topic_title: "VARCHAR(255) NULL",
  });
}

/* ============ Selections (ACTIVE-only validation) ============ */

export type Named = { id: number; name: string };

export type Selections = {
  industry: Named;
  category: Named;
  services: Named[]; // in the order the user picked (first = primary)
  targets: Named[];
  strategy: { id: number; name: string; objective: string } | null;
};

const inOrder = (rows: any[], order: number[]): Named[] =>
  order
    .map((id) => rows.find((r) => Number(r.id) === id))
    .filter(Boolean)
    .map((r) => ({ id: Number(r.id), name: String(r.name) }));

export async function resolveSelections(input: {
  industry_id: unknown;
  business_category_id: unknown;
  service_ids: unknown;
  target_customer_ids: unknown;
  strategy_id: unknown;
  automation_mode: string;
}): Promise<Selections> {
  const industryId = Number(input.industry_id);
  const categoryId = Number(input.business_category_id);
  const serviceIds = ids(input.service_ids);
  const targetIds = ids(input.target_customer_ids);

  if (!Number.isInteger(industryId) || industryId <= 0)
    throw new HttpError("Industry is required.", 422);
  if (!Number.isInteger(categoryId) || categoryId <= 0)
    throw new HttpError("Business category is required.", 422);
  if (!serviceIds.length) throw new HttpError("Select at least one product or service.", 422);
  if (!targetIds.length) throw new HttpError("Select at least one target customer.", 422);

  const industry = rowsOf(
    await db.execute(sql`
      SELECT id, name FROM industries WHERE id = ${industryId} AND status = 'ACTIVE' LIMIT 1
    `)
  )[0];
  if (!industry) throw new HttpError("Invalid industry.", 422);

  const category = rowsOf(
    await db.execute(sql`
      SELECT id, name FROM business_categories
      WHERE id = ${categoryId} AND industry_id = ${industryId} AND status = 'ACTIVE' LIMIT 1
    `)
  )[0];
  if (!category) throw new HttpError("Category does not belong to the selected industry.", 422);

  const serviceRows = rowsOf(
    await db.execute(sql`
      SELECT id, name FROM services
      WHERE business_category_id = ${categoryId} AND status = 'ACTIVE'
        AND id IN (${inList(serviceIds)})
    `)
  );
  const services = inOrder(serviceRows, serviceIds);
  if (services.length !== serviceIds.length)
    throw new HttpError("One or more services are invalid for this category.", 422);

  const targetRows = rowsOf(
    await db.execute(sql`
      SELECT id, name FROM target_customers
      WHERE business_category_id = ${categoryId} AND status = 'ACTIVE'
        AND id IN (${inList(targetIds)})
    `)
  );
  const targets = inOrder(targetRows, targetIds);
  if (targets.length !== targetIds.length)
    throw new HttpError("One or more target customers are invalid for this category.", 422);

  // strategy is optional in AUTO, required in MANUAL
  let strategy: Selections["strategy"] = null;
  const strategyId = Number(input.strategy_id);
  if (Number.isInteger(strategyId) && strategyId > 0) {
    const row = rowsOf(
      await db.execute(sql`
        SELECT id, name, objective FROM promotion_strategies
        WHERE id = ${strategyId} AND status = 'ACTIVE' LIMIT 1
      `)
    )[0];
    if (row) strategy = { id: Number(row.id), name: String(row.name), objective: String(row.objective) };
  }
  if (input.automation_mode === "MANUAL" && !strategy)
    throw new HttpError("Select a promotion strategy for MANUAL mode.", 422);

  return {
    industry: { id: Number(industry.id), name: String(industry.name) },
    category: { id: Number(category.id), name: String(category.name) },
    services,
    targets,
    strategy,
  };
}

/* ============ Save selections (customerId = users.id) ============ */

export async function saveCustomerServices(ex: Executor, customerId: number, serviceIds: number[]) {
  await ex.execute(sql`DELETE FROM customer_services WHERE customer_id = ${customerId}`);
  if (!serviceIds.length) return;
  await ex.execute(sql`
    INSERT INTO customer_services (customer_id, service_id, is_primary, created_at)
    VALUES ${sql.join(
      serviceIds.map((id, i) => sql`(${customerId}, ${id}, ${i === 0 ? 1 : 0}, NOW())`),
      sql`, `
    )}
  `);
}

export async function saveCustomerTargets(ex: Executor, customerId: number, targetIds: number[]) {
  await ex.execute(sql`DELETE FROM customer_target_customers WHERE customer_id = ${customerId}`);
  if (!targetIds.length) return;
  await ex.execute(sql`
    INSERT INTO customer_target_customers (customer_id, target_customer_id, is_primary, created_at)
    VALUES ${sql.join(
      targetIds.map((id, i) => sql`(${customerId}, ${id}, ${i === 0 ? 1 : 0}, NOW())`),
      sql`, `
    )}
  `);
}

/* ============ Name -> ID helpers ============ */

export function idByName(list: Named[], name: string): number | null {
  const n = norm(name);
  if (!n) return null;
  return list.find((x) => norm(x.name) === n)?.id ?? null;
}

export async function findTopicId(
  ex: Executor,
  categoryId: number,
  serviceId: number | null,
  strategyId: number | null,
  title: string
): Promise<number | null> {
  if (serviceId && strategyId && title) {
    const r = rowsOf(
      await ex.execute(sql`
        SELECT id FROM marketing_topics
        WHERE business_category_id = ${categoryId} AND service_id = ${serviceId}
          AND strategy_id = ${strategyId} AND title = ${title} LIMIT 1
      `)
    )[0];
    if (r) return Number(r.id);
  }
  if (strategyId) {
    const r = rowsOf(
      await ex.execute(sql`
        SELECT id FROM marketing_topics
        WHERE business_category_id = ${categoryId} AND service_id IS NULL
          AND strategy_id = ${strategyId} ORDER BY id LIMIT 1
      `)
    )[0];
    if (r) return Number(r.id);
  }
  return null;
}