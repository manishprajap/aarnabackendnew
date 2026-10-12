import sharp from "sharp";
import type { BannerLanguage } from "@/lib/bannerLanguage";

export type Festival = {
  name: string;
  greeting: string;
  hindiGreeting: string;
  visualDirection: string;
  startsOn: string;
  endsOn: string;
  aliases: RegExp;
};

const FESTIVALS_2026: Festival[] = [
  {
    name: "Sharad Navratri",
    greeting: "Happy Navratri",
    hindiGreeting: "नवरात्रि की हार्दिक शुभकामनाएँ",
    visualDirection: "garba dandiya lights, marigold flowers, traditional toran and auspicious red-gold festive details",
    startsOn: "2026-10-11",
    endsOn: "2026-10-16",
    aliases: /\b(?:sharad\s+)?navratri\b|नवरात्रि|नवरात्री/i,
  },
  {
    name: "Durga Puja",
    greeting: "Happy Durga Puja",
    hindiGreeting: "दुर्गा पूजा की हार्दिक शुभकामनाएँ",
    visualDirection: "elegant Durga Puja alpana, dhak-inspired festive details, red-white flowers and warm pandal lights",
    startsOn: "2026-10-17",
    endsOn: "2026-10-19",
    aliases: /\bdurga\s+puja\b|दुर्गा पूजा/i,
  },
  {
    name: "Dussehra",
    greeting: "Happy Dussehra",
    hindiGreeting: "दशहरा की हार्दिक शुभकामनाएँ",
    visualDirection: "tasteful Dussehra celebration with marigold decorations and a warm golden festive glow",
    startsOn: "2026-10-20",
    endsOn: "2026-10-20",
    aliases: /\b(?:dussehra|vijaya\s+dashami|vijayadashami)\b|दशहरा|विजयादशमी/i,
  },
  {
    name: "Diwali",
    greeting: "Happy Diwali",
    hindiGreeting: "दीपावली की हार्दिक शुभकामनाएँ",
    visualDirection: "glowing diyas, tasteful rangoli, marigold garlands and elegant warm gold festive lights",
    startsOn: "2026-11-08",
    endsOn: "2026-11-08",
    aliases: /\b(?:diwali|deepavali)\b|दिवाली|दीपावली/i,
  },
  {
    name: "Govardhan Puja",
    greeting: "Happy Govardhan Puja",
    hindiGreeting: "गोवर्धन पूजा की हार्दिक शुभकामनाएँ",
    visualDirection: "respectful Govardhan Puja motifs, a small symbolic Govardhan hill, flowers and devotional festive colors",
    startsOn: "2026-11-09",
    endsOn: "2026-11-09",
    aliases: /\bgovardhan(?:\s+puja)?\b|गोवर्धन पूजा/i,
  },
  {
    name: "Bhai Dooj",
    greeting: "Happy Bhai Dooj",
    hindiGreeting: "भाई दूज की हार्दिक शुभकामनाएँ",
    visualDirection: "warm Bhai Dooj family-festival details with a subtle tilak thali, flowers and diyas",
    startsOn: "2026-11-10",
    endsOn: "2026-11-10",
    aliases: /\bbhai\s*dooj\b|\bbhaiya\s*dooj\b|भाई दूज|भैया दूज/i,
  },
  {
    name: "Eid al-Fitr",
    greeting: "Eid Mubarak",
    hindiGreeting: "ईद मुबारक",
    visualDirection: "elegant crescent moon, soft lantern light, geometric Islamic art and tasteful festive greenery",
    startsOn: "2026-03-20",
    endsOn: "2026-03-21",
    aliases: /\b(?:eid(?:\s+al)?\s*[- ]?fitr|eid ul fitr|ramzan eid)\b|ईद(?:\s*उल\s*फितर)?/i,
  },
  {
    name: "Eid al-Adha",
    greeting: "Eid Mubarak",
    hindiGreeting: "ईद-उल-अज़हा मुबारक",
    visualDirection: "elegant crescent moon, refined lantern light, geometric Islamic art and a dignified Eid gathering atmosphere",
    startsOn: "2026-05-27",
    endsOn: "2026-05-28",
    aliases: /\b(?:eid(?:\s+al)?\s*[- ]?adha|eid ul adha|bakrid|bakra eid)\b|ईद(?:\s*उल\s*अज़हा)?|बकरीद/i,
  },
];

