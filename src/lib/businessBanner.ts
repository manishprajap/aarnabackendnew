import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { BannerLanguage } from "@/lib/bannerLanguage";
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
  bannerLanguage: BannerLanguage;
  professional: boolean;
  festival: boolean;
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
  const words = value.trim().slice(0, 180).split(/\s+/).filter(Boolean);
  if (words.length < 5) return [words.join(" "), ""];
  let first = "";
  let split = 0;
  while (split < words.length && `${first} ${words[split]}`.trim().length <= 90) {
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
  const safeBusinessName = details.businessName.trim().slice(0, 100);
  const safePersonName = details.personName.trim().slice(0, 80);
  const isDoctor = /\bdoctor\b|\bphysician\b|\bmedical\b|\bhealthcare\b|\bclinic\b/i.test(details.category);
  const personLabel = safePersonName && isDoctor && !/^dr\.?\s/i.test(safePersonName)
    ? `Dr. ${safePersonName}`
    : safePersonName;
  if (!details.professional) return image;

  const footerHeight = Math.min(220, Math.max(170, Math.round(metadata.height * 0.22)));
  const brandHeight = Math.min(130, Math.max(90, Math.round(metadata.height * 0.14)));
  const brandWidth = Math.round(width * 0.48);
  const [firstAddressLine, secondAddressLine] = addressLines(details.address);
  const sidePadding = Math.round(width * 0.045);
  const clinicName = safeBusinessName || personLabel || "Business";
  const mobile = details.mobile.trim().slice(0, 24) || "Not provided";
  const mobileLabel = details.bannerLanguage === "Hindi" ? "मोबाइल" : "Mobile";
  const callLabel = details.bannerLanguage === "Hindi" ? "अभी कॉल करें" : "CALL NOW";
  const brandTextX = details.logo ? Math.round(brandHeight * 0.94) : Math.round(brandHeight * 0.12);
  const brandTextWidth = Math.max(1, brandWidth - brandTextX - Math.round(brandHeight * 0.12));
  const brandNameSize = Math.max(
    12,
    Math.min(36, Math.round(brandHeight * 0.28), Math.floor(brandTextWidth / Math.max(clinicName.length * 0.58, 1))),
  );
  const longestAddressLine = Math.max(firstAddressLine.length, secondAddressLine.length, 1);
  const addressFontSize = Math.max(
    10,
    Math.min(
      20,
      Math.round(width * 0.016),
      Math.floor((width * 0.53) / (longestAddressLine * 0.58)),
    ),
  );
  const contactFontSize = Math.max(18, Math.min(34, Math.round(width * 0.026)));
  const phoneFontSize = Math.max(
    15,
    Math.min(contactFontSize, Math.floor((width * 0.22) / Math.max(mobile.length * 0.58, 1))),
  );
  const brandPanel = Buffer.from(`
    <svg width="${brandWidth}" height="${brandHeight}" viewBox="0 0 ${brandWidth} ${brandHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" rx="${Math.round(brandHeight * 0.14)}" fill="#fffaf0"/>
      <text x="${brandTextX}" y="${Math.round(brandHeight * 0.58)}"
        font-family="Arial, sans-serif" font-size="${brandNameSize}" font-weight="700"
        fill="#10243c">${escapeXml(clinicName)}</text>
    </svg>
  `);
  const overlays: OverlayOptions[] = [
    { input: brandPanel, left: Math.round(width * 0.025), top: Math.round(metadata.height * 0.025) },
  ];
  if (details.logo) {
    const logoSize = Math.round(brandHeight * 0.72);
    const logoBuffer = await sharp(details.logo.buffer)
      .rotate()
      .resize(logoSize, logoSize, { fit: "contain" })
      .png()
      .toBuffer();
    overlays.push({
      input: logoBuffer,
      left: Math.round(width * 0.025) + Math.round(brandHeight * 0.12),
      top: Math.round(metadata.height * 0.025) + Math.round(brandHeight * 0.14),
    });
  }
  const festivalStyle = details.festival;
  const footerColor = festivalStyle ? "#8f1022" : "#10243c";
  const footerSvg = Buffer.from(`
    <svg width="${width}" height="${footerHeight}" viewBox="0 0 ${width} ${footerHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${footerColor}"/>
      <path d="M0 0 H${width} V${Math.round(footerHeight * 0.06)} Q${Math.round(width * 0.5)} ${Math.round(footerHeight * 0.20)} 0 ${Math.round(footerHeight * 0.06)} Z" fill="#efbd39"/>
      <text x="${sidePadding}" y="${Math.round(footerHeight * 0.43)}"
        font-family="Arial, sans-serif" font-size="${addressFontSize}" font-weight="600"
        fill="#fff">${escapeXml(firstAddressLine || "Address not provided")}</text>
      ${secondAddressLine ? `<text x="${sidePadding}" y="${Math.round(footerHeight * 0.70)}"
        font-family="Arial, sans-serif" font-size="${addressFontSize}" font-weight="600"
        fill="#fff">${escapeXml(secondAddressLine)}</text>` : ""}
      <path d="M${Math.round(width * 0.62)} ${Math.round(footerHeight * 0.20)} V${Math.round(footerHeight * 0.84)}" stroke="#f5d36b" stroke-width="2" opacity="0.8"/>
      <circle cx="${Math.round(width * 0.70)}" cy="${Math.round(footerHeight * 0.50)}" r="${Math.round(footerHeight * 0.22)}" fill="#f5d36b"/>
      <path d="M${Math.round(width * 0.685)} ${Math.round(footerHeight * 0.40)} q${Math.round(footerHeight * 0.02)} -${Math.round(footerHeight * 0.06)} ${Math.round(footerHeight * 0.07)} 0 l${Math.round(footerHeight * 0.04)} ${Math.round(footerHeight * 0.06)} q${Math.round(footerHeight * 0.02)} ${Math.round(footerHeight * 0.04)} -${Math.round(footerHeight * 0.02)} ${Math.round(footerHeight * 0.06)} q-${Math.round(footerHeight * 0.10)} -${Math.round(footerHeight * 0.05)} -${Math.round(footerHeight * 0.13)} -${Math.round(footerHeight * 0.14)} q${Math.round(footerHeight * 0.02)} -${Math.round(footerHeight * 0.03)} ${Math.round(footerHeight * 0.04)} -${Math.round(footerHeight * 0.02)} Z" fill="#8f1022"/>
      <text x="${Math.round(width * 0.75)}" y="${Math.round(footerHeight * 0.37)}"
        font-family="Arial, sans-serif" font-size="${Math.max(14, Math.round(width * 0.018))}" font-weight="600"
        fill="#fff">${mobileLabel}</text>
      <text x="${Math.round(width * 0.75)}" y="${Math.round(footerHeight * 0.70)}"
        font-family="Arial, sans-serif" font-size="${phoneFontSize}" font-weight="700"
        fill="#f5d36b">${escapeXml(mobile)}</text>
      <rect x="${Math.round(width * 0.75)}" y="${Math.round(footerHeight * 0.77)}"
        width="${Math.round(width * 0.22)}" height="${Math.round(footerHeight * 0.19)}"
        rx="${Math.round(footerHeight * 0.07)}" fill="#f5d36b"/>
      <text x="${Math.round(width * 0.86)}" y="${Math.round(footerHeight * 0.91)}" text-anchor="middle"
        font-family="Arial, sans-serif" font-size="${Math.max(12, Math.round(width * 0.015))}" font-weight="700"
        fill="${footerColor}">${callLabel}</text>
    </svg>
  `);
  return sharp(image)
    .composite([
      ...overlays,
      { input: footerSvg, left: 0, top: metadata.height - footerHeight },
    ])
    .toBuffer();
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
