"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { PublicProduct, PublicSite } from "@/lib/publicBusinessSite";
import "./PublicBusinessWebsite.css";

/* ---------- small helpers ---------- */
const toList = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return text.split(/\r?\n|;|•/).map((s) => s.trim()).filter(Boolean);
};

const formatPrice = (price: unknown): string => {
  if (price === null || price === undefined || price === "") return "";
  const num = Number(String(price).replace(/[^0-9.]/g, ""));
  if (Number.isFinite(num) && num > 0) return `₹${num.toLocaleString("en-IN")}`;
  return String(price);
};

const titleCase = (s: string | null) => (s || "").replace(/\b\w/g, (c) => c.toUpperCase());

const websiteHref = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`);

/* ---------- icons ---------- */
const Icon: React.FC<{ d: string; size?: number }> = ({ d, size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

const ICONS = {
  store: "M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6",
  pin: "M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11zM12 12a2 2 0 100-4 2 2 0 000 4z",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
  tag: "M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01",
  search: "M21 21l-4.3-4.3M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15z",
  close: "M6 6l12 12M18 6L6 18",
  share: "M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5h.01",
};

/* ---------- image with graceful fallback ---------- */
const SafeImage: React.FC<{ src: string | null; alt: string; size?: number }> = ({
  src,
  alt,
  size = 44,
}) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <span className="pbw-ph" aria-hidden="true">
        <Icon d={ICONS.image} size={size} />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
};

/* ---------- product modal ---------- */
const ProductModal: React.FC<{ product: PublicProduct; onClose: () => void }> = ({
  product,
  onClose,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const features = toList(product.features);
  const price = formatPrice(product.price);
  const description = product.description || product.metaDescription || "";

  return (
    <div className="pbw-overlay" onClick={onClose} role="presentation">
      <div
        className="pbw-modal"
        role="dialog"
        aria-modal="true"
        aria-label={product.title || "Product"}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pbw-close" onClick={onClose} aria-label="Close">
          <Icon d={ICONS.close} size={18} />
        </button>
        <div className="pbw-modal-img">
          <SafeImage src={product.imageUrl} alt={product.title || "Product"} size={64} />
        </div>
        <div className="pbw-modal-body">
          {product.category && <span className="pbw-tag">{product.category}</span>}
          <h3>{product.title}</h3>
          {price && <div className="pbw-modal-price">{price}</div>}
          <div className="pbw-meta">
            {product.brand && <span className="pbw-chip">Brand: {product.brand}</span>}
            {product.color && <span className="pbw-chip">Color: {product.color}</span>}
            {product.subcategory && <span className="pbw-chip">{product.subcategory}</span>}
          </div>
          {description && <p>{description}</p>}
          {features.length > 0 && (
            <ul className="pbw-features">
              {features.slice(0, 8).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

/* ---------- main page ---------- */
const PublicBusinessWebsite: React.FC<{ site: PublicSite }> = ({ site }) => {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [selected, setSelected] = useState<PublicProduct | null>(null);
  const [copied, setCopied] = useState(false);

  const products = site.products;

  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => p.category && set.add(p.category));
    return ["All", ...Array.from(set)];
  }, [products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (activeCategory !== "All" && p.category !== activeCategory) return false;
      if (!q) return true;
      const haystack = [p.title, p.brand, p.category, p.subcategory, p.description, ...toList(p.keywords)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [products, query, activeCategory]);

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: site.name || "Business", url });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user cancelled */
    }
  };

  const name = titleCase(site.name) || "Our Business";
  const category = site.category ? titleCase(site.category) : "";
  const heroImages = products.filter((p) => p.imageUrl).slice(0, 2);
  const intro = [
    category ? `${name} is a trusted ${category.toLowerCase()} business` : `${name} is a local business`,
    site.city ? ` based in ${site.city}.` : ".",
    products.length
      ? " Browse our products and get in touch to learn more."
      : " Get in touch to learn more.",
  ].join("");

  return (
    <div className="pbw">
      {/* Header */}
      <header className="pbw-header">
        <div className="pbw-container pbw-header-inner">
          <div className="pbw-brand">
            <span className="pbw-logo">
              {site.logo ? (
                <SafeImage src={site.logo} alt={`${name} logo`} size={22} />
              ) : (
                <Icon d={ICONS.store} />
              )}
            </span>
            <span className="pbw-brand-name">{name}</span>
          </div>
          <nav className="pbw-nav" aria-label="Sections">
            <a href="#about">About</a>
            {products.length > 0 && <a href="#products">Products</a>}
            <a href="#contact" className="pbw-nav-cta">
              Contact
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="pbw-hero">
        <div className="pbw-container pbw-hero-grid">
          <div>
            {category && <span className="pbw-eyebrow">{category}</span>}
            <h1>{name}</h1>
            <p className="pbw-hero-text">{intro}</p>
            <div className="pbw-chips">
              {site.city && (
                <span className="pbw-chip">
                  <Icon d={ICONS.pin} size={15} />
                  {site.city}
                </span>
              )}
              {products.length > 0 && (
                <span className="pbw-chip">
                  <Icon d={ICONS.tag} size={15} />
                  {products.length} products
                </span>
              )}
            </div>
            <div className="pbw-actions">
              {products.length > 0 && (
                <a className="pbw-btn pbw-btn-primary" href="#products">
                  View products
                </a>
              )}
              <button className="pbw-btn pbw-btn-ghost" onClick={share}>
                <Icon d={ICONS.share} size={16} />
                {copied ? "Link copied!" : "Share"}
              </button>
            </div>
          </div>

          <div className="pbw-hero-visual" aria-hidden="true">
            {heroImages.length >= 2 ? (
              heroImages.map((p) => (
                <div className="pbw-hero-tile" key={p.id}>
                  <SafeImage src={p.imageUrl} alt="" size={48} />
                </div>
              ))
            ) : (
              <div className="pbw-hero-single">
                <Icon d={ICONS.store} size={72} />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Stats */}
      <div className="pbw-stats-wrap">
        <div className="pbw-container">
          <div className="pbw-stats">
            <div className="pbw-stat">
              <strong>{products.length}</strong>
              <span>Products</span>
            </div>
            <div className="pbw-stat">
              <strong>{Math.max(categories.length - 1, 0) || 1}</strong>
              <span>Categories</span>
            </div>
            <div className="pbw-stat">
              <strong>{site.city || "—"}</strong>
              <span>Location</span>
            </div>
          </div>
        </div>
      </div>

      {/* About */}
      <section className="pbw-section" id="about">
        <div className="pbw-container pbw-about-grid">
          <div>
            <span className="pbw-kicker">About us</span>
            <h2>Welcome to {name}</h2>
            <p className="pbw-about-copy" style={{ marginTop: 14 }}>
              {intro} We take pride in quality, honest service and a customer-first approach. Explore
              what we offer below and reach out any time — we would love to help you.
            </p>
          </div>
          <div className="pbw-info-card" id="contact">
            {category && (
              <div className="pbw-info-row">
                <span className="pbw-info-icon">
                  <Icon d={ICONS.store} size={18} />
                </span>
                <div>
                  <small>Business type</small>
                  <span>{category}</span>
                </div>
              </div>
            )}
            {site.city && (
              <div className="pbw-info-row">
                <span className="pbw-info-icon">
                  <Icon d={ICONS.pin} size={18} />
                </span>
                <div>
                  <small>Location</small>
                  <span>{site.city}</span>
                </div>
              </div>
            )}
            {site.website && (
              <div className="pbw-info-row">
                <span className="pbw-info-icon">
                  <Icon d={ICONS.globe} size={18} />
                </span>
                <div>
                  <small>Website</small>
                  <a href={websiteHref(site.website)} target="_blank" rel="noreferrer noopener">
                    {site.website}
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Products */}
      {products.length > 0 && (
        <section className="pbw-section pbw-products" id="products">
          <div className="pbw-container">
            <div className="pbw-section-head">
              <span className="pbw-kicker">Our collection</span>
              <h2>Products</h2>
              <p className="pbw-sub">Tap any product to see full details.</p>
            </div>

            <div className="pbw-toolbar">
              <label className="pbw-search">
                <Icon d={ICONS.search} size={18} />
                <input
                  type="search"
                  placeholder="Search products…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search products"
                />
              </label>
              {categories.length > 2 && (
                <div className="pbw-filters" role="tablist" aria-label="Filter by category">
                  {categories.map((c) => (
                    <button
                      key={c}
                      role="tab"
                      aria-selected={activeCategory === c}
                      className={`pbw-filter${activeCategory === c ? " is-active" : ""}`}
                      onClick={() => setActiveCategory(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="pbw-empty">No products match your search.</div>
            ) : (
              <div className="pbw-grid">
                {filtered.map((p) => {
                  const price = formatPrice(p.price);
                  return (
                    <button key={p.id} className="pbw-card" onClick={() => setSelected(p)}>
                      <div className="pbw-card-img">
                        <SafeImage src={p.imageUrl} alt={p.title || "Product"} />
                      </div>
                      <div className="pbw-card-body">
                        {(p.brand || p.category) && <span className="pbw-tag">{p.brand || p.category}</span>}
                        <h3>{p.title}</h3>
                        {(p.description || p.metaDescription) && (
                          <p className="pbw-card-desc">{p.description || p.metaDescription}</p>
                        )}
                        <div className="pbw-card-foot">
                          <span className="pbw-price">{price}</span>
                          <span className="pbw-more">Details →</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* CTA band */}
      <section className="pbw-cta">
        <div className="pbw-container">
          <div className="pbw-cta-inner">
            <div>
              <h2>Interested in {name}?</h2>
              <p>
                {products.length > 0
                  ? "Explore our products, or share this page with someone who needs it."
                  : "Share this page with someone who needs our services."}
              </p>
            </div>
            <div className="pbw-cta-actions">
              {products.length > 0 && (
                <a className="pbw-btn pbw-btn-light" href="#products">
                  Browse products
                </a>
              )}
              {site.website && (
                <a
                  className="pbw-btn pbw-btn-outline-light"
                  href={websiteHref(site.website)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Visit website
                </a>
              )}
              <button className="pbw-btn pbw-btn-outline-light" onClick={share}>
                {copied ? "Link copied!" : "Share"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="pbw-footer">
        <div className="pbw-container pbw-footer-inner">
          <span>
            © {new Date().getFullYear()} <strong>{name}</strong>
            {site.city ? ` · ${site.city}` : ""}
          </span>
          <span>
            Powered by{" "}
            <a href="https://aarnexai.com" target="_blank" rel="noreferrer noopener">
              AarnexAi
            </a>
          </span>
        </div>
      </footer>

      {selected && <ProductModal product={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};

export default PublicBusinessWebsite;