export function isPoliticalCategory(value: unknown): boolean {
  const category = typeof value === "string" ? value.trim().slice(0, 100) : "";
  return /\bpolitic(?:s|al|ian)?\b|\belection\b|\bpublic representative\b/i.test(category);
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
  if (/\b(navratri|diwali|deepavali|govardhan(?:\s+puja)?|puja)\b/i.test(topic)) {
    instructions.push(
      "FESTIVAL GREETING: make the named occasion the focus using tasteful Indian festive decoration, colors and motifs. Keep the politician clearly visible and give the artwork a polished greeting-banner composition.",
    );
  }
  instructions.push(
    "Do not invent a party name, party symbol, flag, title, public office, promise, endorsement, slogan or contact detail.",
  );
  return instructions;
}
