// src/app/api/linkedin/post/route.ts
//
// Publishes a post to LinkedIn — to the personal profile, one company page,
// or both, based on `targets` in the request body.
//
// Request body:
// {
//   "text": "post content",
//   "targets": ["personal", "urn:li:organization:99999991"],
//   "imageAssetUrn": "urn:li:image:xxxx"   // optional, if you already
//                                          // registered/uploaded an image
// }
//
// If `targets` is omitted, falls back to whatever the user last selected
// and saved via /api/linkedin/select-targets (metadata.selectedTargets).

import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { postToLinkedIn } from '@/lib/linkedin-targets';

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
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const imageAssetUrn =
      typeof body?.imageAssetUrn === 'string' ? body.imageAssetUrn : undefined;
    const requestedTargets: string[] | undefined = Array.isArray(body?.targets)
      ? body.targets.filter((t: unknown) => typeof t === 'string')
      : undefined;

    if (!text) {
      return NextResponse.json(
        { success: false, message: 'Post text is required.' },
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

    const accessToken = connection.accessToken;
    if (!accessToken) {
      return NextResponse.json(
        { success: false, message: 'LinkedIn access token missing. Please reconnect.' },
        { status: 400 }
      );
    }

    const metadata = parseMetadata(connection.metadata);
    const personalUrn: string | undefined =
      metadata.ownerUrn || metadata.personal?.urn;

    const organizations: { id: string; urn: string; name: string }[] = Array.isArray(
      metadata.organizations
    )
      ? metadata.organizations
      : [];

    // Targets: either explicitly passed in this request, or fall back to
    // the user's saved selection, or finally just personal.
    const targetKeys: string[] =
      requestedTargets && requestedTargets.length > 0
        ? requestedTargets
        : Array.isArray(metadata.selectedTargets) && metadata.selectedTargets.length > 0
        ? metadata.selectedTargets
        : ['personal'];

    // Resolve 'personal' + org ids/urns into real author URNs, and validate
    // that each org is actually one this user is connected to (avoid
    // posting to an arbitrary URN passed in the request body).
    const resolvedTargets: string[] = [];
    const unknownTargets: string[] = [];

    for (const key of targetKeys) {
      if (key === 'personal') {
        if (personalUrn) resolvedTargets.push(personalUrn);
        continue;
      }

      const org = organizations.find((o) => o.urn === key || o.id === key);
      if (org) {
        resolvedTargets.push(org.urn);
      } else {
        unknownTargets.push(key);
      }
    }

    if (resolvedTargets.length === 0) {
      return NextResponse.json(
        {
          success: false,
          message:
            unknownTargets.length > 0
              ? `Unknown or unauthorized target(s): ${unknownTargets.join(', ')}`
              : 'No valid post target selected.',
        },
        { status: 400 }
      );
    }

    // Post to every resolved target. LinkedIn requires one call per author.
    const results = await Promise.all(
      resolvedTargets.map((authorUrn) =>
        postToLinkedIn({ accessToken, authorUrn, text, imageAssetUrn })
      )
    );

    const anyAuthExpired = results.some((r) => r.authExpired);
    const allFailed = results.every((r) => !r.ok);
    const someFailed = results.some((r) => !r.ok);

    return NextResponse.json(
      {
        success: !allFailed,
        authExpired: anyAuthExpired,
        partialFailure: someFailed && !allFailed,
        results: results.map((r) => ({
          target: r.target,
          ok: r.ok,
          postId: r.postId,
          error: r.error,
        })),
        unknownTargets: unknownTargets.length > 0 ? unknownTargets : undefined,
      },
      { status: allFailed ? 502 : 200 }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 401 }
      );
    }

    console.error('[LinkedIn Post] Error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to post to LinkedIn.' },
      { status: 500 }
    );
  }
}