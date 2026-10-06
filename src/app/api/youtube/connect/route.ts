import { NextRequest, NextResponse } from 'next/server';

import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { createSocialOAuthState } from '@/lib/socialOAuth';

export async function POST(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      return NextResponse.json(
        { success: false, message: 'YouTube OAuth is not configured' },
        { status: 500 }
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ].join(' '),
      state: createSocialOAuthState(userId, 'youtube'),
    });

    return NextResponse.json({
      success: true,
      redirectUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }

    console.error('[YouTube Connect] Error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to start YouTube connection' },
      { status: 500 }
    );
  }
}
