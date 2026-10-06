// src/app/api/linkedin/connect/route.ts

import { NextRequest, NextResponse } from 'next/server';

import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { createSocialOAuthState } from '@/lib/socialOAuth';

// Personal profile posting.
const PERSONAL_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

// Company page listing + posting. LinkedIn only grants these if your app
// has the "Community Management API" product approved. If it does not,
// the authorize step fails with `unauthorized_scope_error`, so these are
// behind an env flag. Set LINKEDIN_ENABLE_ORG_SCOPES=true once approved.
const ORGANIZATION_SCOPES = ['r_organization_admin', 'w_organization_social'];

export async function POST(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      return NextResponse.json(
        { success: false, message: 'LinkedIn OAuth is not configured' },
        { status: 500 }
      );
    }

    const enableOrgScopes =
      String(process.env.LINKEDIN_ENABLE_ORG_SCOPES || '').toLowerCase() === 'true';

    const scopes = enableOrgScopes
      ? [...PERSONAL_SCOPES, ...ORGANIZATION_SCOPES]
      : PERSONAL_SCOPES;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: createSocialOAuthState(userId, 'linkedin'),
      scope: scopes.join(' '),
    });

    return NextResponse.json({
      success: true,
      redirectUrl: `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 401 });
    }

    console.error('[LinkedIn Connect] Error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to start LinkedIn connection' },
      { status: 500 }
    );
  }
}