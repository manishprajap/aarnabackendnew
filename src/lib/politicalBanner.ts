export function isProfessionalPortraitCategory(value: unknown): boolean {
  const category = typeof value === "string" ? value.trim().slice(0, 100) : "";
  return /\bpolitic(?:s|al|ian)?\b|\belection\b|\bpublic representative\b|\bdoctor\b|\bphysician\b|\bmedical\b|\bhealthcare\b|\bclinic\b|\bchartered accountant\b|\baccountant\b|\bca\b/i.test(category);
}

export function isPoliticalCategory(value: unknown): boolean {
  const category = typeof value === "string" ? value.trim().slice(0, 100) : "";
  return /\bpolitic(?:s|al|ian)?\b|\belection\b|\bpublic representative\b/i.test(category);
}

export function getProfessionalBannerInstructions(
  industry: string,
  festivalGreeting = false,
  hasBusinessLogo = false,
): string[] {
  const value = industry.toLowerCase();
  const title = /\bpolitic(?:s|al|ian)?\b|\belection\b|\bpublic representative\b/.test(value)
    ? "politician"
    : /\bdoctor\b|\bphysician\b|\bmedical\b|\bhealthcare\b|\bclinic\b/.test(value)
      ? "doctor or healthcare professional"
      : "chartered accountant";
  return [
    `IMAGE REFERENCES: the supplied ${title} portrait is only a person/identity reference. Use this person exactly once as a single prominent portrait in the main banner; preserve their identity and do not duplicate them, crop a second headshot, or place their face in a logo/thumbnail.`,
    ...(hasBusinessLogo
      ? ["The separately supplied business logo is a distinct brand asset. Use that exact logo once in the top-left brand area, without replacing it with a face, redrawing it, or inventing another logo."]
      : ["No business logo image is attached. Do not invent a logo or use the professional portrait as a logo; leave a clean brand area for the real clinic name."]),
    ...(festivalGreeting
      ? [
        "FESTIVAL BANNER COMPOSITION: create a premium, polished wide landscape greeting-card design (not a photo of a billboard or storefront). Place the real professional portrait large on the right half; place one clear festival greeting and a short category-appropriate wish in the center-left; reserve a small uncluttered area at top-left for the real clinic/business logo and exact name.",
        "Use professional clinic-branding quality: balanced spacing, clean typography, a restrained festive color palette, subtle festival motifs, and one strong visual focal point. Avoid clutter, repeated text, unrelated people, stock photos, and multiple versions of the doctor.",
        "Keep the bottom 22% as a simple, empty, full-width dark maroon or deep-navy contact band; do not put artwork, portrait, greeting, text, or decorative objects in this reserved band. The exact address, mobile number, and call-to-action will be added there separately.",
        "Do not draw a top header bar. Keep all festival artwork, portrait, and greeting above the reserved contact band, without overlapping one another.",
        ...(title === "doctor or healthcare professional"
          ? ["Use a short warm festival wish connected to wellbeing; do not invent medical advice, treatment claims, or guaranteed health outcomes."]
          : []),
      ]
      : [
        "Keep a polished, trustworthy professional advertising composition and leave a clear, uncluttered area for the real business logo and name at top-left and a dedicated contact band at the bottom. Do not use a storefront mockup, collage, or extra portrait.",
      ]),
  ];
}

export function validatePoliticianPortrait(value: FormDataEntryValue | null): File | null {
  if (value === null) return null;
  if (!(value instanceof File)) throw new Error("Politician portrait must be an image file.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(value.type)) {
    throw new Error("Politician portrait must be a JPG, PNG or WEBP image.");
  }
  if (value.size <= 0 || value.size > 10 * 1024 * 1024) {
    throw new Error("Politician portrait must be 10 MB or smaller.");
  }
  return value;
}

export function getPoliticalBannerInstructions(topic: string): string[] {
  const instructions = [
    "POLITICAL LEADER BANNER STYLE: create a polished Indian political leader's social-media campaign/festival banner, not a generic business advertisement.",
    "Use the supplied politician portrait as a large, prominent, photorealistic half-body portrait. Preserve the person's exact identity and facial features; do not substitute, beautify into another person, or add other people.",
  ];
  if (topic) instructions.push(`Keep the campaign context: ${topic}`);
  instructions.push(
    "Do not invent a party name, party symbol, flag, title, public office, promise, endorsement, slogan or contact detail.",
  );
  return instructions;
}
