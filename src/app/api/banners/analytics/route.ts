// src/app/api/banners/analytics/route.ts
//
// GET /api/banners/analytics            -> summary for every banner the
//                                          user has published, grouped by
//                                          platform
// GET /api/banners/analytics?bannerId=5 -> summary for just that banner
//
// Reads the bannerPublications rows written by
// src/app/api/banners/publish/route.ts (recordBannerPublication) to know
// which external post ID to ask each platform's insights API about.

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import {
  banners,
  bannerPublications,
  facebookConnections,
  instagramConnections,
  socialAccounts,
} from '@/db/schema';

import { eq, and, inArray } from 'drizzle-orm';

import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { decryptFacebookToken } from '@/lib/facebook-token';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const FB_GRAPH_API_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const IG_GRAPH_API_BASE = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
const LINKEDIN_API_BASE = 'https://api.linkedin.com/v2';
const YOUTUBE_ANALYTICS_API_BASE = 'https://youtubeanalytics.googleapis.com/v2';
const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

function getErrorMessage(data: any, fallback: string): string {
  return data?.error?.message || data?.error_message || data?.message || fallback;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateRange(days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

// social_accounts.metadata is a free-form JSON string holding whatever
// extra fields a given provider needs beyond providerAccountId/accountName
// (see schema-additions.ts / migration.sql). Parse it defensively.
function parseAccountMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/* =========================================================
   FACEBOOK — post-level insights
   NOTE: post_impressions/post_clicks are Page-post metrics and
   require the page access token, not a user token.
========================================================= */
async function fetchFacebookPostInsights(postId: string, accessToken: string) {
  const url =
    `${FB_GRAPH_API_BASE}/${postId}/insights` +
    `?metric=post_impressions,post_impressions_unique,post_clicks` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(data, 'Facebook insights request failed'));
  }

  const byName: Record<string, number> = {};
  for (const metric of data?.data || []) {
    byName[metric.name] = metric.values?.[0]?.value ?? 0;
  }

  return {
    impressions: byName.post_impressions || 0,
    reach: byName.post_impressions_unique || 0,
    clicks: byName.post_clicks || 0,
  };
}

/* =========================================================
   INSTAGRAM — media-level insights
   NOTE: for some media/account types Meta has replaced the
   "impressions" metric with "views" — if this starts erroring,
   switch the metric list to metric=views,reach,profile_visits.
========================================================= */
async function fetchInstagramMediaInsights(mediaId: string, accessToken: string) {
  const url =
    `${IG_GRAPH_API_BASE}/${mediaId}/insights` +
    `?metric=impressions,reach,profile_visits` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(data, 'Instagram insights request failed'));
  }

  const byName: Record<string, number> = {};
  for (const metric of data?.data || []) {
    byName[metric.name] = metric.values?.[0]?.value ?? 0;
  }

  return {
    impressions: byName.impressions || 0,
    reach: byName.reach || 0,
    profileVisits: byName.profile_visits || 0,
  };
}

