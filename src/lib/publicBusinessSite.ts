import { cache } from "react";
import { access } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { products, users } from "@/db/schema";
import {
  ensureBusinessWebsiteSchema,
  getActiveBusinessWebsiteSubscription,
} from "@/lib/businessWebsite";
import { getUploadPublicPath, getUploadStoragePath } from "@/lib/uploadStorage";

export interface PublicProduct {
  id: number | string;
  title: string | null;
  description: string | null;
  price: unknown;
  /** Price in rupees as a number, or null when the product has no valid price. */
  priceValue: number | null;
  brand: string | null;
  companyName: string | null;
  category: string | null;
  subcategory: string | null;
  color: string | null;
  features: unknown;
  keywords: unknown;
  metaDescription: string | null;
  imageUrl: string | null;
}

export interface PublicService {
  id: number;
  name: string;
  slug: string | null;
  description: string | null;
}

export interface PublicSite {
  slug: string | null;
  name: string | null;
  category: string | null;
  city: string | null;
  website: string | null;
  logo: string | null;
  /** "About us" text from business_website_contents (null when not written yet). */
  about: string | null;
  /** Active services of the owner's business category (services.business_category_id). */
  services: PublicService[];
  products: PublicProduct[];
}

export interface PublishedOwner {
  id: number;
  slug: string | null;
  name: string | null;
  category: string | null;
  city: string | null;
  website: string | null;
  logo: string | null;
}

