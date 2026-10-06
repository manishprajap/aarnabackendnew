/**
 * src/app/api/catalog/route.ts
 * GET /api/catalog -> active industries, categories, services, target customers and strategies
 * (the data your PHP form used to load from MySQL).
 */
import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db'; // <-- your drizzle instance
import {
  industries, businessCategories, services, targetCustomers, promotionStrategies,
} from '@/db/schema';

const cors = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function GET() {
  try {
    const [inds, cats, svcs, tgts, strats] = await Promise.all([
      db.select({ id: industries.id, name: industries.name })
        .from(industries).where(eq(industries.status, 'ACTIVE')).orderBy(asc(industries.name)),
      db.select({ id: businessCategories.id, name: businessCategories.name, industryId: businessCategories.industryId })
        .from(businessCategories).where(eq(businessCategories.status, 'ACTIVE')).orderBy(asc(businessCategories.name)),
      db.select({ id: services.id, name: services.name, businessCategoryId: services.businessCategoryId })
        .from(services).where(eq(services.status, 'ACTIVE')).orderBy(asc(services.name)),
      db.select({ id: targetCustomers.id, name: targetCustomers.name, businessCategoryId: targetCustomers.businessCategoryId })
        .from(targetCustomers).where(eq(targetCustomers.status, 'ACTIVE')).orderBy(asc(targetCustomers.name)),
      db.select({ id: promotionStrategies.id, name: promotionStrategies.name, objective: promotionStrategies.objective })
        .from(promotionStrategies).where(eq(promotionStrategies.status, 'ACTIVE'))
        .orderBy(asc(promotionStrategies.strategyOrder), asc(promotionStrategies.name)),
    ]);

    return NextResponse.json(
      { industries: inds, categories: cats, services: svcs, targets: tgts, strategies: strats },
      { headers: cors }
    );
  } catch (err) {
    console.error('GET /api/catalog failed:', err);
    return NextResponse.json({ error: 'Could not load catalog.' }, { status: 500, headers: cors });
  }
}