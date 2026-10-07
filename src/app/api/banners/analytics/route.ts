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
  whatsappConnections,
  whatsappConversations,
  whatsappMessages,
} from '@/db/schema';

import { eq, and, inArray, count, sum } from 'drizzle-orm';

import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { decryptFacebookToken, encryptFacebookToken } from '@/lib/facebook-token';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const FB_GRAPH_API_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const IG_GRAPH_API_BASE = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
const LINKEDIN_API_BASE = 'https://api.linkedin.com/v2';
const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const GOOGLE_BUSINESS_PERFORMANCE_API_BASE =
  'https://businessprofileperformance.googleapis.com/v1';

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
   Some media product types reject impressions; retry those media
   with views while retaining reach/profile visit metrics.
========================================================= */
async function fetchInstagramMediaInsights(mediaId: string, accessToken: string) {
  const requestMetrics = async (metrics: string) => {
    const url = new URL(`${IG_GRAPH_API_BASE}/${encodeURIComponent(mediaId)}/insights`);
    url.searchParams.set('metric', metrics);
    url.searchParams.set('access_token', accessToken);
    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();
    return { response, data };
  };

  let { response, data } = await requestMetrics('impressions,reach,profile_visits');
  if (!response.ok) {
    const errorMessage = getErrorMessage(data, 'Instagram insights request failed');
    if (!/does not support the impressions metric/i.test(errorMessage)) {
      throw new Error(errorMessage);
    }

    ({ response, data } = await requestMetrics('views,reach,profile_visits'));
    if (!response.ok) {
      throw new Error(getErrorMessage(data, 'Instagram insights request failed'));
    }
  }

  const byName: Record<string, number> = {};
  for (const metric of data?.data || []) {
    byName[metric.name] = metric.values?.[0]?.value ?? 0;
  }

  return {
    impressions: byName.impressions ?? byName.views ?? 0,
    views: byName.views ?? byName.impressions ?? 0,
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
    `&shares=${encodeURIComponent(`List(${shareUrn})`)}`;

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
async function fetchGoogleBusinessLocationStats(
  locationId: string,
  accessToken: string
) {
  const { startDate, endDate } = dateRange(30);
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  const url = new URL(
    `${GOOGLE_BUSINESS_PERFORMANCE_API_BASE}/locations/${encodeURIComponent(locationId)}:fetchMultiDailyMetricsTimeSeries`
  );
  const metrics = [
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'WEBSITE_CLICKS',
    'CALL_CLICKS',
    'BUSINESS_DIRECTION_REQUESTS',
  ];

  metrics.forEach((metric) => url.searchParams.append('dailyMetrics', metric));
  url.searchParams.set('dailyRange.startDate.year', String(startYear));
  url.searchParams.set('dailyRange.startDate.month', String(startMonth));
  url.searchParams.set('dailyRange.startDate.day', String(startDay));
  url.searchParams.set('dailyRange.endDate.year', String(endYear));
  url.searchParams.set('dailyRange.endDate.month', String(endMonth));
  url.searchParams.set('dailyRange.endDate.day', String(endDay));

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(data, 'Google Business performance request failed'));
  }

  const totals: Record<string, number> = {};
  for (const series of data?.multiDailyMetricTimeSeries || []) {
    for (const metricSeries of series?.dailyMetricTimeSeries || []) {
      const metric = String(metricSeries?.dailyMetric || '');
      totals[metric] = (metricSeries?.timeSeries?.datedValues || []).reduce(
        (total: number, item: any) => total + (Number(item?.value) || 0),
        0
      );
    }
  }

  return {
    views:
      (totals.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0) +
      (totals.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0) +
      (totals.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0) +
      (totals.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0),
    clicks:
      (totals.WEBSITE_CLICKS || 0) +
      (totals.CALL_CLICKS || 0),
    directions: totals.BUSINESS_DIRECTION_REQUESTS || 0,
    periodDays: 30,
  };
}