/** "499", "₹ 1,299.50", 499 -> 499 / 1299.5. Anything invalid or <= 0 -> null. */
export function parsePriceValue(price: unknown): number | null {
  if (price === null || price === undefined || price === "") return null;
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Turns whatever is stored in the DB (full URL, "/upload/..." path, legacy path,
 * or a bare file name) into a URL the browser can load.
 * NOTE: do NOT pass full paths to getUploadPublicPath, it encodes every "/".
 */
export function toPublicImageUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^(https?:)?\/\//i.test(raw)) return raw;

  let p = raw.replace(/^\/aarnexai-backend(?=\/uploads?\/)/, "");
  p = p.replace(/^\/upload\/upload\//, "/upload/");
  p = p.replace(/^\/uploads\//, "/upload/");
  if (p.startsWith("/")) return p;

  return getUploadPublicPath(...p.split("/").filter(Boolean));
}

// Folders (inside the upload dir) where a bare logo file name may have been saved.
const BARE_FILE_DIRS = ["", "website", "websites", "business-website", "business", "logos", "logo", "upload"];

/**
 * business_website_contents.logo stores only a file name (e.g. "2-94c7....png").
 * Find the folder that really contains it; fall back to the upload root.
 */
async function resolveBareUploadedFile(value: string | null | undefined): Promise<string | null> {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^(https?:)?\/\//i.test(raw) || raw.includes("/")) return toPublicImageUrl(raw);

  for (const dir of BARE_FILE_DIRS) {
    const segments = dir ? [dir, raw] : [raw];
    try {
      await access(getUploadStoragePath(...segments));
      return getUploadPublicPath(...segments);
    } catch {
      /* try next folder */
    }
  }
  return getUploadPublicPath(raw);
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return (Array.isArray(result[0]) ? result[0] : result) as Record<string, unknown>[];
  }
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function getWebsiteContent(userId: number): Promise<{ about: string | null; logo: string | null }> {
  try {
    const result = await db.execute(
      sql`SELECT about_us, logo FROM business_website_contents WHERE user_id = ${userId} LIMIT 1`,
    );
    const row = rowsOf(result)[0];
    const about = typeof row?.about_us === "string" ? row.about_us.trim() : "";
    const logo = typeof row?.logo === "string" ? row.logo.trim() : "";
    return { about: about || null, logo: logo || null };
  } catch (error) {
    console.error("[Public Business Website] could not read business_website_contents", error);
    return { about: null, logo: null };
  }
}

/**
 * Finds the owner's business_category_id.
 * 1) users.business_category_id (if that column exists)
 * 2) fallback: match users.business_category (name) against business_categories.name
 * Both lookups are wrapped in try/catch so a different column name never breaks the page.
 */
async function getOwnerBusinessCategoryId(userId: number, categoryName: string | null): Promise<number | null> {
  try {
    const result = await db.execute(
      sql`SELECT business_category_id AS id FROM users WHERE id = ${userId} LIMIT 1`,
    );
    const id = Number(rowsOf(result)[0]?.id);
    if (Number.isFinite(id) && id > 0) return id;
  } catch {
    /* column may not exist, use the name fallback */
  }

  const name = categoryName?.trim();
  if (!name) return null;
  try {
    const result = await db.execute(
      sql`SELECT id FROM business_categories WHERE LOWER(name) = LOWER(${name}) LIMIT 1`,
    );
    const id = Number(rowsOf(result)[0]?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (error) {
    console.error("[Public Business Website] could not resolve business category id", error);
    return null;
  }
}

async function getCategoryServices(userId: number, categoryName: string | null): Promise<PublicService[]> {
  const categoryId = await getOwnerBusinessCategoryId(userId, categoryName);
  if (!categoryId) return [];
  try {
    const result = await db.execute(
      sql`SELECT id, name, slug, description
          FROM services
          WHERE business_category_id = ${categoryId} AND status = 'ACTIVE'
          ORDER BY name ASC`,
    );
    return rowsOf(result)
      .map((r) => ({
        id: Number(r.id),
        name: typeof r.name === "string" ? r.name.trim() : "",
        slug: typeof r.slug === "string" ? r.slug : null,
        description: typeof r.description === "string" && r.description.trim() ? r.description.trim() : null,
      }))
      .filter((s) => s.name);
  } catch (error) {
    console.error("[Public Business Website] could not read services", error);
    return [];
  }
}

function cleanSlug(rawSlug: string): string {
  let slug = rawSlug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    /* keep raw */
  }
  return slug.trim().toLowerCase();
}

/**
 * The owner of a published website with an active website subscription, or null.
 * Cached per request so page, metadata and checkout share one DB hit.
 */
export const getPublishedOwner = cache(
  async (rawSlug: string): Promise<PublishedOwner | null> => {
    await ensureBusinessWebsiteSchema();
    const slug = cleanSlug(rawSlug);
    if (!slug || slug.length > 120) return null;

    const [user] = await db
      .select({
        id: users.id,
        slug: users.publicSlug,
        name: users.businessName,
        category: users.business_category,
        city: users.city,
        website: users.website,
        logo: users.logo,
      })
      .from(users)
      .where(and(eq(users.publicSlug, slug), eq(users.websitePublished, true)))
      .limit(1);
    if (!user || !(await getActiveBusinessWebsiteSubscription(user.id))) return null;

    return {
      id: Number(user.id),
      slug: user.slug,
      name: user.name,
      category: user.category,
      city: user.city,
      website: user.website,
      logo: user.logo,
    };
  },
);

export const getPublicBusinessSite = cache(
  async (rawSlug: string): Promise<PublicSite | null> => {
    const owner = await getPublishedOwner(rawSlug);
    if (!owner) return null;

    const [content, services, rows] = await Promise.all([
      getWebsiteContent(owner.id),
      getCategoryServices(owner.id, owner.category),
      db
        .select({
          id: products.id,
          title: products.title,
          description: products.description,
          price: products.price,
          brand: products.brand,
          companyName: products.companyName,
          category: products.category,
          subcategory: products.subcategory,
          color: products.color,
          features: products.features,
          keywords: products.keywords,
          metaDescription: products.metaDescription,
          imageUrl: products.originalImageUrl,
        })
        .from(products)
        .where(and(eq(products.userId, owner.id), eq(products.source, "user")))
        .orderBy(products.createdAt),
    ]);

    // Logo: business_website_contents first, then the logo saved on the user profile.
    const logo =
      (await resolveBareUploadedFile(content.logo)) ?? (await resolveBareUploadedFile(owner.logo));

    return {
      slug: owner.slug,
      name: owner.name,
      category: owner.category,
      city: owner.city,
      website: owner.website,
      logo,
      about: content.about,
      services,
      products: rows.map((p) => ({
        ...p,
        priceValue: parsePriceValue(p.price),
        imageUrl: toPublicImageUrl(p.imageUrl),
      })),
    };
  },
);