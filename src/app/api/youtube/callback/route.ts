import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import {
  getSocialOAuthFrontendUrl,
  verifySocialOAuthState,
} from '@/lib/socialOAuth';

function redirectToFrontend(status: 'connected' | 'select' | 'no_account' | 'error', message?: string) {
  const url = new URL(`${getSocialOAuthFrontendUrl()}/social-connections`);
  url.searchParams.set('youtube', status);

  if (message) {
    url.searchParams.set('message', message);
  }

  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) return redirectToFrontend('error', error);
  if (!code || !state) return redirectToFrontend('error', 'missing_code_or_state');

  const stateData = verifySocialOAuthState(state, 'youtube');
  if (!stateData) return redirectToFrontend('error', 'invalid_or_expired_state');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return redirectToFrontend('error', 'youtube_oauth_not_configured');
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

    if (!tokenResponse.ok) return redirectToFrontend('error', 'token_exchange_failed');

    const tokenData = await tokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokenData.access_token) return redirectToFrontend('error', 'missing_access_token');

    const channelsUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelsUrl.searchParams.set('part', 'id,snippet,contentDetails');
    channelsUrl.searchParams.set('mine', 'true');
    channelsUrl.searchParams.set('maxResults', '50');
    const channelsResponse = await fetch(channelsUrl, {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
      cache: 'no-store',
    });
    const channelsData = await channelsResponse.json() as {
      items?: Array<{
        id?: string;
        snippet?: {
          title?: string;
          customUrl?: string;
          thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
        };
        contentDetails?: { relatedPlaylists?: { uploads?: string } };
      }>;
      error?: { message?: string };
    };

    if (!channelsResponse.ok) {
      console.error('[YouTube Callback] Channel lookup failed:', {
        status: channelsResponse.status,
        message: channelsData.error?.message,
      });
      return redirectToFrontend('error', 'channel_lookup_failed');
    }

    const channels = (channelsData.items ?? [])
      .filter((channel) => typeof channel.id === 'string' && channel.id.length > 0)
      .map((channel) => ({
        id: channel.id!,
        title: channel.snippet?.title || 'YouTube channel',
        customUrl: channel.snippet?.customUrl || null,
        thumbnailUrl:
          channel.snippet?.thumbnails?.medium?.url ||
          channel.snippet?.thumbnails?.default?.url ||
          null,
        uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads || null,
      }));

    if (channels.length === 0) return redirectToFrontend('no_account');

    const profileResponse = await fetch(
      'https://www.googleapis.com/oauth2/v3/userinfo',
      { headers: { Authorization: `Bearer ${tokenData.access_token}` }, cache: 'no-store' }
    );
    const profile = profileResponse.ok
      ? await profileResponse.json() as { sub?: string; name?: string; email?: string }
      : {};

    const provider = 'youtube';
    const [existing] = await db
      .select({ id: socialAccounts.id, refreshToken: socialAccounts.refreshToken })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.userId, stateData.userId), eq(socialAccounts.provider, provider)))
      .limit(1);

    const selectedChannel = channels.length === 1 ? channels[0] : null;
    const values = {
      userId: stateData.userId,
      provider,
      providerAccountId: selectedChannel?.id || null,
      accountName: selectedChannel?.title || null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || existing?.refreshToken || null,
      metadata: {
        googleAccountId: profile.sub || null,
        googleAccountEmail: profile.email || null,
        channelSelectionRequired: channels.length > 1,
        availableChannels: channels.length > 1 ? channels : [],
        channelId: selectedChannel?.id || null,
        channelTitle: selectedChannel?.title || null,
        channelCustomUrl: selectedChannel?.customUrl || null,
        channelThumbnailUrl: selectedChannel?.thumbnailUrl || null,
        uploadsPlaylistId: selectedChannel?.uploadsPlaylistId || null,
      },
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
    };

    if (existing) {
      await db.update(socialAccounts).set(values).where(eq(socialAccounts.id, existing.id));
    } else {
      await db.insert(socialAccounts).values(values);
    }

    return redirectToFrontend(selectedChannel ? 'connected' : 'select');
  } catch (callbackError) {
    console.error('[YouTube Callback] Error:', callbackError);
    return redirectToFrontend('error', 'connection_failed');
  }
}