export function detectFestival(dateValue: unknown, text = ""): Festival | null {
  const date = dateValue instanceof Date
    ? dateValue.toISOString().slice(0, 10)
    : typeof dateValue === "string" && /^\d{4}-\d{2}-\d{2}/.test(dateValue)
      ? dateValue.slice(0, 10)
      : "";
  const normalizedText = String(text || "");
  const explicitlyMentioned = FESTIVALS_2026.find((festival) => festival.aliases.test(normalizedText));
  const dateMatch = FESTIVALS_2026.find((festival) => date >= festival.startsOn && date <= festival.endsOn);
  if (explicitlyMentioned && dateMatch?.name === explicitlyMentioned.name) return dateMatch;
  if (explicitlyMentioned) return explicitlyMentioned;

  return dateMatch ?? null;
}

export function getFestivalBannerInstructions(
  festival: Festival,
  language: BannerLanguage = "English",
): string[] {
  const greeting = language === "Hindi" ? festival.hindiGreeting : festival.greeting;
  return [
    `FESTIVAL: This is a ${festival.name} greeting banner. Make the festival the main occasion, using ${festival.visualDirection}.`,
    `Include the exact prominent greeting "${greeting}". Keep it readable and spelled exactly.`,
    "Create an attractive celebratory greeting-card composition appropriate to the business category, without turning it into an unrelated product sale.",
    "Do not add religious claims, political endorsements, party symbols, invented offers or unrelated religious symbols.",
  ];
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

export async function addFestivalGreetingOverlay(
  image: Buffer,
  festival: Festival,
  language: BannerLanguage = "English",
): Promise<Buffer> {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Could not read generated festival banner dimensions.");

  const width = metadata.width;
  const stripHeight = Math.min(142, Math.max(96, Math.round(metadata.height * 0.15)));
  const greeting = language === "Hindi" ? festival.hindiGreeting : festival.greeting;
  const greetingFontFamily = language === "Hindi"
    ? "Noto Sans Devanagari, Noto Sans, sans-serif"
    : "Noto Sans, sans-serif";
  const greetingFontSize = Math.min(44, Math.round(width / Math.max(greeting.length * 0.58, 10)));
  const svg = Buffer.from(`
    <svg width="${width}" height="${stripHeight}" viewBox="0 0 ${width} ${stripHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#10243ccc"/>
      <text x="50%" y="${Math.round(stripHeight * 0.43)}" text-anchor="middle"
        font-family="${greetingFontFamily}" font-size="${greetingFontSize}" font-weight="700"
        fill="#fff">${escapeXml(greeting)}</text>
    </svg>
  `);

  return sharp(image)
    .composite([{ input: svg, gravity: "north" }])
    .toBuffer();
}

export async function addBusinessContactOverlay(
  image: Buffer,
  details: { mobile: string; address: string; language?: BannerLanguage },
): Promise<Buffer> {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Could not read generated banner dimensions.");

  const width = metadata.width;
  const height = Math.min(112, Math.max(76, Math.round(metadata.height * 0.13)));
  const phone = details.mobile.trim().slice(0, 24);
  const address = details.address.trim().slice(0, 100);
  const callLabel = details.language === "Hindi" ? "अभी कॉल करें" : "CALL NOW";
  const labelSize = Math.max(14, Math.round(width * 0.025));
  const detailSize = Math.max(12, Math.round(width * 0.019));
  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#10243ce8"/>
      <rect x="${Math.round(width * 0.035)}" y="${Math.round(height * 0.12)}"
        width="${Math.round(width * 0.23)}" height="${Math.round(height * 0.36)}" rx="${Math.round(height * 0.12)}"
        fill="#f39224"/>
      <text x="${Math.round(width * 0.15)}" y="${Math.round(height * 0.37)}" text-anchor="middle"
        font-family="Noto Sans Devanagari, Arial, sans-serif" font-size="${labelSize}" font-weight="700" fill="#10243c">${escapeXml(callLabel)}</text>
      <text x="${Math.round(width * 0.30)}" y="${Math.round(height * 0.36)}"
        font-family="Arial, sans-serif" font-size="${detailSize}" font-weight="700" fill="#fff">${escapeXml(phone)}</text>
      <text x="${Math.round(width * 0.035)}" y="${Math.round(height * 0.82)}"
        font-family="Arial, sans-serif" font-size="${detailSize}" fill="#fff">${escapeXml(address)}</text>
    </svg>
  `);

  return sharp(image)
    .composite([{ input: svg, gravity: "south" }])
    .toBuffer();
}
