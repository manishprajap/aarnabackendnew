import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getPoliticalBannerInstructions,
  isProfessionalPortraitCategory,
  isPoliticalCategory,
  getProfessionalBannerInstructions,
} from "@/lib/politicalBanner";
import { getUploadStoragePath } from "@/lib/uploadStorage";

export {
  getPoliticalBannerInstructions,
  getProfessionalBannerInstructions,
  isPoliticalCategory,
  isProfessionalPortraitCategory,
};

export async function readProfessionalBannerPhoto(userId: number, fileName: unknown): Promise<{
  buffer: Buffer;
  mimeType: string;
} | null> {
  if (typeof fileName !== "string" || !fileName.trim()) return null;
  const safeName = path.basename(fileName);
  if (safeName !== fileName || !safeName.startsWith(`${userId}-`)) {
    throw new Error("Stored professional photo path is invalid.");
  }

  const extension = path.extname(safeName).toLowerCase();
  const mimeType = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".png"
      ? "image/png"
      : extension === ".webp"
        ? "image/webp"
        : null;
  if (!mimeType) throw new Error("Stored professional photo has an unsupported image format.");

  return {
    buffer: await readFile(getUploadStoragePath("business-profiles", safeName)),
    mimeType,
  };
}
