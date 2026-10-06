////src/app/api/whatsapp/catalog/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { whatsappCatalogs } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

import { getUserIdFromRequest } from "@/lib/auth";

/**
 * GET /api/whatsapp/catalog
 * Returns the logged-in user's catalog (or null if none exists yet).
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const catalogs = await db
      .select()
      .from(whatsappCatalogs)
      .where(
        and(
          eq(whatsappCatalogs.userId, userId),
          eq(whatsappCatalogs.isActive, true)
        )
      )
      .orderBy(desc(whatsappCatalogs.id));

    return NextResponse.json({
      success: true,
      catalog: catalogs[0] || null,
      catalogs,
    });
  } catch (error) {
    console.error("[WhatsApp Catalog GET]", error);

    return NextResponse.json(
      { success: false, message: "Failed to load catalog" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/whatsapp/catalog
 * Creates a catalog for the user if they don't have one.
 * If one already exists, returns it (no duplicate is created).
 *
 * Body (JSON): { name, description?, currency?, businessCategoryId?, businessCategory? }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));

    const {
      name,
      description,
      currency = "INR",
      businessCategoryId,
      businessCategory,
    } = body;

    // Already has a catalog? Return it instead of creating a duplicate.
    const [existing] = await db
      .select()
      .from(whatsappCatalogs)
      .where(eq(whatsappCatalogs.userId, userId))
      .orderBy(desc(whatsappCatalogs.id))
      .limit(1);

    if (existing) {
      return NextResponse.json({
        success: true,
        message: "Catalog already exists",
        catalogId: existing.id,
        catalog: existing,
      });
    }

    const catalogName =
      (name && String(name).trim()) ||
      (businessCategory ? `${businessCategory} Catalog` : "Default Catalog");

    // The table has no business-category columns, so keep it in the description.
    const catalogDescription =
      description ||
      (businessCategory
        ? `Business category: ${businessCategory}${
            businessCategoryId ? ` (#${businessCategoryId})` : ""
          }`
        : null);

    const result = await db.insert(whatsappCatalogs).values({
      userId,
      name: catalogName,
      description: catalogDescription,
      currency,
      // metaCatalogId stays NULL until linked to a real Meta catalog
    });

    const catalogId = Number(result[0].insertId);

    const [catalog] = await db
      .select()
      .from(whatsappCatalogs)
      .where(eq(whatsappCatalogs.id, catalogId))
      .limit(1);

    return NextResponse.json(
      {
        success: true,
        message: "Catalog created",
        catalogId,
        catalog,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[WhatsApp Catalog POST]", error);

    return NextResponse.json(
      { success: false, message: "Failed to create catalog" },
      { status: 500 }
    );
  }
}