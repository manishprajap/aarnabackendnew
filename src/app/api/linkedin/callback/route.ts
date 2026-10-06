// src/app/api/linkedin/callback/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';
import {
  getSocialOAuthFrontendUrl,
  verifySocialOAuthState,
} from '@/lib/socialOAuth';
import { fetchLinkedInOrganizations } from '@/lib/linkedin-targets';

/* =========================
   TYPES
========================= */

interface LinkedInTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

interface LinkedInProfile {
  sub?: string;
  name?: string;
  email?: string;
}

interface LinkedInOrgMeta {
  id: string;
  urn: string;
  name: string;
}

type LinkedInMetadata = {
  ownerUrn: string;
  personal: {
    urn: string;
    id: string;
    name: string;
    email?: string;
  };
  organizations: LinkedInOrgMeta[];
  // NOTE: selectedOrgUrn is kept for backward compatibility (old single-select
  // flow) but posting now reads `selectedTargets` instead. See status route.
  selectedOrgUrn: string | null;
  selectedTargets: string[]; // 'personal' and/or org URNs
};

/* =========================
   CONFIG
========================= */

// Set LINKEDIN_MOCK_ORGS=true in .env to test org selection UI/flow
// before the Community Management API product is approved.
const MOCK_ORGS_ENABLED =
  String(process.env.LINKEDIN_MOCK_ORGS || '').toLowerCase() === 'true';

function redirect(status: string, message?: string) {
  const url = new URL(`${getSocialOAuthFrontendUrl()}/dashboard`);
  url.searchParams.set('linkedin', status);
  if (message) url.searchParams.set('message', message);
  return NextResponse.redirect(url);
}

function mockOrganizations(): LinkedInOrgMeta[] {
  return [
    {
      id: '99999991',
      urn: 'urn:li:organization:99999991',
      name: 'Aarnexai Test Page (Mock)',
    },
    {
      id: '99999992',
      urn: 'urn:li:organization:99999992',
      name: 'Second Test Page (Mock)',
    },
  ];
}

/* =========================
   CALLBACK
========================= */

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) return redirect('error', error);
  if (!code || !state) return redirect('error', 'missing_params');

  const stateData = verifySocialOAuthState(state, 'linkedin');
  if (!stateData) return redirect('error', 'invalid_state');

  try {
    /* =========================
       TOKEN EXCHANGE
    ========================= */

    const tokenRes = await fetch(
      'https://www.linkedin.com/oauth/v2/accessToken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: process.env.LINKEDIN_CLIENT_ID!,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
          redirect_uri: process.env.LINKEDIN_REDIRECT_URI!,
        }),
      }
    );

    if (!tokenRes.ok) {
      console.error('[LinkedIn] token exchange failed:', await tokenRes.text());
      return redirect('error', 'token_exchange_failed');
    }

    const token: LinkedInTokenResponse = await tokenRes.json();
    const accessToken = token.access_token;
    if (!accessToken) return redirect('error', 'missing_token');

    /* =========================
       PROFILE
    ========================= */

    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const profile: LinkedInProfile = profileRes.ok
      ? await profileRes.json()
      : {};

    const personalId = profile.sub;
    if (!personalId) return redirect('error', 'missing_profile');

    const personalUrn = `urn:li:person:${personalId}`;

    /* =========================
       ORGANIZATIONS
       (uses the SAME versioned REST call + headers as posting does,
       so what we save here matches what we can actually post to later)
    ========================= */

    let organizations: LinkedInOrgMeta[] = [];
    let orgFetchError: string | null = null;

    if (MOCK_ORGS_ENABLED) {
      console.log('[LinkedIn] Using MOCK organizations (LINKEDIN_MOCK_ORGS=true)');
      organizations = mockOrganizations();
    } else {
      const result = await fetchLinkedInOrganizations(accessToken);
      organizations = result.organizations.map((o) => ({
        id: o.id,
        urn: o.urn,
        name: o.name,
      }));
      orgFetchError = result.error;

      if (orgFetchError) {
        // Not fatal — user still gets connected with personal profile.
        // Most common cause: LINKEDIN_ENABLE_ORG_SCOPES=false at /connect
        // time, so the token was never granted r_organization_admin.
        console.warn('[LinkedIn] org fetch warning:', orgFetchError);
      }
    }

    /* =========================
       DEFAULT TARGET SELECTION
       Default to posting to personal profile only, unless there is
       exactly one company page, in which case pre-select both.
       User can change this later from the UI (see status route + hook).
    ========================= */

    const selectedOrgUrn =
      organizations.length === 1 ? organizations[0].urn : null;

    const selectedTargets: string[] = ['personal'];
    if (selectedOrgUrn) selectedTargets.push(selectedOrgUrn);

    const metadata: LinkedInMetadata = {
      ownerUrn: personalUrn,
      personal: {
        urn: personalUrn,
        id: personalId,
        name: profile.name || profile.email || 'LinkedIn User',
        email: profile.email,
      },
      organizations,
      selectedOrgUrn,
      selectedTargets,
    };

    console.log('[LinkedIn] connected:', {
      personalUrn,
      organizations: organizations.length,
      selectedTargets,
      mock: MOCK_ORGS_ENABLED,
    });

    /* =========================
       UPSERT DB
    ========================= */

    const [existing] = await db
      .select()
      .from(socialAccounts)
      .where(
        and(
          eq(socialAccounts.userId, stateData.userId),
          eq(socialAccounts.provider, 'linkedin')
        )
      )
      .limit(1);

    const payload = {
      userId: stateData.userId,
      provider: 'linkedin',
      providerAccountId: personalId,
      accountName: metadata.personal.name,
      accessToken,
      refreshToken: token.refresh_token || null,
      metadata,
    };

    if (existing) {
      // Preserve any org list the user already had if this fetch came back
      // empty due to a transient error, so we don't wipe good data.
      if (organizations.length === 0 && orgFetchError) {
        const prevMeta = (existing.metadata || {}) as Partial<LinkedInMetadata>;
        if (prevMeta.organizations?.length) {
          payload.metadata = {
            ...metadata,
            organizations: prevMeta.organizations,
          };
        }
      }

      await db
        .update(socialAccounts)
        .set(payload)
        .where(eq(socialAccounts.id, existing.id));
    } else {
      await db.insert(socialAccounts).values(payload);
    }

    return redirect('connected');
  } catch (e) {
    console.error('[LinkedIn Callback] error:', e);
    return redirect('error', 'connection_failed');
  }
}