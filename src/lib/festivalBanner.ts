import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { festivals } from "@/db/schema";
import type { BannerLanguage } from "@/lib/bannerLanguage";

export type Festival = {
  id: number;
  slug: string;
  name: string;
  nameHi: string | null;
  festivalDate: string;
  festivalType: string;
  religion: string;
  description: string | null;
};

const INDIA_TIME_ZONE = "Asia/Kolkata";

export function getIndiaDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const festivalColumns = {
  id: festivals.id,
  slug: festivals.slug,
  name: festivals.name,
  nameHi: festivals.nameHi,
  festivalDate: festivals.festivalDate,
  festivalType: festivals.festivalType,
  religion: festivals.religion,
  description: festivals.description,
};

export async function getUpcomingFestivals(daysAhead = 2): Promise<Festival[]> {
  const today = getIndiaDate();
  return db
    .select(festivalColumns)
    .from(festivals)
    .where(and(
      eq(festivals.isActive, true),
      gte(festivals.festivalDate, today),
      lte(festivals.festivalDate, addDays(today, Math.max(0, Math.min(daysAhead, 7)))),
    ))
    .orderBy(asc(festivals.festivalDate), asc(festivals.name));
}

export async function getFestivalsForDate(date: unknown): Promise<Festival[]> {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  return db
    .select(festivalColumns)
    .from(festivals)
    .where(and(eq(festivals.isActive, true), eq(festivals.festivalDate, date)))
    .orderBy(asc(festivals.name));
}

export async function getSelectedUpcomingFestivals(ids: unknown): Promise<Festival[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new Error("Festival selections must be an array of IDs.");
  if (ids.length === 0) return [];
  const parsedIds = ids.map(Number);
  if (parsedIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("Festival selections must contain valid IDs.");
  }
  const uniqueIds = [...new Set(parsedIds)];
  const today = getIndiaDate();
  const selected = await db
    .select(festivalColumns)
    .from(festivals)
    .where(and(
      eq(festivals.isActive, true),
      inArray(festivals.id, uniqueIds),
      gte(festivals.festivalDate, today),
      lte(festivals.festivalDate, addDays(today, 2)),
    ))
    .orderBy(asc(festivals.festivalDate), asc(festivals.name));
  if (selected.length !== uniqueIds.length) {
    throw new Error("One or more selected occasions are no longer available. Refresh the list and try again.");
  }
  return selected;
}

export function getFestivalBannerInstructions(
  selectedFestivals: Festival[],
  language: BannerLanguage = "English",
): string[] {
  if (selectedFestivals.length === 0) return [];

  const occasionLines = selectedFestivals.map((festival) => {
    const title = language === "Hindi" && festival.nameHi ? festival.nameHi : festival.name;
    const description = festival.description?.trim();
    return `- ${title}${description ? `: ${description}` : ""}`;
  });
  const titles = selectedFestivals.map((festival) =>
    language === "Hindi" && festival.nameHi ? festival.nameHi : festival.name,
  );

  return [
    `OCCASION GREETING BANNER: Create one unified banner that respectfully includes all selected occasions: ${titles.join(", ")}.`,
    ...occasionLines,
    `Include one concise, legible greeting for each selected occasion in ${language}. Keep all wishes together in this same banner; do not create separate banners.`,
    "Use visual motifs that suit the selected occasions and keep the overall composition polished, readable, and appropriate for the business.",
    "Do not add unrelated religious symbols, political endorsements, invented offers, or unsupported claims.",
  ];
}

export function getFestivalTheme(selectedFestivals: Festival[]): string | null {
  return selectedFestivals.length
    ? selectedFestivals.map((festival) => festival.name).join(" + ")
    : null;
}

export function getFestivalCaption(
  selectedFestivals: Festival[],
  language: BannerLanguage,
): string {
  return selectedFestivals
    .map((festival) => language === "Hindi" && festival.nameHi
      ? `${festival.nameHi} की हार्दिक शुभकामनाएँ`
      : `Wishing you a happy ${festival.name}`)
    .join("\n");
}
