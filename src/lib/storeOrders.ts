import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/* ---------- schema (created automatically on first use) ---------- */
let schemaReady: Promise<void> | null = null;

export function ensureStoreOrderSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS store_orders (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          seller_user_id INT NOT NULL,
          customer_name VARCHAR(255) NOT NULL,
          customer_phone VARCHAR(20) NOT NULL,
          customer_email VARCHAR(255) NULL,
          customer_address TEXT NULL,
          customer_note TEXT NULL,
          amount_paise BIGINT NOT NULL,
          currency VARCHAR(8) NOT NULL DEFAULT 'INR',
          status VARCHAR(20) NOT NULL DEFAULT 'created',
          razorpay_order_id VARCHAR(64) NULL,
          razorpay_payment_id VARCHAR(64) NULL,
          paid_at DATETIME NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_store_orders_seller (seller_user_id),
          INDEX idx_store_orders_rzp (razorpay_order_id)
        )
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS store_order_items (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          order_id BIGINT UNSIGNED NOT NULL,
          product_id INT NOT NULL,
          title VARCHAR(255) NULL,
          unit_price_paise BIGINT NOT NULL,
          quantity INT NOT NULL,
          INDEX idx_store_order_items_order (order_id)
        )
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/* ---------- helpers ---------- */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return (Array.isArray(result[0]) ? result[0] : result) as Record<string, unknown>[];
  }
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function insertIdOf(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { insertId?: number | string })?.insertId ?? 0);
}

/* ---------- orders ---------- */
export interface NewOrderItem {
  productId: number;
  title: string | null;
  unitPricePaise: number;
  quantity: number;
}

export interface NewOrder {
  sellerUserId: number;
  customer: { name: string; phone: string; email: string; address: string; note: string };
  items: NewOrderItem[];
  amountPaise: number;
}

export async function createOrder(order: NewOrder): Promise<number> {
  await ensureStoreOrderSchema();
  const result = await db.execute(sql`
    INSERT INTO store_orders
      (seller_user_id, customer_name, customer_phone, customer_email, customer_address, customer_note, amount_paise)
    VALUES
      (${order.sellerUserId}, ${order.customer.name}, ${order.customer.phone},
       ${order.customer.email || null}, ${order.customer.address || null}, ${order.customer.note || null},
       ${order.amountPaise})
  `);
  const orderId = insertIdOf(result);
  if (!orderId) throw new Error("Could not create the order");

  for (const item of order.items) {
    await db.execute(sql`
      INSERT INTO store_order_items (order_id, product_id, title, unit_price_paise, quantity)
      VALUES (${orderId}, ${item.productId}, ${item.title}, ${item.unitPricePaise}, ${item.quantity})
    `);
  }
  return orderId;
}

export async function attachRazorpayOrder(orderId: number, razorpayOrderId: string): Promise<void> {
  await db.execute(sql`UPDATE store_orders SET razorpay_order_id = ${razorpayOrderId} WHERE id = ${orderId}`);
}

export interface StoredOrder {
  id: number;
  sellerUserId: number;
  amountPaise: number;
  status: string;
  razorpayOrderId: string | null;
}

export async function getOrder(orderId: number): Promise<StoredOrder | null> {
  await ensureStoreOrderSchema();
  const result = await db.execute(
    sql`SELECT id, seller_user_id, amount_paise, status, razorpay_order_id FROM store_orders WHERE id = ${orderId} LIMIT 1`,
  );
  const row = rowsOf(result)[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    sellerUserId: Number(row.seller_user_id),
    amountPaise: Number(row.amount_paise),
    status: String(row.status),
    razorpayOrderId: row.razorpay_order_id ? String(row.razorpay_order_id) : null,
  };
}

export async function markOrderPaid(orderId: number, paymentId: string): Promise<void> {
  await db.execute(sql`
    UPDATE store_orders
    SET status = 'paid', razorpay_payment_id = ${paymentId}, paid_at = NOW()
    WHERE id = ${orderId} AND status <> 'paid'
  `);
}

/* ---------- Razorpay (plain REST, no extra npm package) ---------- */
function razorpayKeys(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("Razorpay keys are not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
  return { keyId, keySecret };
}

export async function createRazorpayOrder(params: {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<{ id: string; amount: number; currency: string; keyId: string }> {
  const { keyId, keySecret } = razorpayKeys();
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify({
      amount: params.amountPaise,
      currency: "INR",
      receipt: params.receipt,
      notes: params.notes ?? {},
    }),
  });
  const data = (await res.json().catch(() => null)) as
    | { id?: string; amount?: number; currency?: string; error?: { description?: string } }
    | null;
  if (!res.ok || !data?.id) {
    throw new Error(data?.error?.description || "Razorpay could not create the order");
  }
  return { id: data.id, amount: Number(data.amount), currency: String(data.currency), keyId };
}

export function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string): boolean {
  const { keySecret } = razorpayKeys();
  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}