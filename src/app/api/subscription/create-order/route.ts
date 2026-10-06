// src/app/api/subscription/create-order/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { plans, subscriptions, transactions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@/lib/cors';
import { razorpay, razorpayKeyId } from '@/lib/razorpay';
import { getUserIdFromRequest, AuthError } from '@/lib/auth';

// Wraps NextResponse.json so every response — not just OPTIONS — carries
// the CORS headers.
function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: NextRequest) {
  try {
    // await is harmless if the function is sync, and required if it is async.
    const userId = Number(await getUserIdFromRequest(req));

    const body = await req.json();
    const planId = Number(body?.planId);

    if (!planId || Number.isNaN(planId)) {
      return json({ error: 'planId is required' }, 400);
    }

    const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);

    if (!plan) {
      return json({ error: 'Plan not found' }, 404);
    }

    // Razorpay amounts are in the smallest currency unit (paise for INR).
    const amountInPaise = plan.price * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `sub_${userId}_${Date.now()}`,
      notes: {
        userId: String(userId),
        planId: String(planId),
      },
    });

    // Create the pending subscription period this order is for.
    const [subscriptionResult] = await db.insert(subscriptions).values({
      userId,
      planId,
      status: 'pending',
    });

    const subscriptionId = subscriptionResult.insertId;

    // Log the payment attempt.
    await db.insert(transactions).values({
      userId,
      planId,
      subscriptionId,
      razorpayOrderId: order.id,
      amount: amountInPaise,
      currency: 'INR',
      status: 'created',
    });

    return json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: razorpayKeyId, // trimmed: never send the raw env value to the browser
      planId,
      subscriptionId,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return json({ error: e.message }, 401);
    }
    console.error('create-order error:', e);
    return json({ error: 'Could not create order' }, 500);
  }
}