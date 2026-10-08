import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { plans } from '@/db/schema';

export async function GET() {
  try {
    const activePlans = await db
      .select()
      .from(plans)
      .where(eq(plans.isActive, true))
      .orderBy(asc(plans.price));

    return NextResponse.json({
      success: true,
      plans: activePlans.map((plan) => ({
        ...plan,
        features: plan.features
          ? plan.features.split('\n').map((feature) => feature.trim()).filter(Boolean)
          : [],
      })),
    });
  } catch (error) {
    console.error('[Subscription Plans] Could not load plans:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load subscription plans.' },
      { status: 500 }
    );
  }
}
