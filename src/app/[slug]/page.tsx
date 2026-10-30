import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicBusinessSite } from "@/lib/publicBusinessSite";
import PublicBusinessWebsite from "@/components/public-site/PublicBusinessWebsite";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await getPublicBusinessSite(slug);
  if (!site) return { title: "Page not found" };

  const name = site.name || "Business";
  const description = [
    site.category ? `${name} - ${site.category}` : name,
    site.city ? `in ${site.city}` : "",
    site.products.length ? `Browse ${site.products.length} products.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    title: name,
    description,
    openGraph: {
      title: name,
      description,
      images: site.logo ? [site.logo] : undefined,
    },
  };
}

export default async function PublicBusinessPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await getPublicBusinessSite(slug);
  if (!site) notFound();
  return <PublicBusinessWebsite site={site} />;
}