///src/app/api/facebook/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { facebookConnections, facebookOAuthStates } from '@/db/schema';
import { encryptFacebookToken } from '@/lib/facebook-token';
import { graphUrl } from '@/lib/facebook';

function redirectToApp(status: string): NextResponse {
  const appUrl = process.env.AARNA_APP_URL;
  if (!appUrl) throw new Error('AARNA_APP_URL is missing');
  const url = new URL('/posters', appUrl);
  url.searchParams.set('facebook', status);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      console.error('Facebook OAuth error:', {
        error,
        description: searchParams.get('error_description'),
        reason: searchParams.get('error_reason'),
      });
      return redirectToApp('cancelled');
    }

    if (!code || !state) return redirectToApp('error');

    const stateHash = crypto.createHash('sha256').update(state).digest('hex');

    const stateRows = await db
      .select()
      .from(facebookOAuthStates)
      .where(and(eq(facebookOAuthStates.stateHash, stateHash), isNull(facebookOAuthStates.usedAt)))
      .limit(1);

    const oauthState = stateRows[0];
    if (!oauthState) return redirectToApp('invalid_state');
    if (Date.now() >= oauthState.expiresAt.getTime()) return redirectToApp('expired');

    const userId = oauthState.userId;

    // Replay prevent — state use hone se pehle mark karo
    await db
      .update(facebookOAuthStates)
      .set({ usedAt: new Date() })
      .where(eq(facebookOAuthStates.id, oauthState.id));

    const appId = process.env.META_FACEBOOK_APP_ID;
    const appSecret = process.env.META_FACEBOOK_APP_SECRET;
    const redirectUri = process.env.META_FACEBOOK_REDIRECT_URI;

    if (!appId || !appSecret || !redirectUri) {
      throw new Error('Meta environment variables are missing');
    }

    // STEP 1 — code -> user access token
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
    const tokenText = await tokenResponse.text();

    let tokenData: unknown;
    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      tokenData = { raw: tokenText };
    }

    if (
      !tokenResponse.ok ||
      typeof tokenData !== 'object' ||
      tokenData === null ||
      !('access_token' in tokenData)
    ) {
      console.error('Meta token exchange error:', tokenData);
      throw new Error('Unable to get Meta access token');
    }

    const userAccessToken = String((tokenData as { access_token: unknown }).access_token);

    // STEP 2 — saari Pages fetch karo
    const accountsParams = new URLSearchParams({
      access_token: userAccessToken,
      fields: 'id,name,access_token,picture',
    });

    const accountsResponse = await fetch(
      `${graphUrl('/me/accounts')}?${accountsParams.toString()}`,
      { cache: 'no-store' }
    );
    const accountsText = await accountsResponse.text();

    let accountsData: unknown;
    try {
      accountsData = JSON.parse(accountsText);
    } catch {
      accountsData = { raw: accountsText };
    }

    if (!accountsResponse.ok || typeof accountsData !== 'object' || accountsData === null) {
      console.error('Meta accounts error:', accountsData);
      throw new Error('Unable to get Facebook Pages');
    }

    const data = (accountsData as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error('Invalid Facebook Pages response');

    type RawPage = {
      id: string;
      name?: string;
      access_token?: string;
      picture?: { data?: { url?: string } };
    };

    const validPages = data.filter(
      (item): item is RawPage =>
        typeof item === 'object' &&
        item !== null &&
        'id' in item &&
        typeof (item as { access_token?: unknown }).access_token === 'string'
    );

    if (validPages.length === 0) return redirectToApp('no_account');

    // STEP 3 — har Page verify + encrypt + upsert (userId + pageId par)
    let savedCount = 0;

    for (const page of validPages) {
      try {
        const verifyParams = new URLSearchParams({
          access_token: page.access_token!,
          fields: 'id,name',
        });

        const verifyResponse = await fetch(
          `${graphUrl(`/${encodeURIComponent(page.id)}`)}?${verifyParams.toString()}`,
          { cache: 'no-store' }
        );

        if (!verifyResponse.ok) {
          console.error('Facebook Page verification failed for', page.id);
          continue;
        }

        const encryptedToken = encryptFacebookToken(page.access_token!);
        const pageName = page.name ?? null;
        const pagePicture = page.picture?.data?.url ?? null;

        const existing = await db
          .select({ id: facebookConnections.id })
          .from(facebookConnections)
          .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.pageId, page.id)))
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
          });
        }

        savedCount += 1;
      } catch (pageError) {
        console.error(`Failed to save Facebook Page ${page.id}:`, pageError);
        // ek page fail ho to baaki pages continue karein
      }
    }

    if (savedCount === 0) return redirectToApp('no_account');

    await db.delete(facebookOAuthStates).where(eq(facebookOAuthStates.id, oauthState.id));

    return redirectToApp('connected');
  } catch (error) {
    console.error('Facebook callback error:', error);
    return redirectToApp('error');
  }
}