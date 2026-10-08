import { and, count, desc, eq, gte, ne } from 'drizzle-orm';

import { db } from '@/db';
import { adCreatives, plans, products, subscriptions, users } from '@/db/schema';

export type SubscriptionAccess =
  | {
      allowed: true;
      planName: string;
      monthlyLimit: number;
      used: number;
      remaining: number;
      endsAt: Date;
    }
  | {
      allowed: false;
      reason: 'subscription_required' | 'limit_reached';
      message: string;
      monthlyLimit?: number;
      used?: number;
      endsAt?: Date;
    };

export async function getSubscriptionAccess(userId: number): Promise<SubscriptionAccess> {
  const now = new Date();
  const [current] = await db
    .select({
      planName: plans.name,
      monthlyLimit: plans.posters,
      durationDays: plans.durationDays,
      startsAt: subscriptions.startDate,
      endsAt: subscriptions.endDate,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, 'active'),
        gte(subscriptions.endDate, now)
      )
    )
    .orderBy(desc(subscriptions.endDate))
    .limit(1);

  if (!current?.startsAt || !current.endsAt) {
    return {
      allowed: false,
      reason: 'subscription_required',
      message: 'Your subscription has expired. Upgrade your plan to continue.',
    };
  }

  const cycleDays = Math.max(1, Math.min(31, current.durationDays || 30));
  const cycleMs = cycleDays * 24 * 60 * 60 * 1000;
  const elapsed = Math.max(0, now.getTime() - current.startsAt.getTime());
  const cycleStart = new Date(current.startsAt.getTime() + Math.floor(elapsed / cycleMs) * cycleMs);

  const [usage] = await db
    .select({ total: count() })
    .from(adCreatives)
    .innerJoin(products, eq(adCreatives.productId, products.id))
    .where(
      and(
        eq(products.userId, userId),
        gte(adCreatives.createdAt, cycleStart),
        ne(adCreatives.status, 'failed')
      )
    );

  const used = Number(usage?.total || 0);
  const monthlyLimit = current.monthlyLimit;
  if (used >= monthlyLimit) {
    return {
      allowed: false,
      reason: 'limit_reached',
      message: `You've used all ${monthlyLimit} banner generations in this plan period. Upgrade your plan or purchase additional credits.`,
      monthlyLimit,
      used,
      endsAt: current.endsAt,
    };
  }

  return {
    allowed: true,
    planName: current.planName,
    monthlyLimit,
    used,
    remaining: monthlyLimit - used,
    endsAt: current.endsAt,
  };
}

export async function reserveBannerGeneration(
  userId: number,
  values: Omit<typeof adCreatives.$inferInsert, 'productId'> & { productId: number }
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');

    const now = new Date();
    const [current] = await tx
      .select({
        monthlyLimit: plans.posters,
        durationDays: plans.durationDays,
        startsAt: subscriptions.startDate,
        endsAt: subscriptions.endDate,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, 'active'),
          gte(subscriptions.endDate, now)
        )
      )
      .orderBy(desc(subscriptions.endDate))
      .limit(1);

    if (!current?.startsAt || !current.endsAt) {
      return {
        allowed: false as const,
        access: {
          allowed: false as const,
          reason: 'subscription_required' as const,
          message: 'Your subscription has expired. Upgrade your plan to continue.',
        },
      };
    }

    const cycleDays = Math.max(1, Math.min(30, current.durationDays || 30));
    const cycleMs = cycleDays * 24 * 60 * 60 * 1000;
    const elapsed = Math.max(0, now.getTime() - current.startsAt.getTime());
    const cycleStart = new Date(current.startsAt.getTime() + Math.floor(elapsed / cycleMs) * cycleMs);
    const [usage] = await tx
      .select({ total: count() })
      .from(adCreatives)
      .innerJoin(products, eq(adCreatives.productId, products.id))
      .where(
        and(
          eq(products.userId, userId),
          gte(adCreatives.createdAt, cycleStart),
          ne(adCreatives.status, 'failed')
        )
      );
    const used = Number(usage?.total || 0);

    if (used >= current.monthlyLimit) {
      return {
        allowed: false as const,
        access: {
          allowed: false as const,
          reason: 'limit_reached' as const,
          message: `You've used all ${current.monthlyLimit} banner generations in this plan period. Upgrade to a higher plan to continue.`,
          monthlyLimit: current.monthlyLimit,
          used,
          endsAt: current.endsAt,
        },
      };
    }

    const [insertResult] = await tx.insert(adCreatives).values(values);
    return { allowed: true as const, creativeId: Number(insertResult.insertId) };
  });
}

export function subscriptionDeniedResponse(access: Exclude<SubscriptionAccess, { allowed: true }>) {
  return Response.json(
    {
      success: false,
      code: access.reason === 'limit_reached' ? 'BANNER_LIMIT_REACHED' : 'SUBSCRIPTION_REQUIRED',
      message: access.message,
      used: access.used,
      limit: access.monthlyLimit,
      endsAt: access.endsAt,
      upgradeUrl: '/subscription',
    },
    { status: access.reason === 'limit_reached' ? 429 : 403 }
  );
}
