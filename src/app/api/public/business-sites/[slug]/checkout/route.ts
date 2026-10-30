import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { getPublishedOwner, parsePriceValue } from "@/lib/publicBusinessSite";
import {
  attachRazorpayOrder,
  createOrder,
  createRazorpayOrder,
  type NewOrderItem,
} from "@/lib/storeOrders";

export const dynamic = "force-dynamic";

const MAX_QTY = 20;
const MAX_LINES = 50;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const owner = await getPublishedOwner(slug);
    if (!owner) {
      return NextResponse.json({ message: "Business website not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const rawItems: unknown[] = Array.isArray(body?.items) ? body.items : [];
    const customer = body?.customer ?? {};

    const name = String(customer.name ?? "").trim();
    const phone = String(customer.phone ?? "").trim();
    const email = String(customer.email ?? "").trim();
    const address = String(customer.address ?? "").trim();
    const note = String(customer.note ?? "").trim();

    if (name.length < 2 || name.length > 255) {
      return NextResponse.json({ message: "Please enter your name." }, { status: 400 });
    }
    if (!/^[0-9+\-\s]{8,16}$/.test(phone)) {
      return NextResponse.json({ message: "Please enter a valid phone number." }, { status: 400 });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ message: "Please enter a valid email address." }, { status: 400 });
    }

    // Merge duplicate lines and validate quantities.
    const wanted = new Map<number, number>();
    for (const entry of rawItems.slice(0, MAX_LINES)) {
      const productId = Number((entry as { productId?: unknown })?.productId);
      const quantity = Math.floor(Number((entry as { quantity?: unknown })?.quantity));
      if (!Number.isInteger(productId) || productId <= 0) continue;
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      wanted.set(productId, Math.min((wanted.get(productId) || 0) + quantity, MAX_QTY));
    }
    if (wanted.size === 0) {
      return NextResponse.json({ message: "Your cart is empty." }, { status: 400 });
    }

    // Prices always come from the database, never from the browser.
    const rows = await db
      .select({ id: products.id, title: products.title, price: products.price })
      .from(products)
      .where(
        and(
          eq(products.userId, owner.id),
          eq(products.source, "user"),
          inArray(products.id, Array.from(wanted.keys())),
        ),
      );

    const items: NewOrderItem[] = [];
    let amountPaise = 0;
    for (const row of rows) {
      const price = parsePriceValue(row.price);
      const quantity = wanted.get(Number(row.id)) || 0;
      if (!price || !quantity) continue;
      const unitPricePaise = Math.round(price * 100);
      amountPaise += unitPricePaise * quantity;
      items.push({ productId: Number(row.id), title: row.title, unitPricePaise, quantity });
    }

    if (items.length === 0 || items.length !== wanted.size) {
      return NextResponse.json(
        { message: "Some products in your cart are no longer available. Please refresh the page." },
        { status: 400 },
      );
    }
    if (amountPaise < 100) {
      return NextResponse.json({ message: "Order amount is too low." }, { status: 400 });
    }

    const orderId = await createOrder({
      sellerUserId: owner.id,
      customer: { name, phone, email, address, note },
      items,
      amountPaise,
    });

    const razorpayOrder = await createRazorpayOrder({
      amountPaise,
      receipt: `store_${orderId}`,
      notes: { orderId: String(orderId), seller: String(owner.id), slug: owner.slug || "" },
    });
    await attachRazorpayOrder(orderId, razorpayOrder.id);

    return NextResponse.json({
      orderId,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      keyId: razorpayOrder.keyId,
      businessName: owner.name,
    });
  } catch (error) {
    console.error("[Public Business Website checkout]", error);
    return NextResponse.json(
      { message: "Could not start the payment. Please try again." },
      { status: 500 },
    );
  }
}