import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businessWebsiteContents } from "@/db/schema";
import { AuthError, getUserIdFromRequest } from "@/lib/auth";
import {
  ensureBusinessWebsiteContentSchema,
} from "@/lib/businessWebsite";
import { getUploadPublicPath, getUploadStoragePath } from "@/lib/uploadStorage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024;
const LOGO_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function response(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function logoUrl(request: NextRequest, fileName: string | null | undefined) {
  return fileName
    ? new URL(getUploadPublicPath("business-website", fileName), request.nextUrl.origin).toString()
    : null;
}

async function authenticatedUserId(request: NextRequest) {
  try {
    return await getUserIdFromRequest(request);
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = await authenticatedUserId(request);
    if (!userId) return response({ message: "Unauthorized" }, 401);
    await ensureBusinessWebsiteContentSchema();

    const [content] = await db
      .select({
        aboutUs: businessWebsiteContents.aboutUs,
        logo: businessWebsiteContents.logo,
      })
      .from(businessWebsiteContents)
      .where(eq(businessWebsiteContents.userId, userId))
      .limit(1);

    return response({
      aboutUs: content?.aboutUs ?? "",
      logoUrl: logoUrl(request, content?.logo),
    });
  } catch (error) {
    console.error("[Business Website Content GET]", error);
    return response({ message: "Could not load manual website content" }, 500);
  }
}

export async function POST(request: NextRequest) {
  let savedLogoPath: string | null = null;

  try {
    const userId = await authenticatedUserId(request);
    if (!userId) return response({ message: "Unauthorized" }, 401);
    await ensureBusinessWebsiteContentSchema();

    const formData = await request.formData();
    const aboutUsValue = formData.get("aboutUs");
    if (typeof aboutUsValue !== "string") {
      return response({ message: "About us text is required" }, 400);
    }

    const aboutUs = aboutUsValue.trim();
    if (aboutUs.length > 5000) {
      return response({ message: "About us text must be 5,000 characters or fewer" }, 400);
    }

    const logoEntry = formData.get("logo");
    let logoFile: File | null = null;
    if (logoEntry instanceof File && logoEntry.size > 0) {
      logoFile = logoEntry;
    } else if (logoEntry !== null && !(logoEntry instanceof File)) {
      return response({ message: "Invalid logo file" }, 400);
    }

    let logoFileName: string | null = null;
    if (logoFile) {
      const extension = LOGO_EXTENSIONS[logoFile.type];
      if (!extension) {
        return response({ message: "Logo must be a JPG, PNG, WEBP or GIF image" }, 400);
      }
      if (logoFile.size > MAX_LOGO_SIZE_BYTES) {
        return response({ message: "Logo must be 5MB or smaller" }, 400);
      }

      const uploadDirectory = getUploadStoragePath("business-website");
      await mkdir(uploadDirectory, { recursive: true });
      logoFileName = `${userId}-${randomUUID()}${extension}`;
      savedLogoPath = path.join(uploadDirectory, logoFileName);
      await writeFile(savedLogoPath, Buffer.from(await logoFile.arrayBuffer()), { flag: "wx" });
    }

    try {
      const [existing] = await db
        .select({ userId: businessWebsiteContents.userId })
        .from(businessWebsiteContents)
        .where(eq(businessWebsiteContents.userId, userId))
        .limit(1);

      if (existing) {
        await db
          .update(businessWebsiteContents)
          .set({
            aboutUs,
            ...(logoFileName ? { logo: logoFileName } : {}),
          })
          .where(eq(businessWebsiteContents.userId, userId));
      } else {
        await db.insert(businessWebsiteContents).values({
          userId,
          aboutUs,
          logo: logoFileName,
        });
      }
    } catch (error) {
      if (savedLogoPath) {
        try {
          await unlink(savedLogoPath);
        } catch (cleanupError) {
          console.error("[Business Website Content Logo Cleanup]", cleanupError);
        }
      }
      throw error;
    }

    return response({
      aboutUs,
      logoUrl: logoUrl(request, logoFileName ?? (
        await db
          .select({ logo: businessWebsiteContents.logo })
          .from(businessWebsiteContents)
          .where(eq(businessWebsiteContents.userId, userId))
          .limit(1)
      )[0]?.logo),
      message: "Manual website content saved",
    });
  } catch (error) {
    console.error("[Business Website Content POST]", error);
    return response({ message: "Could not save manual website content" }, 500);
  }
}
