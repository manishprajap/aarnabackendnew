// src/app/api/subscription/verify/route.ts

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db';
import { plans, subscriptions, transactions, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@/lib/cors';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { getRazorpayConfig } from '@/lib/razorpay';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

// Constant-time comparison; false if lengths differ.
function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  try {
    const userId = Number(await getUserIdFromRequest(req));
    const { razorpayKeySecret } = getRazorpayConfig();
    const body = await req.json();

    const razorpayOrderId = String(body?.razorpay_order_id || '').trim();
    const razorpayPaymentId = String(body?.razorpay_payment_id || '').trim();
    const razorpaySignature = String(body?.razorpay_signature || '').trim();

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return json(
        { error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required' },
        400
      );
    }

    // Uses the cleaned secret (no hidden "\r" from CRLF .env files).
    const expectedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    const isValid = safeEqual(expectedSignature, razorpaySignature);

    const [existingTransaction] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.razorpayOrderId, razorpayOrderId))
      .limit(1);

    if (!existingTransaction) {
      return json({ error: 'No matching transaction found' }, 404);
    }

    // Make sure the order being verified belongs to the authenticated user.
    if (Number(existingTransaction.userId) !== userId) {
      return json({ error: 'Order does not belong to this user' }, 403);
    }

    if (!isValid) {
      await db
        .update(transactions)
        .set({
          status: 'failed',
          razorpayPaymentId,
          errorDescription: 'Signature verification failed',
        })
        .where(eq(transactions.id, existingTransaction.id));

      if (existingTransaction.subscriptionId) {
        await db
          .update(subscriptions)
          .set({ status: 'failed' })
          .where(eq(subscriptions.id, existingTransaction.subscriptionId));
      }

      return json({ error: 'Payment verification failed' }, 400);
    }

    const [plan] = await db.select().from(plans).where(eq(plans.id, existingTransaction.planId)).limit(1);

    if (!plan) {
      return json({ error: 'Plan not found' }, 404);
    }

    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + plan.durationDays);

    await db
      .update(transactions)
      .set({
        status: 'paid',
        razorpayPaymentId,
        razorpaySignature,
      })
      .where(eq(transactions.id, existingTransaction.id));

    if (existingTransaction.subscriptionId) {
      await db
        .update(subscriptions)
        .set({
          status: 'active',
          startDate,
          endDate,
        })
        .where(eq(subscriptions.id, existingTransaction.subscriptionId));
    }

    await db
      .update(users)
      .set({
        plan: plan.name,
        credits: plan.posters,
      })
      .where(eq(users.id, userId));

    return json({
      success: true,
      plan: plan.name,
      credits: plan.posters,
      startDate,
      endDate,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return json({ error: e.message }, 401);
    }
    console.error('verify error:', e);
    return json({ error: 'Could not verify payment' }, 500);
  }
}