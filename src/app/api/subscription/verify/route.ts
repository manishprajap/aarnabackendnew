import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { plans, subscriptions, transactions, users } from "@/db/schema";
import { getUserIdFromRequest } from "@/lib/auth";
import { ensureBusinessWebsiteSchema } from "@/lib/businessWebsite";

export const dynamic = "force-dynamic";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ success: false, error: message, message }, { status });
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeReturnTo(value: unknown): string {
  const path = typeof value === "string" ? value : "";
  // Only allow a local app path; block absolute and protocol-relative URLs.
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\\\")) {
    return "/dashboard";
  }
  return path;
}

/**
 * POST /api/subscription/verify
 * Expected body supports both Razorpay's snake_case keys and camelCase keys:
 * { razorpay_order_id, razorpay_payment_id, razorpay_signature, returnTo? }
 *
 * This endpoint verifies the checkout signature and then checks the payment
 * directly with Razorpay before activating the plan. It is idempotent for a
 * transaction already marked paid.
 */
export async function POST(request: NextRequest) {
  try {
    await ensureBusinessWebsiteSchema();
    const userId = await getUserIdFromRequest(request);
    if (!userId) return jsonError("Unauthorized", 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return jsonError("Invalid JSON body");

    const orderId = String(body.razorpay_order_id ?? body.orderId ?? "").trim();
    const paymentId = String(body.razorpay_payment_id ?? body.paymentId ?? "").trim();
    const signature = String(body.razorpay_signature ?? body.signature ?? "").trim();
    const returnTo = safeReturnTo(body.returnTo);

    if (!orderId || !paymentId || !signature) {
      return jsonError("razorpay_order_id, razorpay_payment_id and razorpay_signature are required");
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      console.error("[Subscription verify] Razorpay credentials are missing");
      return jsonError("Payment verification is not configured", 500);
    }

    const [transaction] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.razorpayOrderId, orderId))
      .limit(1);

    if (!transaction) return jsonError("Payment order was not found", 404);
    if (Number(transaction.userId) !== Number(userId)) {
      return jsonError("This payment order does not belong to your account", 403);
    }

    if (transaction.status === "paid") {
      return NextResponse.json({
        success: true,
        message: "Subscription was already activated",
        plan: "pro",
        returnTo,
      });
    }

    const expectedSignature = createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (!safeEqualHex(signature, expectedSignature)) {
      return jsonError("Payment signature verification failed", 400);
    }

    // Confirm the payment with Razorpay as well as checking the signature.
    const paymentResponse = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
        cache: "no-store",
      },
    );

    const payment = await paymentResponse.json().catch(() => null);
    if (!paymentResponse.ok || !payment) {
      console.error("[Subscription verify] Razorpay payment lookup failed", payment);
      return jsonError("Could not confirm payment status with Razorpay", 502);
    }
    if (String(payment.order_id ?? "") !== orderId) {
      return jsonError("Payment does not match the selected order", 400);
    }
    if (String(payment.status ?? "").toLowerCase() !== "captured") {
      return jsonError("Payment is not captured yet. Please wait and refresh payment status.", 409);
    }
    if (Number(payment.amount) !== Number(transaction.amount)) {
      return jsonError("Payment amount does not match the order", 400);
    }
    if (
      transaction.currency &&
      String(payment.currency ?? "").toUpperCase() !== String(transaction.currency).toUpperCase()
    ) {
      return jsonError("Payment currency does not match the order", 400);
    }

    const [plan] = await db
      .select()
      .from(plans)
      .where(eq(plans.id, transaction.planId))
      .limit(1);

    if (!plan) return jsonError("The purchased plan was not found", 404);

    const now = new Date();
    const [activePeriod] = plan.planType === "website"
      ? await db
          .select({ endDate: subscriptions.endDate })
          .from(subscriptions)
          .innerJoin(plans, eq(subscriptions.planId, plans.id))
          .where(and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.status, "active"),
            eq(plans.planType, "website"),
            gte(subscriptions.endDate, now),
          ))
          .orderBy(desc(subscriptions.endDate))
          .limit(1)
      : [];
    const startDate =
      plan.planType === "website" && activePeriod?.endDate && activePeriod.endDate > now
        ? activePeriod.endDate
        : now;
    const durationDays = Math.max(1, Number(plan.durationDays) || 30);
    const endDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const normalizedPlan = String(plan.name ?? "pro").trim().toLowerCase();

    await db.transaction(async (tx) => {
      // Re-read the transaction inside the transaction so repeat requests don't
      // create multiple subscription periods for the same order.
      const [current] = await tx
        .select()
        .from(transactions)
        .where(and(
          eq(transactions.id, transaction.id),
          eq(transactions.userId, userId),
        ))
        .limit(1);

      if (!current) throw new Error("Payment transaction disappeared");
      if (current.status === "paid") return;
      if (current.status !== "created") {
        throw new Error(`Cannot activate a transaction with status ${current.status}`);
      }

      const activeIds = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, "active"),
          eq(plans.planType, plan.planType),
        ));
      if (activeIds.length) {
        await tx
          .update(subscriptions)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(inArray(subscriptions.id, activeIds.map(({ id }) => id)));
      }

      const inserted = await tx.insert(subscriptions).values({
        userId: Number(userId),
        planId: plan.id,
        status: "active",
        startDate,
        endDate,
      });
      const subscriptionId = Number(inserted[0].insertId);
      if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
        throw new Error("Could not create subscription record");
      }

      await tx
        .update(transactions)
        .set({
          status: "paid",
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
          subscriptionId,
          method: payment.method ? String(payment.method).slice(0, 50) : null,
          errorCode: null,
          errorDescription: null,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, transaction.id));

      if (plan.planType === "ai") {
        await tx
          .update(users)
          .set({ plan: normalizedPlan, updatedAt: new Date() })
          .where(eq(users.id, Number(userId)));
      }
    });

    return NextResponse.json({
      success: true,
      message: "Payment verified and subscription activated",
      plan: normalizedPlan,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      returnTo,
    });
  } catch (error) {
    console.error("[Subscription verify POST]", error);
    return jsonError("Failed to verify subscription payment", 500);
  }
}
