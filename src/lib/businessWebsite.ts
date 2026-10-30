import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { plans, subscriptions, users } from "@/db/schema";
import { ensureColumns, rowsOf } from "@/lib/onboarding";

let businessWebsiteContentSchema: Promise<void> | null = null;

const RESERVED_SLUGS = new Set([
  "login",
  "home",
  "register",
  "onboarding",
  "dashboard",
  "campaigns",
  "products",
  "product-details",
  "profile",
  "settings",
  "subscription",
  "business-website",
  "api",
  "upload",
  "uploadnew",
  "posters",
  "social-connections",
  "whatsapp",
  "analytics",
  "prompt-plan",
]);

export async function ensureBusinessWebsiteSchema() {
  await ensureColumns("users", {
    public_slug: "VARCHAR(120) NULL",
    website_published: "BOOLEAN NOT NULL DEFAULT FALSE",
  });
  await ensureColumns("plans", {
    plan_type: "VARCHAR(32) NOT NULL DEFAULT 'ai'",
  });

  const indexes = rowsOf(
    await db.execute(sql`
      SELECT INDEX_NAME AS indexName FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
         AND INDEX_NAME = 'users_public_slug_unique'
    `),
  );
  if (!indexes.length) {
    await db.execute(
      sql.raw("ALTER TABLE users ADD UNIQUE INDEX users_public_slug_unique (public_slug)"),
    );
  }
}

export async function ensureBusinessWebsiteContentSchema() {
  if (!businessWebsiteContentSchema) {
    businessWebsiteContentSchema = db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS business_website_contents (
        user_id INT NOT NULL PRIMARY KEY,
        about_us TEXT NOT NULL,
        logo VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT business_website_contents_user_fk
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)).then(() => undefined).catch((error: unknown) => {
      businessWebsiteContentSchema = null;
      throw error;
    });
  }
  await businessWebsiteContentSchema;
}

export function slugifyBusinessName(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return slug || "business";
}

export async function ensureBusinessSlug(userId: number, businessName: string) {
  await ensureBusinessWebsiteSchema();
  const [user] = await db
    .select({ slug: users.publicSlug })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new Error("Business account not found");
  if (user.slug) return user.slug;

  const base = slugifyBusinessName(businessName);
  const reserved = RESERVED_SLUGS.has(base);
  const [collision] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.publicSlug, base), ne(users.id, userId)))
    .limit(1);
  const slug = reserved || collision ? `${base}-${userId}` : base;

  await db
    .update(users)
    .set({ publicSlug: slug })
    .where(eq(users.id, userId));
  return slug;
}

export async function ensureBusinessWebsitePlan() {
  await ensureBusinessWebsiteSchema();
  const [existing] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.planType, "website"))
    .limit(1);
  if (existing) return existing.id;

  const [result] = await db.insert(plans).values({
    name: "Business Website",
    price: 599,
    posters: 0,
    features: "Professional single-page business website\nPublic product catalog\nCustom Aarnexai URL",
    durationDays: 365,
    isActive: true,
    planType: "website",
  });
  return Number(result.insertId);
}

export async function getActiveBusinessWebsiteSubscription(userId: number) {
  await ensureBusinessWebsiteSchema();
  const [subscription] = await db
    .select({
      endDate: subscriptions.endDate,
      startDate: subscriptions.startDate,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, "active"),
        eq(plans.planType, "website"),
        gte(subscriptions.endDate, new Date()),
      ),
    )
    .limit(1);
  return subscription ?? null;
}