/* =========================================================
   LINKEDIN — organization share statistics
========================================================= */
async function fetchLinkedInShareStats(
  organizationUrn: string,
  shareUrn: string,
  accessToken: string
) {
  const url =
    `${LINKEDIN_API_BASE}/organizationalEntityShareStatistics` +
    `?q=organizationalEntity&organizationalEntity=${encodeURIComponent(organizationUrn)}` +
    `&shares[0]=${encodeURIComponent(shareUrn)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    cache: 'no-store',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(data, 'LinkedIn share statistics request failed'));
  }

  const stats = data?.elements?.[0]?.totalShareStatistics || {};

  return {
    impressions: stats.impressionCount || 0,
    clicks: stats.clickCount || 0,
    likes: stats.likeCount || 0,
    comments: stats.commentCount || 0,
    shares: stats.shareCount || 0,
  };
}

/* =========================================================
   YOUTUBE ANALYTICS — channel-level only.
   Banners aren't videos, so there's no per-banner YouTube metric;
   this reports the connected channel's overall recent performance
   so it still shows up on the dashboard.
========================================================= */
async function fetchYoutubeChannelStats(channelId: string, accessToken: string) {
  const { startDate, endDate } = dateRange(30);

  const url =
    `${YOUTUBE_ANALYTICS_API_BASE}/reports` +
    `?ids=${encodeURIComponent(`channel==${channelId}`)}` +
    `&startDate=${startDate}&endDate=${endDate}` +
    `&metrics=views,likes,comments`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(data, 'YouTube Analytics request failed'));
  }

  const row: number[] = data?.rows?.[0] || [0, 0, 0];

  return {
    views: row[0] || 0,
    likes: row[1] || 0,
    comments: row[2] || 0,
    period: { startDate, endDate },
  };
}

/* =========================================================
   GOOGLE ANALYTICS (GA4) — pageviews/clicks for a banner's
   landing page.
   ASSUMPTION: each banner's click-through link lands on
   `${PUBLIC_BASE_URL}/p/{bannerId}` (or contains that path).
   If your banners route to a different URL pattern, change the
   `CONTAINS` filter value below to match it.
========================================================= */
async function fetchGoogleAnalyticsForBanner(
  propertyId: string, // e.g. 'properties/123456789'
  accessToken: string,
  bannerId: number
) {
  const { startDate, endDate } = dateRange(30);

  const url = `${GA4_DATA_API_BASE}/${propertyId}:runReport`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'eventCount' },
        { name: 'activeUsers' },
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          stringFilter: { matchType: 'CONTAINS', value: `/p/${bannerId}` },
        },
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(data, 'Google Analytics report failed'));
  }

  const row = data?.rows?.[0];

  return {
    pageviews: Number(row?.metricValues?.[0]?.value || 0),
    clicks: Number(row?.metricValues?.[1]?.value || 0),
    users: Number(row?.metricValues?.[2]?.value || 0),
    period: { startDate, endDate },
  };
}

/* =========================================================
   GET /api/banners/analytics
========================================================= */

export async function GET(req: NextRequest) {

  try {

    let userId: number;

    try {
      userId = getUserIdFromRequest(req);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json(
          { success: false, message: error.message },
          { status: 401 }
        );
      }
      throw error;
    }

    const { searchParams } = new URL(req.url);
    const bannerIdParam = searchParams.get('bannerId');

    /* Find every bannerPublications row for this user (optionally
       scoped to one banner), grouped by bannerId. */

    const publicationRows = bannerIdParam
      ? await db
          .select()
          .from(bannerPublications)
          .where(
            and(
              eq(bannerPublications.userId, userId),
              eq(bannerPublications.bannerId, Number(bannerIdParam))
            )
          )
      : await db
          .select()
          .from(bannerPublications)
          .where(eq(bannerPublications.userId, userId));

    if (publicationRows.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No published banners found for this user yet',
        banners: [],
      });
    }

    const bannerIds = Array.from(new Set(publicationRows.map((r) => r.bannerId)));

    const bannerRows = await db
      .select()
      .from(banners)
      .where(inArray(banners.id, bannerIds));

    const bannerById = new Map(bannerRows.map((b) => [b.id, b]));

    /* Connections — fetched once, reused for every publication row
       of that platform. Facebook/Instagram still have their own
       tables; LinkedIn/YouTube/Google Analytics are all rows in the
       generic social_accounts table (provider column). */

    const [fbConnRows, igConnRows, allSocialAccountRows] =
      await Promise.all([
        db.select().from(facebookConnections).where(eq(facebookConnections.userId, userId)),
        db.select().from(instagramConnections).where(eq(instagramConnections.userId, userId)),
        db.select().from(socialAccounts).where(eq(socialAccounts.userId, userId)),
      ]);

    const fbConnection = fbConnRows[0];
    const igConnection = igConnRows[0];

    const liConnection = allSocialAccountRows.find((r) => r.provider === 'linkedin');
    const ytConnection = allSocialAccountRows.find((r) => r.provider === 'youtube');
    const gaConnection = allSocialAccountRows.find((r) => r.provider === 'google_analytics');

    const liMetadata = parseAccountMetadata((liConnection as any)?.metadata);
    const ytMetadata = parseAccountMetadata((ytConnection as any)?.metadata);
    const gaMetadata = parseAccountMetadata((gaConnection as any)?.metadata);

    /* Build the per-banner result shape. */

    const bannersOut: Record<number, any> = {};

    for (const id of bannerIds) {
      const b = bannerById.get(id);
      bannersOut[id] = {
        bannerId: id,
        day: b?.day ?? null,
        theme: b?.theme ?? null,
        platforms: {},
      };
    }

    /* FACEBOOK + INSTAGRAM + LINKEDIN — per-publication metrics */

    for (const row of publicationRows) {
      const target = bannersOut[row.bannerId];
      if (!target) continue;

      try {
        if (row.platform === 'facebook' && fbConnection) {
          const pageAccessToken = decryptFacebookToken(
            String(fbConnection.accessToken || '')
          );
          target.platforms.facebook = await fetchFacebookPostInsights(
            row.externalId,
            pageAccessToken
          );
        }

        if (row.platform === 'instagram' && igConnection) {
          target.platforms.instagram = await fetchInstagramMediaInsights(
            row.externalId,
            String(igConnection.accessToken || '')
          );
        }

        if (row.platform === 'linkedin' && liConnection) {
          const ownerUrn = String(liMetadata.ownerUrn || '').trim();

          if (!ownerUrn) {
            target.platforms.linkedin = {
              error: 'LinkedIn connection is missing an ownerUrn in metadata.',
            };
          } else {
            target.platforms.linkedin = await fetchLinkedInShareStats(
              ownerUrn,
              row.externalId,
              String(liConnection.accessToken || '')
            );
          }
        }

        if (row.platform === 'google_business') {
          // Business Profile Performance API only exposes location-level
          // metrics (views/searches for the whole location), not a
          // breakdown per individual local post — so there's no
          // meaningful per-banner number to show here yet.
          target.platforms.google_business = {
            note: 'Google Business only reports location-level performance, not per-post metrics.',
          };
        }
      } catch (error: any) {
        console.error(`[Analytics] ${row.platform} insights failed for banner ${row.bannerId}:`, error);
        target.platforms[row.platform] = {
          error: error?.message || `${row.platform} insights request failed`,
        };
      }
    }

    /* YOUTUBE — channel-level, attached to every banner for visibility
       since it isn't tied to a specific post. */

    const ytChannelId = String(ytMetadata.channelId || ytConnection?.providerAccountId || '').trim();

    if (ytChannelId && ytConnection?.accessToken) {
      try {
        const ytStats = await fetchYoutubeChannelStats(
          ytChannelId,
          String(ytConnection.accessToken)
        );
        for (const id of bannerIds) {
          bannersOut[id].platforms.youtube = {
            ...ytStats,
            note: 'Channel-level stats — YouTube has no per-banner post to measure.',
          };
        }
      } catch (error: any) {
        console.error('[Analytics] YouTube channel stats failed:', error);
      }
    }

    /* GOOGLE ANALYTICS (GA4) — per-banner landing-page traffic */

    const gaPropertyId = String(gaMetadata.propertyId || '').trim();

    if (gaPropertyId && gaConnection?.accessToken) {
      for (const id of bannerIds) {
        try {
          bannersOut[id].platforms.website = await fetchGoogleAnalyticsForBanner(
            gaPropertyId,
            String(gaConnection.accessToken),
            id
          );
        } catch (error: any) {
          console.error(`[Analytics] GA4 report failed for banner ${id}:`, error);
          bannersOut[id].platforms.website = {
            error: error?.message || 'Google Analytics report failed',
          };
        }
      }
    }

    return NextResponse.json({
      success: true,
      banners: Object.values(bannersOut),
    });

  } catch (error: any) {

    console.error('[Analytics] Unexpected error:', error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || 'Failed to load banner analytics',
        error:
          process.env.NODE_ENV === 'development'
            ? String(error?.stack || error)
            : undefined,
      },
      { status: 500 }
    );
  }
}