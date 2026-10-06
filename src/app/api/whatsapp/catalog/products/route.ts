///src/app/api/whatsapp/catalog/products/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { createId } from "@paralleldrive/cuid2";
import { db } from "@/db";
import { whatsappProducts, whatsappCatalogs } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

import { getUserIdFromRequest } from "@/lib/auth";

export const runtime = "nodejs";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Images are saved on disk here (NOT in the Next.js public folder)
const UPLOAD_BASE_DIR =
  process.env.UPLOAD_DIR || "/var/www/aarnexai.com/aarnexai-backend/upload";

// URL prefix stored in DB: /upload/products/<file>
const UPLOAD_URL_PREFIX = "/upload";

// Domain root: images are served by Nginx from here (same as banners route)
const MEDIA_ORIGIN =
  process.env.NEXT_PUBLIC_MEDIA_URL || "https://aarnexai.com";

/** "/upload/products/a.jpg" -> "https://aarnexai.com/upload/products/a.jpg" */
function toPublicUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value; // already absolute
  return `${MEDIA_ORIGIN}${value.startsWith("/") ? "" : "/"}${value}`;
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const rows = await db
      .select({
        id: whatsappProducts.id,
        catalogId: whatsappProducts.catalogId,
        categoryId: whatsappProducts.categoryId,
        metaProductId: whatsappProducts.metaProductId,
        retailerId: whatsappProducts.retailerId,
        name: whatsappProducts.name,
        description: whatsappProducts.description,
        price: whatsappProducts.price,
        currency: whatsappProducts.currency,
        imageUrl: whatsappProducts.imageUrl,
        availability: whatsappProducts.availability,
        condition: whatsappProducts.condition,
        brand: whatsappProducts.brand,
        url: whatsappProducts.url,
        isActive: whatsappProducts.isActive,
        syncStatus: whatsappProducts.syncStatus,
        syncError: whatsappProducts.syncError,
        metadata: whatsappProducts.metadata,
        createdAt: whatsappProducts.createdAt,
        updatedAt: whatsappProducts.updatedAt,
      })
      .from(whatsappProducts)
      .innerJoin(
        whatsappCatalogs,
        eq(whatsappProducts.catalogId, whatsappCatalogs.id)
      )
      .where(
        and(
          eq(whatsappCatalogs.userId, userId),
          eq(whatsappProducts.isActive, true)
        )
      )
      .orderBy(desc(whatsappProducts.createdAt));

    // Shape the data the way the frontend expects
    const products = rows.map(({ metadata, ...p }) => ({
      ...p,
      // relative DB path -> absolute public URL
      imageUrl: toPublicUrl(p.imageUrl),
      sku: p.retailerId ?? (metadata as any)?.sku ?? "",
      // DB / Meta format: "in stock"  ->  frontend format: "in_stock"
      availability: String(p.availability || "in stock").replace(/ /g, "_"),
    }));

    return NextResponse.json({ success: true, products });
  } catch (error) {
    console.error("[WhatsApp Products GET]", error);

    return NextResponse.json(
      { success: false, message: "Failed to load WhatsApp products" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let savedFilePath: string | null = null;

  try {
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    // Parse body: multipart/form-data (with image) or JSON
    const contentType = request.headers.get("content-type") || "";

    let body: Record<string, any> = {};
    let imageFile: File | null = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();

      for (const [key, value] of formData.entries()) {
        if (typeof value !== "string") {
          if (key === "image" && value.size > 0) imageFile = value;
        } else {
          body[key] = value;
        }
      }
    } else {
      body = await request.json();
    }

    const {
      catalogId,
      categoryId,
      businessCategoryId,
      businessCategory,
      name,
      description,
      price,
      currency,
      imageUrl,
      availability,
      condition,
      brand,
      retailerId,
      sku,
      url,
    } = body;

    const additionalImageUrls = parseJsonField<string[]>(
      body.additionalImageUrls,
      []
    );
    const extraMetadata = parseJsonField<Record<string, any>>(
      body.metadata,
      {}
    );

    if (!name || !String(name).trim()) {
      return NextResponse.json(
        { success: false, message: "Product name is required" },
        { status: 400 }
      );
    }

    // Resolve catalog (must belong to this user; falls back to latest one)
    let resolvedCatalogId: number;

    if (catalogId !== undefined && catalogId !== null && catalogId !== "") {
      const [catalog] = await db
        .select({ id: whatsappCatalogs.id })
        .from(whatsappCatalogs)
        .where(
          and(
            eq(whatsappCatalogs.id, Number(catalogId)),
            eq(whatsappCatalogs.userId, userId)
          )
        )
        .limit(1);

      if (!catalog) {
        return NextResponse.json(
          { success: false, message: "Catalog not found" },
          { status: 404 }
        );
      }
      resolvedCatalogId = catalog.id;
    } else {
      const [catalog] = await db
        .select({ id: whatsappCatalogs.id })
        .from(whatsappCatalogs)
        .where(eq(whatsappCatalogs.userId, userId))
        .orderBy(desc(whatsappCatalogs.id))
        .limit(1);

      if (!catalog) {
        return NextResponse.json(
          {
            success: false,
            message:
              "No catalog found. Please create a catalog before adding products.",
          },
          { status: 400 }
        );
      }
      resolvedCatalogId = catalog.id;
    }

    // Validate price
    let normalizedPrice: string | null = null;
    if (price !== undefined && price !== null && price !== "") {
      const numericPrice = Number(price);
      if (Number.isNaN(numericPrice) || numericPrice < 0) {
        return NextResponse.json(
          { success: false, message: "Invalid price" },
          { status: 400 }
        );
      }
      normalizedPrice = String(numericPrice);
    }

    // "in_stock" -> "in stock"
    const normalizedAvailability = String(availability || "in stock")
      .replace(/_/g, " ")
      .toLowerCase();

    // Image upload -> UPLOAD_BASE_DIR/products (relative path stored in DB)
    let finalImageUrl: string | null = imageUrl || null;

    if (imageFile) {
      if (!ALLOWED_IMAGE_TYPES.includes(imageFile.type)) {
        return NextResponse.json(
          {
            success: false,
            message: "Only JPEG, PNG or WebP images are allowed",
          },
          { status: 400 }
        );
      }

      if (imageFile.size > MAX_IMAGE_SIZE) {
        return NextResponse.json(
          { success: false, message: "Image must be 5 MB or smaller" },
          { status: 400 }
        );
      }

      const extension =
        imageFile.type === "image/png"
          ? "png"
          : imageFile.type === "image/webp"
          ? "webp"
          : "jpg";
      const fileName = `${createId()}.${extension}`;

      const uploadDir = path.join(
        /*turbopackIgnore: true*/ UPLOAD_BASE_DIR,
        "products"
      );
      await fs.mkdir(uploadDir, { recursive: true });

      const filePath = path.join(/*turbopackIgnore: true*/ uploadDir, fileName);
      await fs.writeFile(filePath, Buffer.from(await imageFile.arrayBuffer()));
      savedFilePath = filePath;

      finalImageUrl = `${UPLOAD_URL_PREFIX}/products/${fileName}`;
    }

    // Keep fields that have no dedicated column
    const metadata = {
      ...extraMetadata,
      ...(sku ? { sku } : {}),
      ...(businessCategoryId ? { businessCategoryId } : {}),
      ...(businessCategory ? { businessCategory } : {}),
    };

    const result = await db.insert(whatsappProducts).values({
      catalogId: resolvedCatalogId,
      categoryId: categoryId ? Number(categoryId) : null,

      name: String(name).trim(),
      description: description || null,

      price: normalizedPrice,
      currency: currency || "INR",

      imageUrl: finalImageUrl,
      additionalImageUrls,

      availability: normalizedAvailability,
      condition: condition || "new",

      brand: brand || null,
      retailerId: retailerId || sku || null,
      url: url || null,

      metadata,

      syncStatus: "pending",
    });

    return NextResponse.json(
      {
        success: true,
        message: "Product created",
        productId: result[0].insertId,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[WhatsApp Products POST]", error);

    // Remove the uploaded file if the DB insert failed
    if (savedFilePath) {
      try {
        await fs.unlink(savedFilePath);
      } catch (cleanupError) {
        console.error("[WhatsApp Products POST] cleanup failed", cleanupError);
      }
    }

    return NextResponse.json(
      { success: false, message: "Failed to create product" },
      { status: 500 }
    );
  }
}