"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { PublicProduct, PublicSite } from "@/lib/publicBusinessSite";
import "./PublicBusinessWebsite.css";
import "./PublicBusinessWebsite.store.css";
import "./PublicBusinessWebsite.extra.css";

/**
 * The backend runs under a Next.js basePath. fetch() does NOT add it automatically,
 * so API calls from the browser must include it. Keep in sync with next.config.ts.
 */
const BASE_PATH = "/aarnexai-backend";
const MAX_QTY = 20;

/* ---------- helpers ---------- */
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

const formatMoney = (value: number): string =>
  `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const titleCase = (s: string | null) => (s || "").replace(/\b\w/g, (c) => c.toUpperCase());

const websiteHref = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`);

/** Renders **bold** inside a line of text. */
const renderInline = (text: string): React.ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );

/**
 * Minimal rich text for the About text: blank-line separated paragraphs,
 * "- item" / "* item" bullet lists and **bold**.
 */
const renderRichText = (text: string): React.ReactNode[] => {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(<p key={`p${blocks.length}`}>{renderInline(paragraph.join(" "))}</p>);
      paragraph = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`u${blocks.length}`}>
          {bullets.map((b, i) => (
            <li key={i}>{renderInline(b)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };

  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (!line) {
      flushParagraph();
      flushBullets();
    } else if (bullet) {
      flushParagraph();
      bullets.push(bullet[1]);
    } else {
      flushBullets();
      paragraph.push(line);
    }
  });
  flushParagraph();
  flushBullets();
  return blocks;
};

/* ---------- Razorpay (loaded on demand) ---------- */
interface RazorpayInstance {
  open(): void;
  on(event: string, callback: (response: { error?: { description?: string } }) => void): void;
}
interface RazorpayConstructor {
  new (options: Record<string, unknown>): RazorpayInstance;
}
const getRazorpay = () => (window as unknown as { Razorpay?: RazorpayConstructor }).Razorpay;

