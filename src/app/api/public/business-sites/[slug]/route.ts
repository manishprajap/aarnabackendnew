import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businessWebsiteContents, products, users } from "@/db/schema";
import {
  ensureBusinessWebsiteContentSchema,
  getActiveBusinessWebsiteSubscription,
  ensureBusinessWebsiteSchema,
} from "@/lib/businessWebsite";
import { getUploadPublicPath } from "@/lib/uploadStorage";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    await ensureBusinessWebsiteSchema();
    await ensureBusinessWebsiteContentSchema();
    const slug = (await params).slug.trim().toLowerCase();
    if (!slug || slug.length > 120) {
      return NextResponse.json({ message: "Business website not found" }, { status: 404 });
    }

    const [user] = await db
      .select({
        id: users.id,
        slug: users.publicSlug,
        published: users.websitePublished,
        name: users.businessName,
        category: users.business_category,
        city: users.city,
        website: users.website,
        logo: users.logo,
      })
      .from(users)
      .where(and(eq(users.publicSlug, slug), eq(users.websitePublished, true)))
      .limit(1);
    if (!user || !(await getActiveBusinessWebsiteSubscription(user.id))) {
      return NextResponse.json({ message: "Business website not found" }, { status: 404 });
    }

    const [websiteContent] = await db
      .select({
        aboutUs: businessWebsiteContents.aboutUs,
        logo: businessWebsiteContents.logo,
      })
      .from(businessWebsiteContents)
      .where(eq(businessWebsiteContents.userId, user.id))
      .limit(1);

    const catalog = await db
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
        hashtags: products.hashtags,
        visibleText: products.visibleText,
        metaDescription: products.metaDescription,
        imageUrl: products.originalImageUrl,
      })
      .from(products)
      .where(and(eq(products.userId, user.id), eq(products.status, "done")))
      .orderBy(products.createdAt);

    return NextResponse.json(
      {
        site: {
          slug: user.slug,
          name: user.name,
          category: user.category,
          city: user.city,
          website: user.website,
          aboutUs: websiteContent?.aboutUs ?? null,
          logo: websiteContent?.logo
            ? new URL(
                getUploadPublicPath("business-website", websiteContent.logo),
                request.nextUrl.origin,
              ).toString()
            : user.logo
              ? new URL(getUploadPublicPath(user.logo), request.nextUrl.origin).toString()
              : null,
          products: catalog,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[Public Business Website GET]", error);
    return NextResponse.json(
      { message: "Could not load this business website" },
      { status: 500 },
    );
  }
}
