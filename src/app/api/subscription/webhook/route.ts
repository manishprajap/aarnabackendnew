// src/app/api/subscription/webhook/route.ts
//
// Configure this URL in your Razorpay dashboard (Settings > Webhooks) for
// the `payment.captured` and `payment.failed` events, with a webhook secret
// set in RAZORPAY_WEBHOOK_SECRET. This is a backup to /verify — it covers
// cases where the user closes the app/browser before the checkout success
// callback fires, so the transaction/subscription rows don't stay stuck as
// "created"/"pending" forever.
//
// No user JWT here — Razorpay itself calls this server-to-server and
// authenticates via the x-razorpay-signature header instead.

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db';
import { plans, subscriptions, transactions, users } from '@/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { corsHeaders } from '@/lib/cors';
import { ensureBusinessWebsiteSchema } from '@/lib/businessWebsite';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: NextRequest) {
  await ensureBusinessWebsiteSchema();
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature');

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.error('RAZORPAY_WEBHOOK_SECRET is missing from environment variables');
    return json({ error: 'Webhook not configured' }, 500);
  }

  if (!signature) {
    return json({ error: 'Missing signature' }, 400);
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expectedSignature !== signature) {
    return json({ error: 'Invalid signature' }, 400);
  }

  const event = JSON.parse(rawBody);
  const eventType = event?.event as string;
  const payment = event?.payload?.payment?.entity;

  if (!payment) {
    // Not a payment event we care about — acknowledge and ignore.
    return json({ received: true });
  }

  const razorpayOrderId = payment.order_id as string;
  const razorpayPaymentId = payment.id as string;

  const [existingTransaction] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.razorpayOrderId, razorpayOrderId))
    .limit(1);

  if (!existingTransaction) {
    console.warn('Webhook received for unknown order:', razorpayOrderId);
    return json({ received: true });
  }

  // Already handled by /verify — avoid double-crediting the user.
  if (existingTransaction.status === 'paid') {
    return json({ received: true });
  }

  if (eventType === 'payment.captured') {
    const [plan] = await db.select().from(plans).where(eq(plans.id, existingTransaction.planId)).limit(1);
    if (!plan) {
      return json({ received: true });
    }

    const now = new Date();
    const [activePeriod] = plan.planType === 'website'
      ? await db
          .select({ endDate: subscriptions.endDate })
          .from(subscriptions)
          .innerJoin(plans, eq(subscriptions.planId, plans.id))
          .where(and(
            eq(subscriptions.userId, existingTransaction.userId),
            eq(subscriptions.status, 'active'),
            eq(plans.planType, 'website'),
            gte(subscriptions.endDate, now),
          ))
          .orderBy(desc(subscriptions.endDate))
          .limit(1)
      : [];
    const startDate =
      plan.planType === 'website' && activePeriod?.endDate && activePeriod.endDate > now
        ? activePeriod.endDate
        : now;
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + plan.durationDays);

    await db
      .update(transactions)
      .set({
        status: 'paid',
        razorpayPaymentId,
        method: payment.method,
      })
      .where(eq(transactions.id, existingTransaction.id));

    if (existingTransaction.subscriptionId) {
      const activeIds = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(and(
          eq(subscriptions.userId, existingTransaction.userId),
          eq(subscriptions.status, 'active'),
          eq(plans.planType, plan.planType),
        ));
      if (activeIds.length) {
        await db
          .update(subscriptions)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(inArray(subscriptions.id, activeIds.map(({ id }) => id)));
      }
      await db
        .update(subscriptions)
        .set({ status: 'active', startDate, endDate })
        .where(eq(subscriptions.id, existingTransaction.subscriptionId));
    }

    if (plan.planType === 'ai') {
      await db
        .update(users)
        .set({ plan: plan.name, credits: plan.posters })
        .where(eq(users.id, existingTransaction.userId));
    }
  }

  if (eventType === 'payment.failed') {
    await db
      .update(transactions)
      .set({
        status: 'failed',
        razorpayPaymentId,
        errorCode: payment.error_code,
        errorDescription: payment.error_description,
      })
      .where(eq(transactions.id, existingTransaction.id));

    if (existingTransaction.subscriptionId) {
      await db
        .update(subscriptions)
        .set({ status: 'failed' })
        .where(eq(subscriptions.id, existingTransaction.subscriptionId));
    }
  }

  return json({ received: true });
}