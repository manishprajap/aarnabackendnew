import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { AuthError, getUserIdFromRequest } from "@/lib/auth";
import { isAdminRequest } from "@/lib/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPUT_DIR = path.join(process.cwd(), "public", "uploads", "home-content");
const MEDIA_ORIGIN = (process.env.NEXT_PUBLIC_MEDIA_URL || "https://aarnexai.com").replace(/\/+$/, "");
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const MAX_REQUEST_BYTES = VIDEO_MAX_BYTES + 1024 * 1024;

class ForbiddenError extends Error {}

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, message }, { status });
}

function hasValidSignature(buffer: Buffer, mediaType: string, mimeType: string): boolean {
  if (mediaType === "image") {
    if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mimeType === "image/gif") return buffer.subarray(0, 3).toString("ascii") === "GIF";
    if (mimeType === "image/webp") {
      return buffer.subarray(0, 4).toString("ascii") === "RIFF"
        && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    }
  }

  if (mediaType === "video") {
    if (mimeType === "video/webm") return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
      return buffer.subarray(4, 8).toString("ascii") === "ftyp";
    }
  }
  return false;
}

async function requireAdmin(request: NextRequest): Promise<void> {
  if (isAdminRequest(request)) return;
  const userId = await getUserIdFromRequest(request);
  const result = await db.execute(sql`SELECT role FROM users WHERE id = ${userId} LIMIT 1`);
  const rows = Array.isArray(result)
    ? (Array.isArray(result[0]) ? result[0] : result)
    : result && typeof result === "object" && "rows" in result
      ? (result as { rows?: unknown }).rows
      : [];
  const role = Array.isArray(rows)
    ? (rows[0] as { role?: string | null } | undefined)?.role?.toLowerCase()
    : undefined;
  if (role !== "admin") throw new ForbiddenError("Admin access required");
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return jsonError("Video must be no larger than 100 MB.", 413);
    }
    const formData = await request.formData();
    const file = formData.get("file");
    const mediaType = formData.get("media_type");

    if (!(file instanceof File)) return jsonError("Choose an image or video file.", 400);
    if (mediaType !== "image" && mediaType !== "video") {
      return jsonError("Media type must be image or video.", 400);
    }

    const allowedMimeTypes: Record<string, Record<string, string>> = {
      image: {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
      },
      video: {
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/quicktime": ".mov",
      },
    };
    const extension = allowedMimeTypes[mediaType][file.type];
    if (!extension) {
      return jsonError(
        mediaType === "image"
          ? "Use a JPG, PNG, WEBP or GIF image."
          : "Use an MP4, WEBM or MOV video.",
        415,
      );
    }

    const maxBytes = mediaType === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    if (file.size <= 0 || file.size > maxBytes) {
      return jsonError(
        mediaType === "image"
          ? "Image must be no larger than 10 MB."
          : "Video must be no larger than 100 MB.",
        413,
      );
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    if (!hasValidSignature(fileBuffer, mediaType, file.type)) {
      return jsonError("The uploaded file content does not match its selected media type.", 415);
    }

    const fileName = `${randomUUID()}${extension}`;
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(OUTPUT_DIR, fileName), fileBuffer, { flag: "wx" });

    return NextResponse.json({
      success: true,
      media_url: `${MEDIA_ORIGIN}/uploads/home-content/${fileName}`,
      media_type: mediaType,
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.message, 401);
    if (error instanceof ForbiddenError) return jsonError(error.message, 403);
    console.error("POST /api/admin/home-content/media failed:", error);
    return jsonError("Could not upload banner media.", 500);
  }
}
