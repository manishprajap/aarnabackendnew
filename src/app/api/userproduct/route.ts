
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { getUserIdFromRequest, AuthError } from "@/lib/auth";

export const runtime = "nodejs";

const MEDIA_ORIGIN =
  process.env.NEXT_PUBLIC_MEDIA_URL || "https://aarnexai.com";

function toFullUrl(path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${MEDIA_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function getProductRequestBody(
  request: NextRequest
): Promise<Record<string, unknown> | null> {
  try {
    let body: unknown;

    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const formData = await request.formData();
      body = Object.fromEntries(
        [...formData.entries()].filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
    } else {
      body = await request.json();
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }

    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const userProducts = await db
      .select({
        id: products.id,
        productName: products.title,
        originalImageUrl: products.originalImageUrl,
        cleanImageUrl: products.cleanImageUrl,
        description: products.description,
        price: products.price,
        status: products.status,
        createdAt: products.createdAt,
      })
      .from(products)
      .where(eq(products.userId, Number(userId)))
      .orderBy(desc(products.createdAt), desc(products.id));

    return NextResponse.json({
      success: true,
      products: userProducts.map((product) => ({
        ...product,
        originalImageUrl: toFullUrl(product.originalImageUrl),
        cleanImageUrl: toFullUrl(product.cleanImageUrl),
      })),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    console.error("GET /api/userproduct error:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch products" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    const body = await getProductRequestBody(request);

    if (!body) {
      return NextResponse.json(
        { success: false, message: "Invalid request body" },
        { status: 400 }
      );
    }

    const title = String(
      body.title ?? body.name ?? body.productName ?? ""
    ).trim();

    const originalImageUrl = String(
      body.originalImageUrl ?? body.imageUrl ?? body.image ?? ""
    ).trim();

    if (!title) {
      return NextResponse.json(
        { success: false, message: "Product name is required" },
        { status: 400 }
      );
    }

    if (!originalImageUrl) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Product image URL is required. Upload the image first.",
        },
        { status: 400 }
      );
    }

    const price =
      body.price === "" || body.price == null
        ? null
        : String(body.price);

    const [result] = await db.insert(products).values({
      userId: Number(userId),
      originalImageUrl,
      title,
      description: body.description
        ? String(body.description)
        : null,
      price,
      status: "processing",
    });

    return NextResponse.json(
      {
        success: true,
        message: "Product saved successfully",
        productId: result.insertId,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    console.error("POST /api/userproduct error:", error);

    return NextResponse.json(
      { success: false, message: "Failed to save product" },
      { status: 500 }
    );
  }
}
