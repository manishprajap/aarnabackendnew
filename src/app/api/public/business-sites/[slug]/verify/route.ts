import { NextRequest, NextResponse } from "next/server";
import { getPublishedOwner } from "@/lib/publicBusinessSite";
import { getOrder, markOrderPaid, verifyRazorpaySignature } from "@/lib/storeOrders";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const owner = await getPublishedOwner(slug);
    if (!owner) {
      return NextResponse.json({ success: false, message: "Business website not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const orderId = Number(body?.orderId);
    const razorpayOrderId = String(body?.razorpay_order_id ?? "");
    const paymentId = String(body?.razorpay_payment_id ?? "");
    const signature = String(body?.razorpay_signature ?? "");

    if (!Number.isInteger(orderId) || orderId <= 0 || !razorpayOrderId || !paymentId || !signature) {
      return NextResponse.json({ success: false, message: "Invalid payment details." }, { status: 400 });
    }

    const order = await getOrder(orderId);
    if (!order || order.sellerUserId !== owner.id || order.razorpayOrderId !== razorpayOrderId) {
      return NextResponse.json({ success: false, message: "Order not found." }, { status: 404 });
    }

    if (!verifyRazorpaySignature(razorpayOrderId, paymentId, signature)) {
      return NextResponse.json({ success: false, message: "Payment verification failed." }, { status: 400 });
    }

    await markOrderPaid(orderId, paymentId);
    return NextResponse.json({ success: true, orderId });
  } catch (error) {
    console.error("[Public Business Website verify]", error);
    return NextResponse.json(
      { success: false, message: "Could not verify the payment." },
      { status: 500 },
    );
  }
}