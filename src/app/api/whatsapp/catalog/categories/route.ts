import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db";

import {
  whatsappCatalogCategories,
  whatsappCatalogs,
} from "@/db/schema";

import {
  eq,
  and,
  desc,
} from "drizzle-orm";

import { getUserIdFromRequest } from "@/lib/auth";


export async function GET(
  request: NextRequest
) {
  try {
    const userId =
      await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const categories = await db
      .select({
        id: whatsappCatalogCategories.id,
        catalogId:
          whatsappCatalogCategories.catalogId,
        name:
          whatsappCatalogCategories.name,
        description:
          whatsappCatalogCategories.description,
        createdAt:
          whatsappCatalogCategories.createdAt,
        updatedAt:
          whatsappCatalogCategories.updatedAt,
      })
      .from(whatsappCatalogCategories)
      .innerJoin(
        whatsappCatalogs,
        eq(
          whatsappCatalogCategories.catalogId,
          whatsappCatalogs.id
        )
      )
      .where(
        eq(
          whatsappCatalogs.userId,
          userId
        )
      )
      .orderBy(
        desc(
          whatsappCatalogCategories.createdAt
        )
      );

    return NextResponse.json({
      success: true,
      categories,
    });
  } catch (error) {
    console.error(
      "[WhatsApp Categories GET]",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to load categories",
      },
      { status: 500 }
    );
  }
}


export async function POST(
  request: NextRequest
) {
  try {
    const userId =
      await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const body = await request.json();

    const {
      catalogId,
      name,
      description,
    } = body;

    if (!catalogId || !name) {
      return NextResponse.json(
        {
          success: false,
          message:
            "catalogId and name are required",
        },
        { status: 400 }
      );
    }

    const [catalog] = await db
      .select({
        id: whatsappCatalogs.id,
      })
      .from(whatsappCatalogs)
      .where(
        and(
          eq(
            whatsappCatalogs.id,
            Number(catalogId)
          ),
          eq(
            whatsappCatalogs.userId,
            userId
          )
        )
      )
      .limit(1);

    if (!catalog) {
      return NextResponse.json(
        {
          success: false,
          message: "Catalog not found",
        },
        { status: 404 }
      );
    }

    const result = await db
      .insert(
        whatsappCatalogCategories
      )
      .values({
        catalogId: Number(catalogId),
        name,
        description:
          description || null,
      });

    return NextResponse.json(
      {
        success: true,
        categoryId:
          result[0].insertId,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error(
      "[WhatsApp Categories POST]",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to create category",
      },
      { status: 500 }
    );
  }
}