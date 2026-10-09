import { NextRequest, NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db';
import {
  businessCategories,
  industries,
  promotionStrategies,
  services,
  targetCustomers,
} from '@/db/schema';
import { hasValidAdminSession, SESSION_COOKIE_NAME } from '@/lib/adminAuth';

const itemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('industry'),
    name: z.string().trim().min(2).max(150),
    description: z.string().trim().max(5000).optional(),
  }),
  z.object({
    type: z.literal('businessCategory'),
    name: z.string().trim().min(2).max(150),
    industryId: z.number().int().positive(),
    description: z.string().trim().max(5000).optional(),
  }),
  z.object({
    type: z.literal('service'),
    name: z.string().trim().min(2).max(190),
    businessCategoryId: z.number().int().positive(),
    description: z.string().trim().max(5000).optional(),
  }),
  z.object({
    type: z.literal('targetCustomer'),
    name: z.string().trim().min(2).max(190),
    businessCategoryId: z.number().int().positive(),
    description: z.string().trim().max(5000).optional(),
  }),
  z.object({
    type: z.literal('strategy'),
    name: z.string().trim().min(2).max(150),
    description: z.string().trim().min(2).max(5000),
    objective: z.string().trim().min(2).max(190),
    strategyOrder: z.number().int().nonnegative().optional(),
  }),
]);

function unauthorized() {
  return NextResponse.json(
    { success: false, message: 'Admin session expired. Please sign in again.' },
    { status: 401 },
  );
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

export async function GET(request: NextRequest) {
  if (!hasValidAdminSession(request.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return unauthorized();
  }

  try {
    const [industryRows, businessCategoryRows, serviceRows, targetRows, strategyRows] =
      await Promise.all([
        db.select({
          id: industries.id,
          name: industries.name,
          description: industries.description,
        }).from(industries).where(eq(industries.status, 'ACTIVE')).orderBy(asc(industries.name)),
        db.select({
          id: businessCategories.id,
          name: businessCategories.name,
          industryId: businessCategories.industryId,
          description: businessCategories.description,
        }).from(businessCategories)
          .where(eq(businessCategories.status, 'ACTIVE'))
          .orderBy(asc(businessCategories.name)),
        db.select({
          id: services.id,
          name: services.name,
          businessCategoryId: services.businessCategoryId,
          description: services.description,
        }).from(services).where(eq(services.status, 'ACTIVE')).orderBy(asc(services.name)),
        db.select({
          id: targetCustomers.id,
          name: targetCustomers.name,
          businessCategoryId: targetCustomers.businessCategoryId,
          description: targetCustomers.description,
        }).from(targetCustomers)
          .where(eq(targetCustomers.status, 'ACTIVE'))
          .orderBy(asc(targetCustomers.name)),
        db.select({
          id: promotionStrategies.id,
          name: promotionStrategies.name,
          description: promotionStrategies.description,
          objective: promotionStrategies.objective,
          strategyOrder: promotionStrategies.strategyOrder,
        }).from(promotionStrategies)
          .where(eq(promotionStrategies.status, 'ACTIVE'))
          .orderBy(asc(promotionStrategies.strategyOrder), asc(promotionStrategies.name)),
      ]);

    return NextResponse.json({
      success: true,
      catalog: {
        industries: industryRows,
        businessCategories: businessCategoryRows,
        services: serviceRows,
        targetCustomers: targetRows,
        strategies: strategyRows,
      },
    });
  } catch (error) {
    console.error('[Admin Business Setup Catalog] Could not load setup catalog:', error);
    return NextResponse.json(
      { success: false, message: 'Could not load business setup options.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!hasValidAdminSession(request.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return unauthorized();
  }

  try {
    const parsed = itemSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: parsed.error.issues[0]?.message || 'Invalid setup option.' },
        { status: 400 },
      );
    }

    const value = parsed.data;
    const slug = slugify(value.name);
    if (!slug) {
      return NextResponse.json(
        { success: false, message: 'Enter a name containing letters or numbers.' },
        { status: 400 },
      );
    }

    let id: number;
    switch (value.type) {
      case 'industry': {
        const [result] = await db.insert(industries).values({
          name: value.name,
          slug,
          description: value.description || null,
        });
        id = Number(result.insertId);
        break;
      }
      case 'businessCategory': {
        const [industry] = await db.select({ id: industries.id })
          .from(industries)
          .where(eq(industries.id, value.industryId))
          .limit(1);
        if (!industry) {
          return NextResponse.json(
            { success: false, message: 'Select a valid industry.' },
            { status: 400 },
          );
        }
        const [result] = await db.insert(businessCategories).values({
          name: value.name,
          slug,
          industryId: value.industryId,
          description: value.description || null,
        });
        id = Number(result.insertId);
        break;
      }
      case 'service': {
        const [businessCategory] = await db.select({ id: businessCategories.id })
          .from(businessCategories)
          .where(eq(businessCategories.id, value.businessCategoryId))
          .limit(1);
        if (!businessCategory) {
          return NextResponse.json(
            { success: false, message: 'Select a valid business category.' },
            { status: 400 },
          );
        }
        const [result] = await db.insert(services).values({
          name: value.name,
          slug,
          businessCategoryId: value.businessCategoryId,
          description: value.description || null,
        });
        id = Number(result.insertId);
        break;
      }
      case 'targetCustomer': {
        const [businessCategory] = await db.select({ id: businessCategories.id })
          .from(businessCategories)
          .where(eq(businessCategories.id, value.businessCategoryId))
          .limit(1);
        if (!businessCategory) {
          return NextResponse.json(
            { success: false, message: 'Select a valid business category.' },
            { status: 400 },
          );
        }
        const [result] = await db.insert(targetCustomers).values({
          name: value.name,
          slug,
          businessCategoryId: value.businessCategoryId,
          description: value.description || null,
        });
        id = Number(result.insertId);
        break;
      }
      case 'strategy': {
        const [result] = await db.insert(promotionStrategies).values({
          name: value.name,
          slug,
          description: value.description,
          objective: value.objective,
          strategyOrder: value.strategyOrder ?? 1,
        });
        id = Number(result.insertId);
        break;
      }
    }

    return NextResponse.json({ success: true, id }, { status: 201 });
  } catch (error) {
    const databaseError = error && typeof error === 'object'
      ? error as { cause?: { code?: string }; code?: string }
      : {};
    if (databaseError.cause?.code === 'ER_DUP_ENTRY' || databaseError.code === 'ER_DUP_ENTRY') {
      return NextResponse.json(
        { success: false, message: 'An option with this name already exists in that section.' },
        { status: 409 },
      );
    }
    console.error('[Admin Business Setup Catalog] Could not add setup option:', error);
    return NextResponse.json(
      { success: false, message: 'Could not add the business setup option.' },
      { status: 500 },
    );
  }
}
