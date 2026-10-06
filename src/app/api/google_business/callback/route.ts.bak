import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import {
  getGoogleBusinessFrontendUrl,
  verifyGoogleBusinessState,
} from '@/lib/googleBusiness';

function redirectToFrontend(status: 'connected' | 'error', message?: string) {
  const url = new URL(`${getGoogleBusinessFrontendUrl()}/dashboard`);
  url.searchParams.set('google_business', status);

  if (message) {
    url.searchParams.set('message', message);
  }

  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const error = searchParams.get('error');
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (error) {
    return redirectToFrontend('error', error);
  }

  if (!code || !state) {
    return redirectToFrontend('error', 'missing_code_or_state');
  }

  const stateData = verifyGoogleBusinessState(state);

  if (!stateData) {
    return redirectToFrontend('error', 'invalid_or_expired_state');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return redirectToFrontend('error', 'google_oauth_not_configured');
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      cache: 'no-store',
    });

    if (!tokenResponse.ok) {
      console.error('[Google Business Callback] Token exchange failed:', tokenResponse.status);
      return redirectToFrontend('error', 'token_exchange_failed');
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokenData.access_token) {
      return redirectToFrontend('error', 'missing_access_token');
    }

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      cache: 'no-store',
    });
    const profile = profileResponse.ok
      ? (await profileResponse.json()) as { sub?: string; name?: string; email?: string }
      : {};

    const provider = 'google_business';
    const [existing] = await db
      .select({ id: socialAccounts.id, refreshToken: socialAccounts.refreshToken })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.userId, stateData.userId), eq(socialAccounts.provider, provider)))
      .limit(1);

    const values = {
      userId: stateData.userId,
      provider,
      providerAccountId: profile.sub || null,
      accountName: profile.name || profile.email || null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || existing?.refreshToken || null,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
    };

    if (existing) {
      await db.update(socialAccounts).set(values).where(eq(socialAccounts.id, existing.id));
    } else {
      await db.insert(socialAccounts).values(values);
    }

    return redirectToFrontend('connected');
  } catch (callbackError) {
    console.error('[Google Business Callback] Error:', callbackError);
    return redirectToFrontend('error', 'connection_failed');
  }
}