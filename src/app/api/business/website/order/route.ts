import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { subscriptions, transactions } from "@/db/schema";
import { getUserIdFromRequest } from "@/lib/auth";
import { ensureBusinessWebsitePlan } from "@/lib/businessWebsite";
import { getRazorpayConfig } from "@/lib/razorpay";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const userId = Number(await getUserIdFromRequest(request));
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const planId = Number(await ensureBusinessWebsitePlan());
    const { razorpay, razorpayKeyId } = getRazorpayConfig();
    const order = await razorpay.orders.create({
      amount: 59_900,
      currency: "INR",
      receipt: `site_${userId}_${Date.now()}`,
      notes: { userId: String(userId), planId: String(planId), product: "business_website" },
    });

    const [subscriptionResult] = await db.insert(subscriptions).values({
      userId,
      planId,
      status: "pending",
    });
    const subscriptionId = Number(subscriptionResult.insertId);
    if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
      throw new Error("Could not create website subscription record");
    }

    await db.insert(transactions).values({
      userId,
      planId,
      subscriptionId,
      razorpayOrderId: order.id,
      amount: 59_900,
      currency: "INR",
      status: "created",
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: razorpayKeyId,
      planId,
      subscriptionId,
    });
  } catch (error) {
    console.error("[Business Website Order]", error);
    return NextResponse.json(
      { message: "Could not start the website subscription payment" },
      { status: 500 },
    );
  }
}
