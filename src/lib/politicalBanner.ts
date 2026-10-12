export function isProfessionalPortraitCategory(value: unknown): boolean {
  const category = typeof value === "string" ? value.trim().slice(0, 100) : "";
  return /\bpolitic(?:s|al|ian)?\b|\belection\b|\bpublic representative\b|\bdoctor\b|\bphysician\b|\bmedical\b|\bhealthcare\b|\bclinic\b|\bchartered accountant\b|\baccountant\b|\bca\b/i.test(category);
}

export function isPoliticalCategory(value: unknown): boolean {
  const category = typeof value === "string" ? value.trim().slice(0, 100) : "";
  return /\bpolitic(?:s|al|ian)?\b|\belection\b|\bpublic representative\b/i.test(category);
}

export function getProfessionalBannerInstructions(industry: string): string[] {
  const value = industry.toLowerCase();
  const title = /\bpolitic(?:s|al|ian)?\b|\belection\b|\bpublic representative\b/.test(value)
    ? "politician"
    : /\bdoctor\b|\bphysician\b|\bmedical\b|\bhealthcare\b|\bclinic\b/.test(value)
      ? "doctor or healthcare professional"
      : "chartered accountant";
  return [
    `PROFESSIONAL PORTRAIT: use the supplied ${title} photo prominently and faithfully as the same real person. Preserve facial identity; do not substitute the person or add extra people.`,
    "Keep a polished, trustworthy professional advertising composition and leave clear space for contact information.",
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
