import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';

import { db } from '@/db';
import { socialAccounts } from '@/db/schema';

import {
  getGoogleBusinessFrontendUrl,
  verifyGoogleBusinessState,
} from '@/lib/googleBusiness';

const GOOGLE_BUSINESS_ACCOUNT_API_BASE =
  'https://mybusinessaccountmanagement.googleapis.com/v1';

const GOOGLE_BUSINESS_INFORMATION_API_BASE =
  'https://mybusinessbusinessinformation.googleapis.com/v1';

type GoogleAccount = {
  name?: string;
  accountName?: string;
  type?: string;
  role?: string;
};

type GoogleLocation = {
  name?: string;
  title?: string;
  storefrontAddress?: unknown;
  websiteUri?: string;
};

type GoogleAccountsResponse = {
  accounts?: GoogleAccount[];
  nextPageToken?: string;
};

type GoogleLocationsResponse = {
  locations?: GoogleLocation[];
  nextPageToken?: string;
};

type ResolvedGoogleBusinessLocation = {
  accountId: string;
  accountName: string | null;
  locationId: string;
  locationName: string | null;
  locationResourceName: string;
};

/**
 * Redirect user back to frontend.
 */
function redirectToFrontend(
  status: 'connected' | 'error',
  message?: string
) {
  const url = new URL(`${getGoogleBusinessFrontendUrl()}/dashboard`);

  url.searchParams.set('google_business', status);

  if (message) {
    url.searchParams.set('message', message);
  }

  return NextResponse.redirect(url);
}

/**
 * Safely parse JSON response.
 */
async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Get all Google Business Profile accounts accessible by the OAuth token.
 *
 * Google endpoint:
 * GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts
 */
async function listGoogleBusinessAccounts(
  accessToken: string
): Promise<GoogleAccount[]> {
  const accounts: GoogleAccount[] = [];

  let pageToken: string | undefined;

  for (let page = 0; page < 20; page++) {
    const url = new URL(
      `${GOOGLE_BUSINESS_ACCOUNT_API_BASE}/accounts`
    );

    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      console.error(
        '[Google Business Callback] Accounts lookup failed:',
        {
          status: response.status,
          body,
        }
      );

      return [];
    }

    const data = await safeJson<GoogleAccountsResponse>(response);

    if (!data) {
      console.error(
        '[Google Business Callback] Invalid accounts response'
      );

      return [];
    }

    if (Array.isArray(data.accounts)) {
      accounts.push(...data.accounts);
    }

    pageToken = data.nextPageToken;

    if (!pageToken) {
      break;
    }
  }

  return accounts;
}

/**
 * Get locations for one Google Business Profile account.
 *
 * Current Business Information API requires readMask.
 */
async function listGoogleBusinessLocations(
  accessToken: string,
  accountName: string
): Promise<GoogleLocation[]> {
  const url = new URL(
    `${GOOGLE_BUSINESS_INFORMATION_API_BASE}/${accountName}/locations`
  );

  url.searchParams.set(
    'readMask',
    'name,title,storefrontAddress,websiteUri'
  );

  url.searchParams.set('pageSize', '100');

  const locations: GoogleLocation[] = [];

  let pageToken: string | undefined;

  for (let page = 0; page < 20; page++) {
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    } else {
      url.searchParams.delete('pageToken');
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      console.error(
        '[Google Business Callback] Locations lookup failed:',
        {
          accountName,
          status: response.status,
          body,
        }
      );

      return [];
    }

    const data = await safeJson<GoogleLocationsResponse>(response);

    if (!data) {
      console.error(
        '[Google Business Callback] Invalid locations response:',
        accountName
      );

      return [];
    }

    if (Array.isArray(data.locations)) {
      locations.push(...data.locations);
    }

    pageToken = data.nextPageToken;

    if (!pageToken) {
      break;
    }
  }

  return locations;
}

/**
 * Resolve an actual Business Profile account + location.
 *
 * We don't assume accounts[0] is always the correct account.
 * We inspect accessible accounts until we find one with locations.
 */
