import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

export const UPLOAD_BASE_DIR =
  process.env.UPLOAD_DIR || "/var/www/aarnexai.com/aarnexai-backend/upload";

// UPLOAD_BASE_DIR already ends in "upload"; "/upload" is the public URL prefix.
export const UPLOAD_STORAGE_DIR = UPLOAD_BASE_DIR;
export const UPLOAD_URL_PREFIX = "/upload";

export function getUploadStoragePath(...segments: string[]): string {
  return path.join(UPLOAD_STORAGE_DIR, ...segments);
}

export function getUploadPublicPath(...segments: string[]): string {
  return `${UPLOAD_URL_PREFIX}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export async function migrateLegacyGeneratedAdImage(value: unknown): Promise<string> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";

  let pathname: string;
  try {
    pathname = new URL(raw, "https://aarnexai.com").pathname;
  } catch {
    return raw;
  }

  pathname = pathname.replace(/^\/aarnexai-backend(?=\/(?:upload|uploads)\/products\/ads\/)/, "");
  const prefixes = [
    "/upload/upload/products/ads/",
    "/upload/products/ads/",
    "/uploads/products/ads/",
  ];
  const matchingPrefix = prefixes.find((prefix) => pathname.startsWith(prefix));
  if (!matchingPrefix) return raw;

  const fileName = path.basename(pathname.slice(matchingPrefix.length));
  if (!fileName || fileName !== pathname.slice(matchingPrefix.length)) return raw;

  const targetPath = getUploadStoragePath("products", "ads", fileName);
  const sourcePath = matchingPrefix === "/uploads/products/ads/"
    ? path.join(process.cwd(), "public", "uploads", "products", "ads", fileName)
    : path.join(UPLOAD_BASE_DIR, "upload", "products", "ads", fileName);
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return getUploadPublicPath("products", "ads", fileName);
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (matchingPrefix === "/uploads/products/ads/") {
        console.error(`Legacy generated banner file is missing: ${sourcePath}`);
        return raw;
      }
      return getUploadPublicPath("products", "ads", fileName);
    }
    throw error;
  }

  return getUploadPublicPath("products", "ads", fileName);
}
