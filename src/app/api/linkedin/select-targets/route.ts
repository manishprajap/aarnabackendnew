// src/app/api/linkedin/select-targets/route.ts
//
// Saves which target(s) future LinkedIn posts should go to.
// Body: { "targets": ["personal", "urn:li:organization:99999991"] }
//
// Replaces the older /api/linkedin/select-organization (single-select)
// endpoint. Keep that route too if other code still calls it, or delete it
// once the frontend is switched over to this one.

import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';

function parseMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);

    const body = await request.json().catch(() => ({}));
    const targets: unknown = body?.targets;

    if (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string')) {
      return NextResponse.json(
        { success: false, message: '"targets" must be an array of strings.' },
        { status: 400 }
      );
    }

    const [connection] = await db
      .select()
      .from(socialAccounts)
      .where(
        and(
          eq(socialAccounts.userId, userId),
          eq(socialAccounts.provider, 'linkedin')
        )
      )
      .limit(1);

    if (!connection) {
      return NextResponse.json(
        { success: false, message: 'LinkedIn is not connected.' },
        { status: 400 }
      );
    }

    const metadata = parseMetadata(connection.metadata);
    const organizations: { urn: string }[] = Array.isArray(metadata.organizations)
      ? metadata.organizations
      : [];
    const validOrgUrns = new Set(organizations.map((o) => o.urn));

    // Only allow 'personal' or an org URN this account actually has.
    const cleanTargets = (targets as string[]).filter(
      (t) => t === 'personal' || validOrgUrns.has(t)
    );

    const updatedMetadata = {
      ...metadata,
      selectedTargets: cleanTargets,
      // keep old field in sync for any code still reading it
      selectedOrgUrn: cleanTargets.find((t) => t !== 'personal') || null,
    };

    await db
      .update(socialAccounts)
      .set({ metadata: updatedMetadata })
      .where(eq(socialAccounts.id, connection.id));

    return NextResponse.json({ success: true, targets: cleanTargets });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 401 }
      );
    }

    console.error('[LinkedIn Select Targets] Error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to save target selection.' },
      { status: 500 }
    );
  }
}