function loadRazorpay(): Promise<boolean> {
  if (getRazorpay()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(Boolean(getRazorpay()));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

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
  cart: "M3 4h2l2.4 11.2a1 1 0 001 .8h8.9a1 1 0 001-.8L20 8H6M10 20h.01M17 20h.01",
  check: "M5 13l4 4L19 7",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  star: "M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4",
  rupee: "M6 4h12M6 9h12M9 4c5 0 7 2 7 5s-2 5-7 5H6l8 6",
  headset: "M4 14v-2a8 8 0 0116 0v2M4 14h3v5H4zM17 14h3v5h-3z",
  truck: "M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19.5h.01M17 19.5h.01",
  heart: "M12 21s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 6-8 11-8 11z",
  briefcase: "M3 8h18v12H3zM8 8V5h8v3M3 13h18",
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

/* ---------- auto-running slider (hero banner + About media) ---------- */
interface SlideImage {
  src: string;
  alt: string;
}

const Slider: React.FC<{ images: SlideImage[]; arrows?: boolean; interval?: number }> = ({
  images,
  arrows = false,
  interval = 3500,
}) => {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = images.length;

  useEffect(() => {
    if (count < 2 || paused) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % count), interval);
    return () => window.clearInterval(timer);
  }, [count, paused, interval]);

  const go = (next: number) => setIndex((next + count) % count);

  if (count === 0) return null;

  return (
    <div
      className="pbw-slider"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={() => setPaused(true)}
      onTouchEnd={() => setPaused(false)}
    >
      {images.map((img, i) => (
        <div key={`${img.src}-${i}`} className={`pbw-slide${i === index ? " is-active" : ""}`} aria-hidden={i !== index}>
          <SafeImage src={img.src} alt={img.alt} size={64} />
        </div>
      ))}
      {arrows && count > 1 && (
        <>
          <button type="button" className="pbw-slider-btn prev" onClick={() => go(index - 1)} aria-label="Previous slide">
            <Icon d={ICONS.prev} size={20} />
          </button>
          <button type="button" className="pbw-slider-btn next" onClick={() => go(index + 1)} aria-label="Next slide">
            <Icon d={ICONS.next} size={20} />
          </button>
        </>
      )}
      {count > 1 && (
        <div className="pbw-dots">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`pbw-dot${i === index ? " is-active" : ""}`}
              onClick={() => go(i)}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* ---------- quantity stepper ---------- */
const QtyStepper: React.FC<{ value: number; onChange: (next: number) => void; min?: number }> = ({
  value,
  onChange,
  min = 1,
}) => (
  <div className="pbw-qty">
    <button type="button" aria-label="Decrease quantity" disabled={value <= min} onClick={() => onChange(value - 1)}>
      −
    </button>
    <span aria-live="polite">{value}</span>
    <button type="button" aria-label="Increase quantity" disabled={value >= MAX_QTY} onClick={() => onChange(value + 1)}>
      +
    </button>
  </div>
);

/* ---------- product modal ---------- */
const ProductModal: React.FC<{
  product: PublicProduct;
  onClose: () => void;
  onAdd: (quantity: number) => void;
}> = ({ product, onClose, onAdd }) => {
  const [qty, setQty] = useState(1);

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
  const description = product.description || product.metaDescription || "";
  const price = product.priceValue;

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
          {price ? <div className="pbw-modal-price">{formatMoney(price)}</div> : <span className="pbw-more">Price on request</span>}
          <div className="pbw-meta">
            {product.brand && <span className="pbw-chip">Brand: {product.brand}</span>}
            {product.color && <span className="pbw-chip">Color: {product.color}</span>}
            {product.subcategory && <span className="pbw-chip">{product.subcategory}</span>}
          </div>
          {description && <p>{description}</p>}
          {features.length > 0 && (
            <ul className="pbw-features-list">
              {features.slice(0, 8).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          {price && (
            <div className="pbw-modal-buy">
              <QtyStepper value={qty} onChange={setQty} />
              <button
                className="pbw-btn pbw-btn-primary"
                onClick={() => {
                  onAdd(qty);
                  onClose();
                }}
              >
                Add to cart · {formatMoney(price * qty)}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ---------- cart + checkout drawer ---------- */
interface CartLine {
  product: PublicProduct;
  qty: number;
  price: number;
}

interface CustomerForm {
  name: string;
  phone: string;
  email: string;
  address: string;
  note: string;
}

const EMPTY_FORM: CustomerForm = { name: "", phone: "", email: "", address: "", note: "" };

const CartDrawer: React.FC<{
  slug: string;
  businessName: string;
  lines: CartLine[];
  subtotal: number;
  onClose: () => void;
  onSetQty: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
  onPaid: () => void;
}> = ({ slug, businessName, lines, subtotal, onClose, onSetQty, onRemove, onPaid }) => {
  const [step, setStep] = useState<"cart" | "details" | "success">("cart");
  const [form, setForm] = useState<CustomerForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [orderNo, setOrderNo] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, busy]);

  const update = (key: keyof CustomerForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const apiUrl = (path: string) => `${BASE_PATH}/api/public/business-sites/${encodeURIComponent(slug)}/${path}`;

  const pay = async () => {
    setError("");
    if (form.name.trim().length < 2) return setError("Please enter your name.");
    if (!/^[0-9+\-\s]{8,16}$/.test(form.phone.trim())) return setError("Please enter a valid phone number.");
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      return setError("Please enter a valid email address.");
    }

    setBusy(true);
    try {
      if (!(await loadRazorpay())) throw new Error("Could not load the payment gateway. Check your connection and try again.");
      const Razorpay = getRazorpay();
      if (!Razorpay) throw new Error("Payment gateway is not available.");

      const res = await fetch(apiUrl("checkout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: lines.map((l) => ({ productId: Number(l.product.id), quantity: l.qty })),
          customer: {
            name: form.name.trim(),
            phone: form.phone.trim(),
            email: form.email.trim(),
            address: form.address.trim(),
            note: form.note.trim(),
          },
        }),
      });
      const order = await res.json().catch(() => null);
      if (!res.ok || !order?.razorpayOrderId) {
        throw new Error(order?.message || "Could not start the payment. Please try again.");
      }

      const checkout = new Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.razorpayOrderId,
        name: order.businessName || businessName,
        description: `Order #${order.orderId}`,
        prefill: { name: form.name.trim(), contact: form.phone.trim(), email: form.email.trim() },
        theme: { color: "#168b58" },
        handler: async (payment: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const verify = await fetch(apiUrl("verify"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orderId: order.orderId, ...payment }),
            });
            const result = await verify.json().catch(() => null);
            if (!verify.ok || !result?.success) {
              throw new Error(
                `${result?.message || "Verification failed."} Payment ID: ${payment.razorpay_payment_id}. Please contact ${businessName}.`,
              );
            }
            setOrderNo(order.orderId);
            setStep("success");
            onPaid();
          } catch (verifyError) {
            setError(verifyError instanceof Error ? verifyError.message : "Could not verify the payment.");
          } finally {
            setBusy(false);
          }
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      checkout.on("payment.failed", (response) => {
        setError(response.error?.description || "Payment failed. Please try again.");
        setBusy(false);
      });
      checkout.open();
    } catch (payError) {
      setError(payError instanceof Error ? payError.message : "Could not start the payment.");
      setBusy(false);
    }
  };

  return (
    <div className="pbw-drawer-overlay" onClick={() => !busy && onClose()} role="presentation">
      <aside
        className="pbw-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Shopping cart"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pbw-drawer-head">
          <h2>{step === "details" ? "Your details" : step === "success" ? "Order placed" : "Your cart"}</h2>
          <button className="pbw-icon-btn" onClick={onClose} disabled={busy} aria-label="Close cart">
            <Icon d={ICONS.close} size={18} />
          </button>
        </div>

        {step === "success" ? (
          <div className="pbw-drawer-body">
            <div className="pbw-success">
              <span className="pbw-success-icon">
                <Icon d={ICONS.check} size={34} />
              </span>
              <h3>Thank you for your order!</h3>
              <p>
                Your payment was successful{orderNo ? ` (order #${orderNo})` : ""}. {businessName} will contact you on{" "}
                <strong>{form.phone}</strong> shortly.
              </p>
              <button className="pbw-btn pbw-btn-primary" onClick={onClose}>
                Continue shopping
              </button>
            </div>
          </div>
        ) : lines.length === 0 ? (
          <div className="pbw-drawer-body">
            <div className="pbw-empty-cart">
              <Icon d={ICONS.cart} size={40} />
              <p style={{ marginTop: 12 }}>Your cart is empty.</p>
            </div>
          </div>
        ) : step === "cart" ? (
          <>
            <div className="pbw-drawer-body">
              {lines.map((l) => {
                const id = String(l.product.id);
                return (
                  <div className="pbw-line" key={id}>
                    <div className="pbw-line-img">
                      <SafeImage src={l.product.imageUrl} alt={l.product.title || "Product"} size={26} />
                    </div>
                    <div>
                      <div className="pbw-line-title">{l.product.title}</div>
                      <div className="pbw-line-meta">
                        <QtyStepper value={l.qty} onChange={(n) => onSetQty(id, n)} />
                        <span className="pbw-line-price">{formatMoney(l.price * l.qty)}</span>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <button className="pbw-link-btn" onClick={() => onRemove(id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="pbw-drawer-foot">
              <div className="pbw-total-row">
                <span>Subtotal</span>
                <strong>{formatMoney(subtotal)}</strong>
              </div>
              <button className="pbw-btn pbw-btn-primary pbw-btn-block" onClick={() => setStep("details")}>
                Proceed to checkout
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="pbw-drawer-body">
              <div className="pbw-form">
                <div className="pbw-summary">
                  {lines.length} item{lines.length > 1 ? "s" : ""} · Total <strong>{formatMoney(subtotal)}</strong>
                </div>
                <div className="pbw-field">
                  <label htmlFor="pbw-name">Full name *</label>
                  <input id="pbw-name" value={form.name} onChange={update("name")} autoComplete="name" maxLength={255} />
                </div>
                <div className="pbw-field">
                  <label htmlFor="pbw-phone">Phone number *</label>
                  <input
                    id="pbw-phone"
                    type="tel"
                    inputMode="tel"
                    value={form.phone}
                    onChange={update("phone")}
                    autoComplete="tel"
                    maxLength={16}
                  />
                </div>
                <div className="pbw-field">
                  <label htmlFor="pbw-email">Email (optional)</label>
                  <input id="pbw-email" type="email" value={form.email} onChange={update("email")} autoComplete="email" />
                </div>
                <div className="pbw-field">
                  <label htmlFor="pbw-address">Delivery address (optional)</label>
                  <textarea id="pbw-address" value={form.address} onChange={update("address")} maxLength={1000} />
                </div>
                <div className="pbw-field">
                  <label htmlFor="pbw-note">Note for the seller (optional)</label>
                  <textarea id="pbw-note" value={form.note} onChange={update("note")} maxLength={1000} />
                </div>
                {error && (
                  <div className="pbw-alert" role="alert">
                    {error}
                  </div>
                )}
              </div>
            </div>
            <div className="pbw-drawer-foot">
              <button className="pbw-btn pbw-btn-primary pbw-btn-block" onClick={pay} disabled={busy}>
                {busy ? "Please wait…" : `Pay ${formatMoney(subtotal)}`}
              </button>
              <button className="pbw-btn pbw-btn-ghost pbw-btn-block" onClick={() => setStep("cart")} disabled={busy}>
                Back to cart
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
};

/* ---------- About feature tiles ---------- */
const FEATURES: { icon: string; label: string }[] = [
  { icon: ICONS.star, label: "Quality products" },
  { icon: ICONS.shield, label: "Secure payments" },
  { icon: ICONS.rupee, label: "Affordable pricing" },
  { icon: ICONS.headset, label: "Dedicated support" },
  { icon: ICONS.truck, label: "Easy ordering" },
  { icon: ICONS.heart, label: "Customer first" },
];

/* ---------- main page ---------- */
const PublicBusinessWebsite: React.FC<{ site: PublicSite }> = ({ site }) => {
  const slug = site.slug || "";
  const cartKey = `pbw-cart-${slug}`;

  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [selected, setSelected] = useState<PublicProduct | null>(null);
  const [copied, setCopied] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartReady, setCartReady] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [toast, setToast] = useState("");

  const products = site.products;
  const services = site.services || [];
  const productById = useMemo(() => new Map(products.map((p) => [String(p.id), p])), [products]);
  const hasShop = useMemo(() => products.some((p) => p.priceValue), [products]);

  /* cart persistence (per website, per browser) */
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(cartKey) || "{}");
      if (saved && typeof saved === "object") setCart(saved);
    } catch {
      /* ignore */
    }
    setCartReady(true);
  }, [cartKey]);

  useEffect(() => {
    if (!cartReady) return;
    try {
      localStorage.setItem(cartKey, JSON.stringify(cart));
    } catch {
      /* ignore */
    }
  }, [cart, cartKey, cartReady]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1800);
  }, []);

  const addToCart = useCallback(
    (product: PublicProduct, qty = 1) => {
      const id = String(product.id);
      setCart((c) => ({ ...c, [id]: Math.min((c[id] || 0) + qty, MAX_QTY) }));
      showToast("Added to cart");
    },
    [showToast],
  );

  const setQty = useCallback((id: string, qty: number) => {
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[id];
      else next[id] = Math.min(qty, MAX_QTY);
      return next;
    });
  }, []);

  const removeLine = useCallback((id: string) => setQty(id, 0), [setQty]);

  const lines = useMemo<CartLine[]>(
    () =>
      Object.entries(cart).flatMap(([id, qty]) => {
        const product = productById.get(id);
        return product?.priceValue ? [{ product, qty, price: product.priceValue }] : [];
      }),
    [cart, productById],
  );
  const cartCount = lines.reduce((n, l) => n + l.qty, 0);
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);

  /* filters */
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

  /* hero banner: product images only. No images -> the visual is removed. */
  const heroSlides = useMemo<SlideImage[]>(
    () =>
      products
        .filter((p) => p.imageUrl)
        .slice(0, 8)
        .map((p) => ({ src: p.imageUrl as string, alt: p.title || "Product" })),
    [products],
  );

  /* About media: logo first, then product images (no duplicates). */
  const aboutSlides = useMemo<SlideImage[]>(() => {
    const seen = new Set<string>();
    const out: SlideImage[] = [];
    const push = (src: string | null, alt: string) => {
      if (src && !seen.has(src)) {
        seen.add(src);
        out.push({ src, alt });
      }
    };
    push(site.logo, `${name} logo`);
    products.slice(0, 6).forEach((p) => push(p.imageUrl, p.title || "Product"));
    return out;
  }, [site.logo, products, name]);

  const intro = [
    category ? `${name} is a trusted ${category.toLowerCase()} business` : `${name} is a local business`,
    site.city ? ` based in ${site.city}.` : ".",
    products.length
      ? " Browse our products and get in touch to learn more."
      : " Get in touch to learn more.",
  ].join("");

  /* About text: first paragraph is the highlighted lead, the rest is rich text. */
  const aboutText = (site.about || "").trim();
  const aboutParts = aboutText.split(/\r?\n\s*\r?\n/);
  const aboutLead = aboutText ? aboutParts[0].replace(/\s*\r?\n\s*/g, " ").trim() : intro;
  const aboutRest = aboutText ? aboutParts.slice(1).join("\n\n") : "";

  const missionText = `Our mission is to provide quality products and reliable services to every ${name} customer, and to build long-term relationships through trust and transparency.`;
  const visionText = `To be a dependable choice${site.city ? ` in ${site.city}` : ""} by delivering real value, affordable prices and dependable service.`;

  return (
    <div className="pbw">
      {/* Header */}
      <header className="pbw-header">
        <div className="pbw-container pbw-header-inner">
          <div className="pbw-brand">
            <span className={`pbw-logo${site.logo ? " has-img" : ""}`}>
              {site.logo ? (
                <SafeImage src={site.logo} alt={`${name} logo`} size={22} />
              ) : (
                <Icon d={ICONS.store} />
              )}
            </span>
            <span className="pbw-brand-name">{name}</span>
          </div>
          <div className="pbw-header-right">
            <nav className="pbw-nav" aria-label="Sections">
              <a href="#about">About</a>
              {services.length > 0 && <a href="#services">Services</a>}
              {products.length > 0 && <a href="#products">Products</a>}
              <a href="#contact" className="pbw-nav-cta">
                Contact
              </a>
            </nav>
            {hasShop && (
              <button className="pbw-cart-btn" onClick={() => setCartOpen(true)} aria-label={`Open cart, ${cartCount} items`}>
                <Icon d={ICONS.cart} size={18} />
                <span className="pbw-cart-label">Cart</span>
                {cartCount > 0 && <span className="pbw-badge">{cartCount}</span>}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="pbw-hero">
        <div className={`pbw-container pbw-hero-grid${heroSlides.length === 0 ? " is-single" : ""}`}>
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

          {heroSlides.length > 0 && (
            <div className="pbw-hero-visual is-slider">
              <Slider images={heroSlides} />
            </div>
          )}
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
        <div className="pbw-container">
          <div className={`pbw-about-split${aboutSlides.length === 0 ? " no-media" : ""}`}>
            {aboutSlides.length > 0 && <Slider images={aboutSlides} arrows interval={4000} />}
            <div>
              <span className="pbw-kicker">About us</span>
              <h2 className="pbw-about-title">Welcome to {name}</h2>
              <p className="pbw-about-lead">{aboutLead}</p>
              {aboutRest && <div className="pbw-about-rich">{renderRichText(aboutRest)}</div>}
              <div className="pbw-mv">
                <div>
                  <h3>Mission</h3>
                  <p>{missionText}</p>
                </div>
                <div>
                  <h3>Vision</h3>
                  <p>{visionText}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="pbw-features">
            {FEATURES.map((f) => (
              <div className="pbw-feature" key={f.label}>
                <span className="pbw-feature-icon">
                  <Icon d={f.icon} size={30} />
                </span>
                <span>{f.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Services (from the services table, by the owner's business category) */}
      {services.length > 0 && (
        <section className="pbw-section pbw-products" id="services">
          <div className="pbw-container">
            <div className="pbw-section-head">
              <span className="pbw-kicker">What we do</span>
              <h2>Our Services</h2>
              <p className="pbw-sub">Services offered by {name}.</p>
            </div>
            <div className="pbw-services-grid">
              {services.map((s) => (
                <article className="pbw-service" key={s.id}>
                  <span className="pbw-service-icon">
                    <Icon d={ICONS.briefcase} size={22} />
                  </span>
                  <h3>{s.name}</h3>
                  {s.description && <p>{s.description}</p>}
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Contact */}
      <section className="pbw-section" id="contact" style={{ paddingTop: 0 }}>
        <div className="pbw-container">
          <div className="pbw-info-card pbw-contact-card">
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
              <p className="pbw-sub">Tap any product to see full details{hasShop ? ", or add it straight to your cart" : ""}.</p>
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
                {filtered.map((p) => (
                  <article key={p.id} className="pbw-card">
                    <button className="pbw-card-main" onClick={() => setSelected(p)}>
                      <div className="pbw-card-img">
                        <SafeImage src={p.imageUrl} alt={p.title || "Product"} />
                      </div>
                      <div className="pbw-card-body">
                        {(p.brand || p.category) && <span className="pbw-tag">{p.brand || p.category}</span>}
                        <h3>{p.title}</h3>
                        {(p.description || p.metaDescription) && (
                          <p className="pbw-card-desc">{p.description || p.metaDescription}</p>
                        )}
                      </div>
                    </button>
                    <div className="pbw-card-actions">
                      {p.priceValue ? (
                        <>
                          <span className="pbw-price">{formatMoney(p.priceValue)}</span>
                          <button
                            className="pbw-btn pbw-btn-primary pbw-btn-sm"
                            onClick={() => addToCart(p)}
                            aria-label={`Add ${p.title || "product"} to cart`}
                          >
                            <span className="pbw-hide-sm">Add to cart</span>
                            <span className="pbw-show-sm">Add</span>
                          </button>
                        </>
                      ) : (
                        <button className="pbw-more" style={{ background: "none", border: 0, padding: 0 }} onClick={() => setSelected(p)}>
                          Price on request →
                        </button>
                      )}
                    </div>
                  </article>
                ))}
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

      {selected && (
        <ProductModal
          product={selected}
          onClose={() => setSelected(null)}
          onAdd={(qty) => addToCart(selected, qty)}
        />
      )}

      {cartOpen && (
        <CartDrawer
          slug={slug}
          businessName={name}
          lines={lines}
          subtotal={subtotal}
          onClose={() => setCartOpen(false)}
          onSetQty={setQty}
          onRemove={removeLine}
          onPaid={() => setCart({})}
        />
      )}

      {toast && (
        <div className="pbw-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
};

export default PublicBusinessWebsite;