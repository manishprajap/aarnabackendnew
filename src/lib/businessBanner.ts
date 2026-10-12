import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
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

export interface BusinessLogo {
  buffer: Buffer;
  mimeType: string;
}

export interface BusinessIdentityDetails {
  businessName: string;
  personName: string;
  category: string;
  mobile: string;
  address: string;
  professional: boolean;
  logo: BusinessLogo | null;
}

export async function readBusinessLogo(userId: number, fileName: unknown): Promise<BusinessLogo | null> {
  if (typeof fileName !== "string" || !fileName.trim()) return null;
  const safeName = path.basename(fileName);
  if (safeName !== fileName || !safeName.startsWith(`${userId}-`)) {
    throw new Error("Stored business logo path is invalid.");
  }

  const extension = path.extname(safeName).toLowerCase();
  const mimeType = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".png"
      ? "image/png"
      : extension === ".webp"
        ? "image/webp"
        : extension === ".gif"
          ? "image/gif"
          : null;
  if (!mimeType) throw new Error("Stored business logo has an unsupported image format.");

  let buffer: Buffer;
  try {
    buffer = await readFile(getUploadStoragePath(safeName));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    buffer = await readFile(getUploadStoragePath("upload", safeName));
  }
  return { buffer, mimeType };
}

export async function getBusinessBrandingHeaderHeight(image: Buffer): Promise<number> {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Could not read generated banner dimensions.");
  return Math.min(132, Math.max(88, Math.round(metadata.height * 0.12)));
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    const escaped: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;",
    };
    return escaped[character];
  });
}

function addressLines(value: string): [string, string] {
  const words = value.trim().slice(0, 140).split(/\s+/).filter(Boolean);
  if (words.length < 5) return [words.join(" "), ""];
  let first = "";
  let split = 0;
  while (split < words.length && `${first} ${words[split]}`.trim().length <= 55) {
    first = `${first} ${words[split]}`.trim();
    split++;
  }
  return [first, words.slice(split).join(" ")];
}

export async function addBusinessIdentityOverlay(
  image: Buffer,
  details: BusinessIdentityDetails,
): Promise<Buffer> {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Could not read generated banner dimensions.");
  const width = metadata.width;
  const headerHeight = await getBusinessBrandingHeaderHeight(image);
  const safeBusinessName = details.businessName.trim().slice(0, 100);
  const safePersonName = details.personName.trim().slice(0, 80);
  const isDoctor = /\bdoctor\b|\bphysician\b|\bmedical\b|\bhealthcare\b|\bclinic\b/i.test(details.category);
  const personLabel = safePersonName && isDoctor && !/^dr\.?\s/i.test(safePersonName)
    ? `Dr. ${safePersonName}`
    : safePersonName;
  const primary = details.professional ? personLabel || safeBusinessName : safeBusinessName || personLabel;
  const secondary = primary === safeBusinessName
    || (personLabel && safeBusinessName.toLowerCase() === personLabel.toLowerCase())
    ? details.category.trim().slice(0, 80)
    : safeBusinessName;
  const textX = details.logo ? Math.round(headerHeight * 1.12) : Math.round(width * 0.045);
  const textWidth = Math.max(1, width - textX - Math.round(width * 0.04));
  const nameSize = Math.max(20, Math.min(40, Math.round(headerHeight * 0.34)));
  const secondarySize = Math.max(14, Math.min(24, Math.round(headerHeight * 0.20)));
  const headerSvg = Buffer.from(`
    <svg width="${width}" height="${headerHeight}" viewBox="0 0 ${width} ${headerHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#10243cf2"/>
      <text x="${textX}" y="${Math.round(headerHeight * 0.48)}"
        font-family="Arial, sans-serif" font-size="${nameSize}" font-weight="700" fill="#fff"
        textLength="${Math.max(1, Math.round(textWidth * 0.94))}" lengthAdjust="spacingAndGlyphs">${escapeXml(primary || "Business")}</text>
      <text x="${textX}" y="${Math.round(headerHeight * 0.80)}"
        font-family="Arial, sans-serif" font-size="${secondarySize}" font-weight="500" fill="#dbeafe"
        textLength="${Math.max(1, Math.round(textWidth * 0.78))}" lengthAdjust="spacingAndGlyphs">${escapeXml(secondary)}</text>
    </svg>
  `);

  const overlays: OverlayOptions[] = [{ input: headerSvg, left: 0, top: 0 }];
  if (details.logo) {
    const logoBuffer = await sharp(details.logo.buffer)
      .rotate()
      .resize(Math.round(headerHeight * 0.72), Math.round(headerHeight * 0.72), { fit: "contain" })
      .png()
      .toBuffer();
    overlays.push({
      input: logoBuffer,
      left: Math.round(headerHeight * 0.14),
      top: Math.round(headerHeight * 0.14),
    });
  }

  let output = await sharp(image).composite(overlays).toBuffer();
  if (!details.professional) return output;

  const outputMetadata = await sharp(output).metadata();
  if (!outputMetadata.width || !outputMetadata.height) throw new Error("Could not read branded banner dimensions.");
  const footerHeight = Math.min(156, Math.max(104, Math.round(outputMetadata.height * 0.15)));
  const [firstAddressLine, secondAddressLine] = addressLines(details.address);
  const callWidth = Math.round(width * 0.25);
  const contactFontSize = Math.max(15, Math.round(width * 0.021));
  const addressFontSize = Math.max(12, Math.round(width * 0.016));
  const footerSvg = Buffer.from(`
    <svg width="${width}" height="${footerHeight}" viewBox="0 0 ${width} ${footerHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#10243cf2"/>
      <rect x="${Math.round(width * 0.035)}" y="${Math.round(footerHeight * 0.12)}"
        width="${callWidth}" height="${Math.round(footerHeight * 0.40)}" rx="${Math.round(footerHeight * 0.12)}"
        fill="#f39224"/>
      <text x="${Math.round(width * 0.035) + callWidth / 2}" y="${Math.round(footerHeight * 0.39)}"
        text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(15, Math.round(width * 0.025))}"
        font-weight="700" fill="#10243c">CALL NOW</text>
      <text x="${Math.round(width * 0.32)}" y="${Math.round(footerHeight * 0.38)}"
        font-family="Arial, sans-serif" font-size="${contactFontSize}" font-weight="700"
        fill="#fff">${escapeXml(details.mobile.trim().slice(0, 24))}</text>
      <text x="${Math.round(width * 0.035)}" y="${Math.round(footerHeight * 0.72)}"
        font-family="Arial, sans-serif" font-size="${addressFontSize}" fill="#fff">${escapeXml(firstAddressLine)}</text>
      ${secondAddressLine ? `<text x="${Math.round(width * 0.035)}" y="${Math.round(footerHeight * 0.91)}"
        font-family="Arial, sans-serif" font-size="${addressFontSize}" fill="#fff">${escapeXml(secondAddressLine)}</text>` : ""}
    </svg>
  `);
  output = await sharp(output).composite([{ input: footerSvg, gravity: "south" }]).toBuffer();
  return output;
}

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
