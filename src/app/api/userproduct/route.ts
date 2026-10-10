
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products } from "@/db/schema";
import { getUserIdFromRequest, AuthError } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);
    const body = await request.json();

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

    console.error("POST /api/products error:", error);

    return NextResponse.json(
      { success: false, message: "Failed to save product" },
      { status: 500 }
    );
  }
}
