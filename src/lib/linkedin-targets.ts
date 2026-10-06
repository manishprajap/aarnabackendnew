// src/lib/linkedin-targets.ts

export const LINKEDIN_REST_BASE = 'https://api.linkedin.com/rest';

// YYYYMM — must be a version LinkedIn currently supports.
export const LINKEDIN_API_VERSION =
  process.env.LINKEDIN_API_VERSION || '202606';

export function linkedinHeaders(
  accessToken: string,
  json = true
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': LINKEDIN_API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

export interface LinkedInOrganization {
  urn: string; // urn:li:organization:12345
  id: string; // 12345
  name: string;
}

export interface LinkedInOrganizationsResult {
  organizations: LinkedInOrganization[];
  error: string | null;
  authExpired?: boolean;
}

/**
 * Lists the company pages the token's member administers.
 *
 * Needs the r_organization_admin (or rw_organization_admin) scope. Posting
 * as the page additionally needs w_organization_social. Both come with the
 * "Community Management API" product on your LinkedIn app.
 */
export async function fetchLinkedInOrganizations(
  accessToken: string
): Promise<LinkedInOrganizationsResult> {
  try {
    const aclRes = await fetch(
      `${LINKEDIN_REST_BASE}/organizationAcls` +
        `?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=50`,
      {
        method: 'GET',
        headers: linkedinHeaders(accessToken, false),
        cache: 'no-store',
      }
    );

    const aclData: any = await aclRes.json().catch(() => ({}));

    if (aclRes.status === 401) {
      return {
        organizations: [],
        error: 'LinkedIn session expired. Please reconnect LinkedIn.',
        authExpired: true,
      };
    }

    if (aclRes.status === 403) {
      return {
        organizations: [],
        error:
          'LinkedIn did not allow reading your company pages. Reconnect LinkedIn and approve the company page permissions.',
      };
    }

    if (!aclRes.ok) {
      return {
        organizations: [],
        error:
          aclData?.message ||
          `Could not load LinkedIn company pages (HTTP ${aclRes.status}).`,
      };
    }

    const urns: string[] = Array.from(
      new Set<string>(
        (Array.isArray(aclData?.elements) ? aclData.elements : [])
          .map((el: any) => String(el?.organization || ''))
          .filter((urn: string) => urn.startsWith('urn:li:organization:'))
      )
    );

    const organizations = await Promise.all(
      urns.map(async (urn): Promise<LinkedInOrganization> => {
        const id = urn.replace('urn:li:organization:', '');

        try {
          const orgRes = await fetch(`${LINKEDIN_REST_BASE}/organizations/${id}`, {
            method: 'GET',
            headers: linkedinHeaders(accessToken, false),
            cache: 'no-store',
          });

          const orgData: any = await orgRes.json().catch(() => ({}));

          const name =
            orgData?.localizedName ||
            orgData?.name?.localized?.en_US ||
            `Company page ${id}`;

          return { urn, id, name: String(name) };
        } catch {
          return { urn, id, name: `Company page ${id}` };
        }
      })
    );

    return { organizations, error: null };
  } catch (error: any) {
    console.error('[LinkedIn] fetchLinkedInOrganizations failed:', error);

    return {
      organizations: [],
      error: error?.message || 'Could not load LinkedIn company pages.',
    };
  }
}

/* =========================================================
   POSTING
========================================================= */

export interface LinkedInPostInput {
  accessToken: string;
  /** 'urn:li:person:xxxx' for personal, or 'urn:li:organization:xxxx' for a page */
  authorUrn: string;
  text: string;
  /** Optional single image already uploaded/registered as a LinkedIn asset URN */
  imageAssetUrn?: string;
}

export interface LinkedInPostResult {
  target: string; // the authorUrn this result is for
  ok: boolean;
  postId?: string;
  error?: string;
  authExpired?: boolean;
}

/**
 * Publishes one post to one target (personal profile OR a single company
 * page) using LinkedIn's current versioned Posts API.
 *
 * Call this once per selected target — LinkedIn does not support posting
 * to multiple authors in a single request.
 */
export async function postToLinkedIn(
  input: LinkedInPostInput
): Promise<LinkedInPostResult> {
  const { accessToken, authorUrn, text, imageAssetUrn } = input;

  const body: Record<string, any> = {
    author: authorUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (imageAssetUrn) {
    body.content = {
      media: {
        id: imageAssetUrn,
      },
    };
  }

  try {
    const res = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
      method: 'POST',
      headers: linkedinHeaders(accessToken),
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      return {
        target: authorUrn,
        ok: false,
        error: 'LinkedIn session expired. Please reconnect LinkedIn.',
        authExpired: true,
      };
    }

    if (res.status === 403) {
      const isOrg = authorUrn.startsWith('urn:li:organization:');
      return {
        target: authorUrn,
        ok: false,
        error: isOrg
          ? 'Not authorized to post to this company page. Confirm you are an admin and that w_organization_social scope was granted.'
          : 'Not authorized to post to this profile. Reconnect LinkedIn and approve posting permission.',
      };
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return {
        target: authorUrn,
        ok: false,
        error: errData?.message || `LinkedIn post failed (HTTP ${res.status}).`,
      };
    }

    // LinkedIn returns the new post's URN in the x-restli-id / x-linkedin-id header
    const postId =
      res.headers.get('x-restli-id') ||
      res.headers.get('x-linkedin-id') ||
      undefined;

    return { target: authorUrn, ok: true, postId };
  } catch (error: any) {
    console.error('[LinkedIn] postToLinkedIn failed:', error);
    return {
      target: authorUrn,
      ok: false,
      error: error?.message || 'Could not reach LinkedIn.',
    };
  }
}