async function resolveGoogleBusinessLocation(
  accessToken: string
): Promise<ResolvedGoogleBusinessLocation | null> {
  console.log(
    '[Google Business Callback] Resolving Business Profile account/location...'
  );

  const accounts = await listGoogleBusinessAccounts(accessToken);

  console.log(
    '[Google Business Callback] Accessible accounts:',
    accounts.map((account) => ({
      name: account.name,
      accountName: account.accountName,
      type: account.type,
      role: account.role,
    }))
  );

  if (!accounts.length) {
    console.error(
      '[Google Business Callback] No Business Profile accounts found'
    );

    return null;
  }

  /**
   * Prefer normal accounts that can actually contain locations.
   *
   * Personal / location-group accounts can expose locations.
   * We simply test each accessible account instead of assuming one type.
   */
  for (const account of accounts) {
    const accountResourceName = account.name?.trim();

    if (!accountResourceName) {
      continue;
    }

    if (!/^accounts\/[^/]+$/.test(accountResourceName)) {
      continue;
    }

    const accountId = accountResourceName.replace(
      /^accounts\//,
      ''
    );

    if (!accountId) {
      continue;
    }

    console.log(
      '[Google Business Callback] Checking account:',
      {
        accountId,
        accountResourceName,
        accountName: account.accountName,
        type: account.type,
      }
    );

    const locations = await listGoogleBusinessLocations(
      accessToken,
      accountResourceName
    );

    console.log(
      '[Google Business Callback] Locations found:',
      {
        accountId,
        count: locations.length,
      }
    );

    if (!locations.length) {
      continue;
    }

    /**
     * Select the first actual location.
     *
     * If later your UI supports multiple Google Business locations,
     * this can be changed to let the user select one.
     */
    for (const location of locations) {
      const resourceName = location.name?.trim();

      if (!resourceName) {
        continue;
      }

      /**
       * Current Business Information API location resource normally looks like:
       *
       * locations/123456789
       *
       * Some older responses / APIs can expose:
       *
       * accounts/123456789/locations/987654321
       *
       * Support both safely.
       */
      let locationId = '';

      const currentFormatMatch = resourceName.match(
        /^locations\/([^/]+)$/
      );

      const accountFormatMatch = resourceName.match(
        /^accounts\/[^/]+\/locations\/([^/]+)$/
      );

      if (currentFormatMatch?.[1]) {
        locationId = currentFormatMatch[1];
      } else if (accountFormatMatch?.[1]) {
        locationId = accountFormatMatch[1];
      }

      if (!locationId) {
        console.warn(
          '[Google Business Callback] Could not parse location ID:',
          resourceName
        );

        continue;
      }

      console.log(
        '[Google Business Callback] Resolved Google Business location:',
        {
          accountId,
          accountName: account.accountName || null,
          locationId,
          locationName: location.title || null,
          resourceName,
        }
      );

      return {
        accountId,
        accountName: account.accountName || null,
        locationId,
        locationName: location.title || null,
        locationResourceName: resourceName,
      };
    }
  }

  console.warn(
    '[Google Business Callback] No usable Google Business location found'
  );

  return null;
}

