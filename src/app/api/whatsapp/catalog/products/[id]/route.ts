///src/app/api/whatsapp/catalog/products/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { createId } from "@paralleldrive/cuid2";
import { db } from "@/db";
import { whatsappProducts, whatsappCatalogs } from "@/db/schema";
import { eq, and } from "drizzle-orm";

import { getUserIdFromRequest } from "@/lib/auth";

export const runtime = "nodejs";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Images are saved on disk here (NOT in the Next.js public folder)
const UPLOAD_BASE_DIR =
  process.env.UPLOAD_DIR || "/var/www/aarnexai.com/aarnexai-backend/upload";

// URL prefix stored in DB: /upload/products/<file>
const UPLOAD_URL_PREFIX = "/upload";

/** Make sure the product exists and belongs to a catalog owned by this user. */
async function findOwnedProduct(productId: number, userId: number) {
  const [row] = await db
    .select({ id: whatsappProducts.id, metadata: whatsappProducts.metadata })
    .from(whatsappProducts)
    .innerJoin(
      whatsappCatalogs,
      eq(whatsappProducts.catalogId, whatsappCatalogs.id)
    )
    .where(
      and(
        eq(whatsappProducts.id, productId),
        eq(whatsappCatalogs.userId, userId)
      )
    )
    .limit(1);
  return row || null;
}

async function updateProduct(request: NextRequest, ctx: { params: any }) {
  let savedFilePath: string | null = null;

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id } = await ctx.params;
    const productId = Number(id);
    if (!productId) {
      return NextResponse.json(
        { success: false, message: "Invalid product id" },
        { status: 400 }
      );
    }

    const existing = await findOwnedProduct(productId, userId);
    if (!existing) {
      return NextResponse.json(
        { success: false, message: "Product not found" },
        { status: 404 }
      );
    }

    // Parse body (multipart or JSON)
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

    const updates: Record<string, any> = {};

    if (body.name !== undefined) {
      if (!String(body.name).trim()) {
        return NextResponse.json(
          { success: false, message: "Product name is required" },
          { status: 400 }
        );
      }
      updates.name = String(body.name).trim();
    }

    if (body.description !== undefined) {
      updates.description = body.description || null;
    }

    if (body.price !== undefined && body.price !== "") {
      const n = Number(body.price);
      if (Number.isNaN(n) || n < 0) {
        return NextResponse.json(
          { success: false, message: "Invalid price" },
          { status: 400 }
        );
      }
      updates.price = String(n);
    }

    if (body.currency) updates.currency = body.currency;

    if (body.availability) {
      updates.availability = String(body.availability)
        .replace(/_/g, " ")
        .toLowerCase();
    }

    if (body.categoryId !== undefined) {
      updates.categoryId = body.categoryId ? Number(body.categoryId) : null;
    }

    if (body.sku !== undefined) {
      updates.retailerId = body.sku || null;
    }

    // Keep extra info in metadata
    const oldMeta = (existing.metadata as Record<string, any>) || {};
    updates.metadata = {
      ...oldMeta,
      ...(body.sku !== undefined ? { sku: body.sku } : {}),
      ...(body.businessCategoryId
        ? { businessCategoryId: body.businessCategoryId }
        : {}),
      ...(body.businessCategory
        ? { businessCategory: body.businessCategory }
        : {}),
    };

    // Optional new image -> UPLOAD_BASE_DIR/products (relative path stored in DB)
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

      const dir = path.join(
        /*turbopackIgnore: true*/ UPLOAD_BASE_DIR,
        "products"
      );
      await fs.mkdir(dir, { recursive: true });

      const filePath = path.join(/*turbopackIgnore: true*/ dir, fileName);
      await fs.writeFile(filePath, Buffer.from(await imageFile.arrayBuffer()));
      savedFilePath = filePath;

      updates.imageUrl = `${UPLOAD_URL_PREFIX}/products/${fileName}`;
    }

    // Changed locally, so it needs to be synced to Meta again
    updates.syncStatus = "pending";

    await db
      .update(whatsappProducts)
      .set(updates)
      .where(eq(whatsappProducts.id, productId));

    return NextResponse.json({ success: true, message: "Product updated" });
  } catch (error) {
    console.error("[WhatsApp Product UPDATE]", error);

    // Remove the newly uploaded file if the DB update failed
    if (savedFilePath) {
      try {
        await fs.unlink(savedFilePath);
      } catch (cleanupError) {
        console.error("[WhatsApp Product UPDATE] cleanup failed", cleanupError);
      }
    }

    return NextResponse.json(
      { success: false, message: "Failed to update product" },
      { status: 500 }
    );
  }
}

export const PUT = updateProduct;
export const PATCH = updateProduct;

/** Soft delete: GET /products only lists isActive = true rows. */
export async function DELETE(request: NextRequest, ctx: { params: any }) {
  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id } = await ctx.params;
    const productId = Number(id);

    const existing = productId
      ? await findOwnedProduct(productId, userId)
      : null;
    if (!existing) {
      return NextResponse.json(
        { success: false, message: "Product not found" },
        { status: 404 }
      );
    }

    await db
      .update(whatsappProducts)
      .set({ isActive: false })
      .where(eq(whatsappProducts.id, productId));

    return NextResponse.json({ success: true, message: "Product deleted" });
  } catch (error) {
    console.error("[WhatsApp Product DELETE]", error);
    return NextResponse.json(
      { success: false, message: "Failed to delete product" },
      { status: 500 }
    );
  }
}