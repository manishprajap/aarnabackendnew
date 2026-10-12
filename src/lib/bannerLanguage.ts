export type BannerLanguage = "Hindi" | "English";

export function normalizeBannerLanguage(value: unknown): BannerLanguage {
  return value === "Hindi" ? "Hindi" : "English";
}

export function getBannerLanguageInstructions(language: BannerLanguage): string[] {
  return language === "Hindi"
    ? [
        "LANGUAGE: Write every newly generated marketing headline, greeting, offer, supporting line and call-to-action in natural Hindi using Devanagari script.",
        "Keep registered brand names, product names, logos, existing text on the supplied product, mobile numbers, and addresses exactly as provided. Do not add English translations or romanized Hindi.",
      ]
    : [
        "LANGUAGE: Write every newly generated marketing headline, greeting, offer, supporting line and call-to-action in clear English.",
        "Keep registered brand names, product names, logos, existing text on the supplied product, mobile numbers, and addresses exactly as provided. Do not add translations in another language.",
      ];
}
