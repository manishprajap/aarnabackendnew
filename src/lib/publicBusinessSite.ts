import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { products, users } from "@/db/schema";
import {
  ensureBusinessWebsiteSchema,
  getActiveBusinessWebsiteSubscription,
} from "@/lib/businessWebsite";
import { getUploadPublicPath } from "@/lib/uploadStorage";

export interface PublicProduct {
  id: number | string;
  title: string | null;
  description: string | null;
  price: unknown;
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

export interface PublicSite {
  slug: string | null;
  name: string | null;
  category: string | null;
  city: string | null;
  website: string | null;
  logo: string | null;
  products: PublicProduct[];
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
 * Returns the public site for a slug, or null when the website does not exist,
 * is not published, or has no active website subscription.
 * Cached per request so page + metadata share one DB hit.
 */
export const getPublicBusinessSite = cache(
  async (rawSlug: string): Promise<PublicSite | null> => {
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

    const rows = await db
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
      .where(and(eq(products.userId, user.id), eq(products.status, "done")))
      .orderBy(products.createdAt);

    return {
      slug: user.slug,
      name: user.name,
      category: user.category,
      city: user.city,
      website: user.website,
      logo: toPublicImageUrl(user.logo),
      products: rows.map((p) => ({ ...p, imageUrl: toPublicImageUrl(p.imageUrl) })),
    };
  },
);