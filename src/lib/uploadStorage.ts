import path from "node:path";

export const UPLOAD_BASE_DIR =
  process.env.UPLOAD_DIR || "/var/www/aarnexai.com/aarnexai-backend/upload";

export const UPLOAD_STORAGE_DIR = path.join(UPLOAD_BASE_DIR, "upload");
export const UPLOAD_URL_PREFIX = "/upload/upload";

export function getUploadStoragePath(...segments: string[]): string {
  return path.join(UPLOAD_STORAGE_DIR, ...segments);
}

export function getUploadPublicPath(...segments: string[]): string {
  return `${UPLOAD_URL_PREFIX}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
