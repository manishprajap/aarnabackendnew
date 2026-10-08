// src/app/api/facebook/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { facebookConnections, facebookOAuthStates } from '@/db/schema';
import { encryptFacebookToken } from '@/lib/facebook-token';
import { graphUrl } from '@/lib/facebook';

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is missing`);
  }

  return value;
}

function redirectToApp(status: string): NextResponse {
  const appUrl = getRequiredEnv('AARNA_APP_URL');
  const url = new URL('/posters', appUrl);
  url.searchParams.set('facebook', status);
  return NextResponse.redirect(url);
}

type RawPage = {
  id: string;
  name?: string;
  access_token?: string;
  picture?: {
    data?: {
      url?: string;
    };
  };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hashState(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Works across common Drizzle adapters
 * (mysql2, node-postgres, postgres-js, better-sqlite3).
 * Returns null when the adapter does not expose a count.
 */
function getAffectedRows(result: unknown): number | null {
  if (Array.isArray(result) && isObject(result[0])) {
    const first = result[0];
    if (typeof first.affectedRows === 'number') return first.affectedRows;
  }

  if (isObject(result)) {
    if (typeof result.rowCount === 'number') return result.rowCount;
    if (typeof result.count === 'number') return result.count;
    if (typeof result.changes === 'number') return result.changes;
    if (typeof result.affectedRows === 'number') return result.affectedRows;
  }

  return null;
}

const MAX_PAGE_REQUESTS = 10;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    /**
     * User cancelled / denied Facebook OAuth.
     */
    if (error) {
      console.error('Facebook OAuth error:', {
        error,
        description: searchParams.get('error_description'),
        reason: searchParams.get('error_reason'),
      });

      if (state) {
        try {
          await db
            .delete(facebookOAuthStates)
            .where(eq(facebookOAuthStates.stateHash, hashState(state)));
        } catch (cleanupError) {
          console.error('Failed to clean up OAuth state:', cleanupError);
        }
      }

      return redirectToApp('cancelled');
    }

    if (!code || !state) {
      console.error('Facebook callback missing code/state');
      return redirectToApp('error');
    }

    const stateHash = hashState(state);

    /**
     * Find a valid, unused, non-expired OAuth state.
     */
    const stateRows = await db
      .select()
      .from(facebookOAuthStates)
      .where(
        and(
          eq(facebookOAuthStates.stateHash, stateHash),
          isNull(facebookOAuthStates.usedAt),
          gt(facebookOAuthStates.expiresAt, new Date())
        )
      )
      .limit(1);

    const oauthState = stateRows[0];

    if (!oauthState) {
      console.error('Invalid, expired, or already-used Facebook OAuth state');
      return redirectToApp('invalid_state');
    }

    const userId = oauthState.userId;

    /**
     * Atomically claim the state. The `usedAt IS NULL` condition
     * ensures only one concurrent callback can win.
     */
    const claimResult = await db
      .update(facebookOAuthStates)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(facebookOAuthStates.id, oauthState.id),
          isNull(facebookOAuthStates.usedAt)
        )
      );

    const claimed = getAffectedRows(claimResult);

    if (claimed === 0) {
      console.error('Facebook OAuth state was claimed by another request');
      return redirectToApp('invalid_state');
    }

    const appId = getRequiredEnv('META_FACEBOOK_APP_ID');
    const appSecret = getRequiredEnv('META_FACEBOOK_APP_SECRET');
    const redirectUri = getRequiredEnv('META_FACEBOOK_REDIRECT_URI');

    /**
     * =====================================================
     * STEP 1: Exchange code for user access token.
     * (Do not send config_id here.)
     * =====================================================
     */
    const tokenParams = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    });

    const tokenResponse = await fetch(
      `${graphUrl('/oauth/access_token')}?${tokenParams.toString()}`,
      { cache: 'no-store' }
    );

    const tokenData = await readJson(tokenResponse);

    if (
      !tokenResponse.ok ||
      !isObject(tokenData) ||
      typeof tokenData.access_token !== 'string'
    ) {
      console.error('Meta token exchange failed:', {
        status: tokenResponse.status,
        response: isObject(tokenData)
          ? {
              error: tokenData.error,
              error_type: tokenData.error_type,
              error_message: tokenData.error_message,
            }
          : tokenData,
      });

      throw new Error('Unable to get Meta access token');
    }

    let userAccessToken: string = tokenData.access_token;

    /**
     * Try to upgrade to a long-lived user token so the derived
     * Page tokens do not expire. Falls back to the original
     * token if this fails, so it never breaks the flow.
     */
    try {
      const longLivedParams = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: userAccessToken,
      });

      const longLivedResponse = await fetch(
        `${graphUrl('/oauth/access_token')}?${longLivedParams.toString()}`,
        { cache: 'no-store' }
      );

      if (longLivedResponse.ok) {
        const longLivedData = await readJson(longLivedResponse);

        if (
          isObject(longLivedData) &&
          typeof longLivedData.access_token === 'string'
        ) {
          userAccessToken = longLivedData.access_token;
        }
      } else {
        console.warn(
          'Long-lived token exchange failed, using original token:',
          longLivedResponse.status
        );
      }
    } catch (longLivedError) {
      console.warn('Long-lived token exchange error:', longLivedError);
    }

    /**
     * =====================================================
     * STEP 2: Fetch all Pages (with pagination).
     * =====================================================
     */
    const accountsParams = new URLSearchParams({
      access_token: userAccessToken,
      fields: 'id,name,access_token,picture',
      limit: '100',
    });

    let nextUrl: string | null =
      `${graphUrl('/me/accounts')}?${accountsParams.toString()}`;

    const allItems: unknown[] = [];
    let requestCount = 0;

    while (nextUrl && requestCount < MAX_PAGE_REQUESTS) {
      requestCount += 1;

      const accountsResponse: Response = await fetch(nextUrl, {
        cache: 'no-store',
      });

      const accountsData = await readJson(accountsResponse);

      if (!accountsResponse.ok || !isObject(accountsData)) {
        console.error('Meta Pages request failed:', {
          status: accountsResponse.status,
          response: isObject(accountsData)
            ? {
                error: accountsData.error,
                error_type: accountsData.error_type,
                error_message: accountsData.error_message,
              }
            : accountsData,
        });

        throw new Error('Unable to get Facebook Pages');
      }

      if (!Array.isArray(accountsData.data)) {
        console.error('Invalid Facebook Pages response');
        throw new Error('Invalid Facebook Pages response');
      }

      allItems.push(...accountsData.data);

      const paging: unknown = accountsData.paging;

      nextUrl =
        isObject(paging) && typeof paging.next === 'string'
          ? paging.next
          : null;
    }

    /**
     * Keep only Pages with a valid ID and Page access token.
     */
    const validPages = allItems.filter((item): item is RawPage => {
      if (!isObject(item)) return false;

      return (
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        typeof item.access_token === 'string' &&
        item.access_token.length > 0
      );
    });

    if (validPages.length === 0) {
      console.log('No Facebook Pages available for user:', userId);
      return redirectToApp('no_account');
    }

    /**
     * =====================================================
     * STEP 3: Verify each Page, encrypt token, save.
     * =====================================================
     */
    let savedCount = 0;

    for (const page of validPages) {
      try {
        const pageToken = page.access_token!;

        const verifyParams = new URLSearchParams({
          access_token: pageToken,
          fields: 'id,name',
        });

        const verifyResponse = await fetch(
          `${graphUrl(`/${encodeURIComponent(page.id)}`)}?${verifyParams.toString()}`,
          { cache: 'no-store' }
        );

        const verifyData = await readJson(verifyResponse);

        if (
          !verifyResponse.ok ||
          !isObject(verifyData) ||
          typeof verifyData.id !== 'string'
        ) {
          console.error('Facebook Page verification failed:', {
            pageId: page.id,
            status: verifyResponse.status,
          });

          continue;
        }

        const encryptedToken = encryptFacebookToken(pageToken);

        const pageName =
          page.name ??
          (typeof verifyData.name === 'string' ? verifyData.name : null);

        const pagePicture = page.picture?.data?.url ?? null;

        const existing = await db
          .select({ id: facebookConnections.id })
          .from(facebookConnections)
          .where(
            and(
              eq(facebookConnections.userId, userId),
              eq(facebookConnections.pageId, page.id)
            )
          )
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(facebookConnections)
            .set({
              pageName,
              pageProfilePicture: pagePicture,
              accessToken: encryptedToken,
              status: 'active',
              lastVerifiedAt: new Date(),
              lastError: null,
              updatedAt: new Date(),
            })
            .where(eq(facebookConnections.id, existing[0].id));
        } else {
          await db.insert(facebookConnections).values({
            userId,
            pageId: page.id,
            pageName,
            pageProfilePicture: pagePicture,
            accessToken: encryptedToken,
            status: 'active',
            connectedAt: new Date(),
            lastVerifiedAt: new Date(),
            lastError: null,
          });
        }

        savedCount += 1;
      } catch (pageError) {
        /**
         * One Page failing must not block the others.
         */
        console.error(`Failed to save Facebook Page ${page.id}:`, pageError);
      }
    }

    if (savedCount === 0) {
      return redirectToApp('no_account');
    }

    /**
     * State was already claimed; remove it after success.
     */
    await db
      .delete(facebookOAuthStates)
      .where(eq(facebookOAuthStates.id, oauthState.id));

    console.log('Facebook connection successful:', {
      userId,
      savedPages: savedCount,
    });

    return redirectToApp('connected');
  } catch (error) {
    console.error('Facebook callback error:', error);

    /**
     * Never expose internal Meta/API/database errors to the browser.
     */
    return redirectToApp('error');
  }
}