/**
 * Google OAuth callback.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  const code = searchParams.get('code');
  const state = searchParams.get('state');

  console.log(
    '[Google Business Callback] Callback received:',
    {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      error,
    }
  );

  /**
   * Google returned an OAuth error.
   */
  if (error) {
    console.error(
      '[Google Business Callback] Google OAuth error:',
      {
        error,
        errorDescription,
      }
    );

    return redirectToFrontend(
      'error',
      errorDescription || error
    );
  }

  /**
   * Required OAuth parameters missing.
   */
  if (!code || !state) {
    return redirectToFrontend(
      'error',
      'missing_code_or_state'
    );
  }

  /**
   * Validate our signed OAuth state.
   */
  const stateData = verifyGoogleBusinessState(state);

  if (!stateData) {
    console.error(
      '[Google Business Callback] Invalid or expired state'
    );

    return redirectToFrontend(
      'error',
      'invalid_or_expired_state'
    );
  }

  console.log(
    '[Google Business Callback] OAuth belongs to user:',
    stateData.userId
  );

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error(
      '[Google Business Callback] Missing Google OAuth environment variables'
    );

    return redirectToFrontend(
      'error',
      'google_oauth_not_configured'
    );
  }

  try {
    /**
     * ---------------------------------------------------------
     * 1. Exchange OAuth authorization code for tokens
     * ---------------------------------------------------------
     */
    const tokenResponse = await fetch(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
        cache: 'no-store',
      }
    );

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => '');

      console.error(
        '[Google Business Callback] Token exchange failed:',
        {
          status: tokenResponse.status,
          body,
        }
      );

      return redirectToFrontend(
        'error',
        'token_exchange_failed'
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    if (!tokenData.access_token) {
      console.error(
        '[Google Business Callback] Missing access_token'
      );

      return redirectToFrontend(
        'error',
        'missing_access_token'
      );
    }

    console.log(
      '[Google Business Callback] Google token exchange successful'
    );

    /**
     * ---------------------------------------------------------
     * 2. Get Google profile
     * ---------------------------------------------------------
     */
    const profileResponse = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
        cache: 'no-store',
      }
    );

    const profile = profileResponse.ok
      ? ((await profileResponse.json()) as {
          sub?: string;
          name?: string;
          email?: string;
          picture?: string;
        })
      : {};

    console.log(
      '[Google Business Callback] Google profile:',
      {
        sub: profile.sub,
        name: profile.name,
        email: profile.email,
      }
    );

    /**
     * ---------------------------------------------------------
     * 3. Resolve actual Business Profile location
     * ---------------------------------------------------------
     */
    const location =
      await resolveGoogleBusinessLocation(
        tokenData.access_token
      );

    if (location) {
      console.log(
        '[Google Business Callback] Business location resolved:',
        location
      );
    } else {
      console.warn(
        '[Google Business Callback] Connected but no Business Profile location resolved'
      );
    }

    /**
     * ---------------------------------------------------------
     * 4. Find existing connection
     * ---------------------------------------------------------
     */
    const provider = 'google_business';

    const [existing] = await db
      .select({
        id: socialAccounts.id,
        refreshToken: socialAccounts.refreshToken,
        metadata: socialAccounts.metadata,
      })
      .from(socialAccounts)
      .where(
        and(
          eq(
            socialAccounts.userId,
            stateData.userId
          ),
          eq(
            socialAccounts.provider,
            provider
          )
        )
      )
      .limit(1);

    /**
     * Preserve existing metadata.
     */
    let existingMetadata: Record<string, unknown> = {};

    if (
      existing?.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
    ) {
      existingMetadata =
        existing.metadata as Record<string, unknown>;
    }

    /**
     * Add Google Business location information.
     *
     * This is the critical part that was missing from your DB.
     */
    const metadata = {
      ...existingMetadata,

      ...(location
        ? {
            accountId: location.accountId,
            accountResourceName:
              `accounts/${location.accountId}`,

            locationId: location.locationId,
            locationResourceName:
              location.locationResourceName,

            locationName:
              location.locationName,

            googleAccountName:
              location.accountName,
          }
        : {}),
    };

    /**
     * ---------------------------------------------------------
     * 5. Prepare DB values
     * ---------------------------------------------------------
     *
     * IMPORTANT:
     * Google often does not return a refresh token on every
     * reconnect. Therefore preserve the old refresh token.
     */
    const values = {
      userId: stateData.userId,

      provider,

      providerAccountId:
        profile.sub || null,

      accountName:
        profile.name ||
        profile.email ||
        location?.accountName ||
        null,

      accessToken:
        tokenData.access_token,

      refreshToken:
        tokenData.refresh_token ||
        existing?.refreshToken ||
        null,

      metadata,

      expiresAt:
        tokenData.expires_in
          ? new Date(
              Date.now() +
                tokenData.expires_in * 1000
            )
          : null,
    };

    /**
     * ---------------------------------------------------------
     * 6. Insert / update social_accounts
     * ---------------------------------------------------------
     */
    if (existing) {
      await db
        .update(socialAccounts)
        .set(values)
        .where(
          eq(
            socialAccounts.id,
            existing.id
          )
        );

      console.log(
        '[Google Business Callback] Existing connection updated:',
        {
          id: existing.id,
          userId: stateData.userId,
          hasLocation: Boolean(location),
          locationId:
            location?.locationId || null,
        }
      );
    } else {
      await db
        .insert(socialAccounts)
        .values(values);

      console.log(
        '[Google Business Callback] New connection created:',
        {
          userId: stateData.userId,
          hasLocation: Boolean(location),
          locationId:
            location?.locationId || null,
        }
      );
    }

    /**
     * ---------------------------------------------------------
     * 7. Final redirect
     * ---------------------------------------------------------
     */
    if (!location) {
      /**
       * Connection itself is valid, but there is no usable
       * Business Profile location.
       *
       * We still mark the OAuth connection as connected.
       */
      return redirectToFrontend(
        'connected',
        'google_connected_but_location_not_found'
      );
    }

    return redirectToFrontend(
      'connected'
    );
  } catch (callbackError) {
    console.error(
      '[Google Business Callback] Unexpected error:',
      callbackError
    );

    return redirectToFrontend(
      'error',
      'connection_failed'
    );
  }
}