/* =========================================================
   GOOGLE ANALYTICS (GA4) — pageviews/clicks for a banner's
   landing page.
   ASSUMPTION: each banner's click-through link lands on
   /p/{bannerId} (or contains that path).
   If your banners route to a different URL pattern, change the
   CONTAINS filter value below to match it.
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

    const bannerIds = Array.from(new Set(publicationRows.map((r) => r.bannerId)));

    const bannerRows = bannerIds.length
      ? await db
          .select()
          .from(banners)
          .where(inArray(banners.id, bannerIds))
      : [];

    const bannerById = new Map(bannerRows.map((b) => [b.id, b]));

    /* Connections — fetched once, reused for every publication row
       of that platform. Facebook/Instagram still have their own
       tables; LinkedIn/YouTube/Google Analytics are all rows in the
       generic social_accounts table (provider column). */

    const [fbConnRows, igConnRows, allSocialAccountRows, waConnRows, waConversationSummary, waMessageRows] =
      await Promise.all([
        db.select().from(facebookConnections).where(eq(facebookConnections.userId, userId)),
        db.select().from(instagramConnections).where(eq(instagramConnections.userId, userId)),
        db.select().from(socialAccounts).where(eq(socialAccounts.userId, userId)),
        db
          .select({
            businessName: whatsappConnections.businessName,
            businessPhoneNumber: whatsappConnections.businessPhoneNumber,
            status: whatsappConnections.status,
            tokenExpiresAt: whatsappConnections.tokenExpiresAt,
          })
          .from(whatsappConnections)
          .where(eq(whatsappConnections.userId, userId)),
        db
          .select({
            conversations: count(),
            unread: sum(whatsappConversations.unreadCount),
          })
          .from(whatsappConversations)
          .where(eq(whatsappConversations.userId, userId)),
        db
          .select({
            direction: whatsappMessages.direction,
            total: count(),
          })
          .from(whatsappMessages)
          .where(eq(whatsappMessages.userId, userId))
          .groupBy(whatsappMessages.direction),
      ]);

    const fbConnection = fbConnRows.find(
      (row) =>
        row.status === 'active' &&
        (!row.tokenExpiresAt || new Date(row.tokenExpiresAt).getTime() > Date.now())
    );
    let facebookPageAccessToken: string | null = null;
    let facebookTokenError: string | null = null;
    if (fbConnection?.accessToken) {
      try {
        facebookPageAccessToken = decryptFacebookToken(fbConnection.accessToken);
        if (fbConnection.accessToken.split('.').length !== 3) {
          try {
            await db
              .update(facebookConnections)
              .set({ accessToken: encryptFacebookToken(facebookPageAccessToken) })
              .where(eq(facebookConnections.id, fbConnection.id));
          } catch (migrationError) {
            console.error('[Analytics] Could not migrate legacy Facebook token encryption:', migrationError);
          }
        }
      } catch (error) {
        facebookTokenError =
          error instanceof Error ? error.message : 'Stored Facebook token is invalid';
        console.error('[Analytics] Facebook token could not be decrypted:', facebookTokenError);
      }
    }
    const igConnection = igConnRows.find(
      (row) =>
        row.status === 'active' &&
        (!row.tokenExpiresAt || new Date(row.tokenExpiresAt).getTime() > Date.now())
    );

    const hasUsableToken = (row: (typeof allSocialAccountRows)[number] | undefined) =>
      Boolean(
        row?.accessToken &&
          (!row.expiresAt || new Date(row.expiresAt).getTime() > Date.now())
      );
    const liConnection = allSocialAccountRows.find(
      (row) => row.provider === 'linkedin' && hasUsableToken(row)
    );
    const ytConnection = allSocialAccountRows.find(
      (row) => row.provider === 'youtube' && hasUsableToken(row)
    );
    const gaConnection = allSocialAccountRows.find((r) => r.provider === 'google_analytics');
    const gbConnection = allSocialAccountRows.find(
      (row) => row.provider === 'google_business' && hasUsableToken(row)
    );
    const waConnection = waConnRows.find(
      (row) =>
        row.status === 'active' &&
        (!row.tokenExpiresAt || new Date(row.tokenExpiresAt).getTime() > Date.now())
    );

    const liMetadata = parseAccountMetadata((liConnection as any)?.metadata);
    const gaMetadata = parseAccountMetadata((gaConnection as any)?.metadata);
    const gbMetadata = parseAccountMetadata((gbConnection as any)?.metadata);

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
          if (!facebookPageAccessToken) {
            target.platforms.facebook = {
              error: facebookTokenError || 'Facebook Page token is unavailable.',
            };
          } else {
            target.platforms.facebook = await fetchFacebookPostInsights(
              row.externalId,
              facebookPageAccessToken
            );
          }
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

    let googleBusinessStats: Record<string, unknown> | null = null;
    const googleBusinessLocationId = String(gbMetadata.locationId || '').trim();
    if (googleBusinessLocationId && gbConnection?.accessToken) {
      try {
        googleBusinessStats = await fetchGoogleBusinessLocationStats(
          googleBusinessLocationId,
          String(gbConnection.accessToken)
        );
      } catch (error: any) {
        console.error('[Analytics] Google Business performance failed:', error);
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

    const bannerResults = Object.values(bannersOut);
    const publicationCount = (platform: string) =>
      publicationRows.filter((row) => row.platform === platform).length;
    const sumMetric = (platform: string, metric: string): number | null => {
      let found = false;
      let total = 0;

      for (const banner of bannerResults) {
        const value = banner.platforms?.[platform]?.[metric];
        if (typeof value === 'number' && Number.isFinite(value)) {
          found = true;
          total += value;
        }
      }

      return found ? total : null;
    };
    const insightError = (platform: string) => {
      for (const banner of bannerResults) {
        const message = banner.platforms?.[platform]?.error;
        if (typeof message === 'string' && message.trim()) return message;
      }
      return null;
    };
    const whatsappMessagesByDirection = Object.fromEntries(
      waMessageRows.map((row) => [String(row.direction).toLowerCase(), Number(row.total) || 0])
    );
    const whatsappConversation = waConversationSummary[0];

    return NextResponse.json({
      success: true,
      message: publicationRows.length === 0
        ? 'No published banners found for this user yet'
        : undefined,
      banners: bannerResults,
      platforms: {
        facebook: {
          connected: Boolean(fbConnection),
          accountName: fbConnection?.pageName || null,
          posts: publicationCount('facebook'),
          impressions: sumMetric('facebook', 'impressions'),
          reach: sumMetric('facebook', 'reach'),
          clicks: sumMetric('facebook', 'clicks'),
          note: !fbConnection
            ? undefined
            : facebookTokenError ??
              (publicationCount('facebook') === 0
                ? 'Publish a Facebook post from AarnexAi to start tracking post insights.'
                : insightError('facebook') || undefined),
        },
        instagram: {
          connected: Boolean(igConnection),
          accountName: igConnection?.instagramUsername || igConnection?.instagramName || null,
          posts: publicationCount('instagram'),
          impressions: sumMetric('instagram', 'impressions'),
          views: sumMetric('instagram', 'views'),
          reach: sumMetric('instagram', 'reach'),
          profileVisits: sumMetric('instagram', 'profileVisits'),
          note: !igConnection
            ? undefined
            : publicationCount('instagram') === 0
              ? 'Publish an Instagram post from AarnexAi to start tracking post insights.'
              : insightError('instagram') || undefined,
        },
        google_business: {
          connected: Boolean(gbConnection?.accessToken),
          accountName: gbConnection?.accountName || null,
          posts: publicationCount('google_business'),
          ...(googleBusinessStats || {
            views: null,
            clicks: null,
            directions: null,
            note: googleBusinessLocationId
              ? 'Google Business performance metrics could not be loaded.'
              : 'Connect a Google Business location to load profile performance.',
          }),
        },
        youtube: {
          connected: Boolean(ytConnection?.accessToken),
          accountName: ytConnection?.accountName || null,
          posts: publicationCount('youtube'),
          views: null,
          likes: null,
          comments: null,
          note: 'YouTube Analytics is temporarily disabled.',
        },
        linkedin: {
          connected: Boolean(liConnection?.accessToken),
          accountName: liConnection?.accountName || null,
          posts: publicationCount('linkedin'),
          impressions: sumMetric('linkedin', 'impressions'),
          clicks: sumMetric('linkedin', 'clicks'),
          likes: sumMetric('linkedin', 'likes'),
          comments: sumMetric('linkedin', 'comments'),
          shares: sumMetric('linkedin', 'shares'),
          note: !liConnection
            ? undefined
            : publicationCount('linkedin') === 0
              ? 'Publish a LinkedIn post from AarnexAi to start tracking post insights.'
              : insightError('linkedin') || undefined,
        },
        whatsapp: {
          connected: Boolean(waConnection),
          accountName: waConnection?.businessName || waConnection?.businessPhoneNumber || null,
          conversations: Number(whatsappConversation?.conversations) || 0,
          unread: Number(whatsappConversation?.unread) || 0,
          messages: Object.values(whatsappMessagesByDirection).reduce(
            (total, value) => total + value,
            0
          ),
          incomingMessages:
            whatsappMessagesByDirection.inbound ??
            whatsappMessagesByDirection.incoming ??
            0,
          outgoingMessages:
            whatsappMessagesByDirection.outbound ??
            whatsappMessagesByDirection.outgoing ??
            0,
        },
      },
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