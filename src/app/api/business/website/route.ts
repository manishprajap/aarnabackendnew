import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { plans, subscriptions, users } from "@/db/schema";
import { getUserIdFromRequest } from "@/lib/auth";
import {
  ensureBusinessSlug,
  ensureBusinessWebsiteSchema,
  getActiveBusinessWebsiteSubscription,
} from "@/lib/businessWebsite";

export const dynamic = "force-dynamic";

function response(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return response({ message: "Unauthorized" }, 401);
    await ensureBusinessWebsiteSchema();

    const [user] = await db
      .select({
        slug: users.publicSlug,
        published: users.websitePublished,
        businessName: users.businessName,
        category: users.business_category,
        city: users.city,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return response({ message: "Business account not found" }, 404);

    const slug = user.businessName
      ? await ensureBusinessSlug(userId, user.businessName)
      : null;
    const activeSubscription = await getActiveBusinessWebsiteSubscription(userId);
    const [latestSubscription] = await db
      .select({ endDate: subscriptions.endDate, status: subscriptions.status })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(plans.planType, "website"),
        ),
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    return response({
      slug,
      url: slug ? `/${slug}` : null,
      published: Boolean(user.published && activeSubscription),
      subscription: activeSubscription
        ? { active: true, endDate: activeSubscription.endDate }
        : {
            active: false,
            endDate: latestSubscription?.endDate ?? null,
            status: latestSubscription?.status ?? null,
          },
      business: {
        name: user.businessName,
        category: user.category,
        city: user.city,
      },
    });
  } catch (error) {
    console.error("[Business Website GET]", error);
    return response({ message: "Could not load website settings" }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return response({ message: "Unauthorized" }, 401);
    await ensureBusinessWebsiteSchema();

    const body = await request.json().catch(() => null);
    if (typeof body?.published !== "boolean") {
      return response({ message: "published must be true or false" }, 400);
    }

    const [user] = await db
      .select({
        businessName: users.businessName,
        categoryId: users.businessCategoryId,
        city: users.city,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user?.businessName || !user.categoryId || !user.city) {
      return response({ message: "Complete your business profile before publishing." }, 400);
    }

    if (body.published) {
      const activeSubscription = await getActiveBusinessWebsiteSubscription(userId);
      if (!activeSubscription) {
        return response(
          { message: "An active Business Website subscription is required to publish." },
          403,
        );
      }
    }

    const slug = await ensureBusinessSlug(userId, user.businessName);
    await db
      .update(users)
      .set({ websitePublished: body.published })
      .where(eq(users.id, userId));

    return response({ published: body.published, slug, url: `/${slug}` });
  } catch (error) {
    console.error("[Business Website POST]", error);
    return response({ message: "Could not update website publishing status" }, 500);
  }
}
