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
import { fetchFacebookPostMetrics } from '@/lib/facebook-insights';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const IG_GRAPH_API_BASE = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
const LINKEDIN_REST_BASE = 'https://api.linkedin.com/rest';
const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const GOOGLE_BUSINESS_PERFORMANCE_API_BASE =
  'https://businessprofileperformance.googleapis.com/v1';

const MEDIA_ORIGIN = process.env.NEXT_PUBLIC_MEDIA_URL || 'https://aarnexai.com';

function getErrorMessage(data: any, fallback: string): string {
  return data?.error?.message || data?.error_message || data?.message || fallback;
}

function toFullMediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${MEDIA_ORIGIN}${value.startsWith('/') ? '' : '/'}${value}`;
}

function getYouTubeAuthorizationError(status: number, data: any, fallback: string): string {
  const message = getErrorMessage(data, fallback);
  const reason = String(data?.error?.errors?.[0]?.reason || '');
  if (
    status === 401 ||
    status === 403 ||
    /unauthorized|invalid credentials/i.test(message) ||
    /insufficient.*scope|insufficientpermissions/i.test(reason)
  ) {
    return 'YouTube rejected the saved authorization or required scope. Reconnect YouTube and approve youtube.readonly and yt-analytics.readonly access.';
  }
  return message;
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
// extra fields a given provider needs beyond providerAccountId/accountName.
// Parse it defensively.
function parseAccountMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A banner can have several publications on the same platform
 * (e.g. 4 Facebook Pages). Numbers are summed; text notes keep the
 * first value seen.
 */
function mergePlatformMetrics(
  platforms: Record<string, any>,
  platform: string,
  metrics: Record<string, unknown>
) {
  const existing: Record<string, any> = platforms[platform] ?? {};

  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      existing[key] = (typeof existing[key] === 'number' ? existing[key] : 0) + value;
    } else if (value !== undefined && existing[key] === undefined) {
      existing[key] = value;
    }
  }

  platforms[platform] = existing;
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

async function fetchInstagramEngagement(mediaId: string, accessToken: string) {
  const url = new URL(`${IG_GRAPH_API_BASE}/${encodeURIComponent(mediaId)}`);
  url.searchParams.set('fields', 'like_count,comments_count');
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url.toString(), { cache: 'no-store' });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(getErrorMessage(data, 'Instagram engagement request failed'));
  }

  return {
    ...(Number.isFinite(Number(data?.like_count))
      ? { likes: Number(data.like_count) }
      : {}),
    ...(Number.isFinite(Number(data?.comments_count))
      ? { comments: Number(data.comments_count) }
      : {}),
  };
}

async function fetchGoogleAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('YouTube analytics is not configured: Google OAuth client credentials are missing.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    cache: 'no-store',
  });
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    const errorCode = typeof data?.error === 'string' ? data.error : '';
    const description =
      typeof data?.error_description === 'string' ? data.error_description : '';
    if (/unauthorized|invalid_grant/i.test(`${errorCode} ${description}`)) {
      throw new Error(
        'Google rejected the YouTube refresh authorization. Reconnect YouTube and approve youtube.readonly and yt-analytics.readonly access.'
      );
    }
    throw new Error(
      errorCode === 'invalid_grant'
        ? 'YouTube authorization expired or was revoked. Reconnect YouTube and grant video analytics access.'
        : description || getErrorMessage(data, 'YouTube access token refresh failed')
    );
  }

  return String(data.access_token);
}

async function fetchYouTubeVideos(accessToken: string, limit: number) {
  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelUrl.searchParams.set('part', 'contentDetails');
  channelUrl.searchParams.set('mine', 'true');

  const channelResponse = await fetch(channelUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const channelData = await channelResponse.json();
  if (!channelResponse.ok) {
    throw new Error(getYouTubeAuthorizationError(channelResponse.status, channelData, 'Could not load YouTube channel uploads'));
  }

  const uploadsPlaylistId = channelData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];

  const playlistUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  playlistUrl.searchParams.set('part', 'snippet,contentDetails');
  playlistUrl.searchParams.set('playlistId', String(uploadsPlaylistId));
  playlistUrl.searchParams.set('maxResults', String(limit));

  const playlistResponse = await fetch(playlistUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const playlistData = await playlistResponse.json();
  if (!playlistResponse.ok) {
    throw new Error(getYouTubeAuthorizationError(playlistResponse.status, playlistData, 'Could not load YouTube channel videos'));
  }

  const videos = (playlistData?.items || [])
    .map((item: any) => ({
      id: String(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId || ''),
      title: String(item?.snippet?.title || 'YouTube video'),
      description: String(item?.snippet?.description || ''),
      publishedAt: String(item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || ''),
      thumbnailUrl: String(
        item?.snippet?.thumbnails?.medium?.url ||
        item?.snippet?.thumbnails?.default?.url ||
        ''
      ),
    }))
    .filter((item: { id: string }) => item.id);

  if (!videos.length) return [];

  const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  videosUrl.searchParams.set('part', 'statistics');
  videosUrl.searchParams.set('id', videos.map((video: { id: string }) => video.id).join(','));

  const statsResponse = await fetch(videosUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const statsData = await statsResponse.json();
  if (!statsResponse.ok) {
    throw new Error(getYouTubeAuthorizationError(statsResponse.status, statsData, 'Could not load YouTube video statistics'));
  }

  const statsById = new Map<string, any>(
    (statsData?.items || []).map((item: any) => [String(item.id), item.statistics || {}])
  );

  return videos.map((video: {
    id: string;
    title: string;
    description: string;
    publishedAt: string;
    thumbnailUrl: string;
  }) => {
    const stats = statsById.get(video.id) || {};
    return {
      ...video,
      permalink: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
      metrics: {
        views: Number(stats.viewCount) || 0,
        likes: Number(stats.likeCount) || 0,
        comments: Number(stats.commentCount) || 0,
      },
    };
  });
}

/* =========================================================
   LINKEDIN — organization share statistics
========================================================= */
function isLinkedInAuthorMismatch(error: unknown): error is Error {
  return error instanceof Error && /Unable to get activityIds|did not post them/i.test(error.message);
}

async function fetchLinkedInShareStats(
  organizationUrn: string,
  shareUrn: string,
  accessToken: string
) {
  if (!/^urn:li:organization:[A-Za-z0-9_-]+$/.test(organizationUrn)) {
    throw new Error('LinkedIn post analytics require a valid company-page URN.');
  }

  if (!/^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/.test(shareUrn)) {
    throw new Error('The saved LinkedIn post ID is not a supported share URN.');
  }

  const listParam = shareUrn.startsWith('urn:li:ugcPost:') ? 'ugcPosts' : 'shares';
  const url =
    `${LINKEDIN_REST_BASE}/organizationalEntityShareStatistics` +
    `?q=organizationalEntity&organizationalEntity=${encodeURIComponent(organizationUrn)}` +
    `&${listParam}=List(${encodeURIComponent(shareUrn)})`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || '202606',
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
   GOOGLE BUSINESS — location-level stats
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
       of that platform. */

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

    const activeFbConnections = fbConnRows.filter(
      (row) =>
        row.status === 'active' &&
        Boolean(row.accessToken) &&
        (!row.tokenExpiresAt || new Date(row.tokenExpiresAt).getTime() > Date.now())
    );
    const fbConnection = activeFbConnections[0];
    let facebookTokenError: string | null = null;
    if (fbConnection?.accessToken) {
      try {
        const decrypted = decryptFacebookToken(fbConnection.accessToken);
        if (fbConnection.accessToken.split('.').length !== 3) {
          try {
            await db
              .update(facebookConnections)
              .set({ accessToken: encryptFacebookToken(decrypted) })
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
      (row) => row.provider === 'youtube'
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
        caption: b?.caption ?? null,
        imageUrl: toFullMediaUrl(b?.imageUrl ?? null),
        publishedAt: publicationRows
          .filter((row) => row.bannerId === id)
          .reduce<Date | null>(
            (latest, row) =>
              !latest || new Date(row.publishedAt).getTime() > latest.getTime()
                ? new Date(row.publishedAt)
                : latest,
            null
          ),
        publications: publicationRows
          .filter((row) => row.bannerId === id)
          .map((row) => ({
            id: row.id,
            platform: row.platform,
            externalId: row.externalId,
            permalink: row.permalink,
            publishedAt: row.publishedAt,
          })),
        platforms: {},
      };
    }

    /* Facebook summary counters (used for the account-level note) */
    const facebookStats = {
      notConnectedPages: new Set<string>(),
      unavailable: 0,
      failed: 0,
      firstIssue: null as string | null,
    };

    /* FACEBOOK + INSTAGRAM + LINKEDIN — per-publication metrics */

    for (const row of publicationRows) {
      const target = bannersOut[row.bannerId];
      if (!target) continue;
      const publicationMetrics: Record<string, unknown> = {};

      try {
        if (row.platform === 'facebook') {
          const pageId = String(row.externalId).split('_')[0];
          const postPageConnection = activeFbConnections.find(
            (connection) => String(connection.pageId) === pageId
          );

          if (!postPageConnection) {
            facebookStats.notConnectedPages.add(pageId);
            const notConnected = {
              error: `Facebook Page ${pageId} is not connected. Reconnect that Page to view its post analytics.`,
            };
            publicationMetrics.facebook = notConnected;
            mergePlatformMetrics(target.platforms, 'facebook', notConnected);
          } else {
            try {
              const pageToken = decryptFacebookToken(String(postPageConnection.accessToken || ''));
              const metrics = await fetchFacebookPostMetrics(row.externalId, pageToken);

              const hasNumbers = ['impressions', 'reach', 'clicks', 'likes', 'comments'].some(
                (key) => typeof (metrics as Record<string, unknown>)[key] === 'number'
              );

              if (metrics.unavailable) {
                facebookStats.unavailable += 1;
              } else if (!hasNumbers) {
                facebookStats.failed += 1;
                facebookStats.firstIssue ??=
                  metrics.insightsNote || metrics.engagementNote || null;
              }

              publicationMetrics.facebook = metrics;
              mergePlatformMetrics(target.platforms, 'facebook', metrics);
            } catch (error) {
              console.error(`[Analytics] Facebook insights failed for Page ${pageId}:`, error);
              const message =
                error instanceof Error ? error.message : 'Facebook Page token is unavailable.';
              facebookStats.failed += 1;
              facebookStats.firstIssue ??= message;
              publicationMetrics.facebook = { error: message };
              mergePlatformMetrics(target.platforms, 'facebook', { error: message });
            }
          }
        }

        if (row.platform === 'instagram' && igConnection) {
          const instagramMetrics: Record<string, number | string> = {};
          const instagramToken = String(igConnection.accessToken || '');
          try {
            Object.assign(
              instagramMetrics,
              await fetchInstagramMediaInsights(row.externalId, instagramToken)
            );
          } catch (error) {
            console.warn(`[Analytics] Instagram views unavailable for ${row.externalId}:`, error);
            instagramMetrics.insightsNote =
              error instanceof Error
                ? error.message
                : 'Instagram views/reach are unavailable for this post.';
          }

          let engagement: Record<string, number | string> = {};
          try {
            engagement = await fetchInstagramEngagement(
              row.externalId,
              instagramToken
            );
          } catch (error) {
            console.warn(`[Analytics] Instagram likes/comments unavailable for ${row.externalId}:`, error);
            const message =
              error instanceof Error
                ? error.message
                : 'Instagram likes/comments are unavailable for this post.';
            engagement.engagementNote = /instagram_business_manage_insights|permission/i.test(message)
              ? 'Reconnect Instagram and grant the instagram_business_manage_insights permission.'
              : message;
          }

          const combined = { ...instagramMetrics, ...engagement };
          publicationMetrics.instagram = combined;
          mergePlatformMetrics(target.platforms, 'instagram', combined);
        } else if (row.platform === 'instagram') {
          publicationMetrics.instagram = {
            note: 'Instagram account is not connected. Reconnect Instagram to view post analytics.',
          };
        }

        if (row.platform === 'linkedin' && liConnection) {
          const organizations = Array.isArray(liMetadata.organizations)
            ? liMetadata.organizations
            : [];
          const publicationOwners =
            liMetadata.publicationOwners &&
            typeof liMetadata.publicationOwners === 'object'
              ? liMetadata.publicationOwners as Record<string, unknown>
              : {};
          const savedOwnerUrn = String(publicationOwners[row.externalId] || '').trim();
          const organizationOwners = organizations.map(
            (organization: Record<string, unknown>) => String(organization.urn || '')
          );
          const candidateOwners = [
            ...(savedOwnerUrn.startsWith('urn:li:organization:') ? [savedOwnerUrn] : []),
            ...organizationOwners,
          ].filter(
            (ownerUrn, index, owners) =>
              /^urn:li:organization:[A-Za-z0-9_-]+$/.test(ownerUrn) &&
              owners.indexOf(ownerUrn) === index
          );

          if (savedOwnerUrn.startsWith('urn:li:person:')) {
            const note = {
              note: 'LinkedIn does not provide these company-page metrics for a personal-profile post.',
            };
            publicationMetrics.linkedin = note;
            mergePlatformMetrics(target.platforms, 'linkedin', note);
          } else if (!candidateOwners.length) {
            const note = {
              note: 'LinkedIn post analytics are available for company-page posts. Select/connect a company page to view these metrics.',
            };
            publicationMetrics.linkedin = note;
            mergePlatformMetrics(target.platforms, 'linkedin', note);
          } else {
            let lastAuthorMismatch: Error | null = null;
            for (const ownerUrn of candidateOwners) {
              try {
                const stats = await fetchLinkedInShareStats(
                  ownerUrn,
                  row.externalId,
                  String(liConnection.accessToken || '')
                );
                publicationMetrics.linkedin = stats;
                mergePlatformMetrics(target.platforms, 'linkedin', stats);
                break;
              } catch (error) {
                if (!isLinkedInAuthorMismatch(error) || savedOwnerUrn) throw error;
                lastAuthorMismatch = error;
              }
            }

            if (!publicationMetrics.linkedin && lastAuthorMismatch) {
              throw new Error(
                'LinkedIn could not match this older post to a connected profile or company page. New posts will store their publishing target; republish this post to track its metrics.'
              );
            }
          }
        } else if (row.platform === 'linkedin') {
          publicationMetrics.linkedin = {
            note: 'LinkedIn account is not connected. Reconnect LinkedIn to view post analytics.',
          };
        }

        if (row.platform === 'google_business') {
          // Business Profile Performance API only exposes location-level
          // metrics, not a breakdown per individual local post.
          const note = {
            note: 'Google Business only reports location-level performance, not per-post metrics.',
          };
          publicationMetrics.google_business = note;
          mergePlatformMetrics(target.platforms, 'google_business', note);
        }
      } catch (error: any) {
        console.error(`[Analytics] ${row.platform} insights failed for banner ${row.bannerId}:`, error);
        const failure = {
          error: error?.message || `${row.platform} insights request failed`,
        };
        publicationMetrics[row.platform] = failure;
        mergePlatformMetrics(target.platforms, row.platform, failure);
      }

      const publication = target.publications.find(
        (item: { id: number }) => item.id === row.id
      );
      if (publication) {
        publication.metrics = publicationMetrics[row.platform] || {};
      }
    }

    /* If a platform entry has real numbers, drop the leftover
       error / unavailable flags that came from other publications. */
    for (const banner of Object.values(bannersOut)) {
      for (const key of Object.keys(banner.platforms)) {
        const entry = banner.platforms[key];
        if (
          entry &&
          typeof entry === 'object' &&
          Object.values(entry).some((value) => typeof value === 'number')
        ) {
          delete entry.error;
          delete entry.unavailable;
        }
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

    const buildFacebookNote = (): string | undefined => {
      if (!fbConnection) return undefined;
      if (facebookTokenError) return facebookTokenError;
      if (publicationCount('facebook') === 0) {
        return 'Publish a Facebook post from AarnexAi to start tracking post insights.';
      }

      const parts: string[] = [];

      if (facebookStats.notConnectedPages.size > 0) {
        parts.push(
          `Reconnect Facebook and select these Pages to see their analytics: ${Array.from(
            facebookStats.notConnectedPages
          ).join(', ')}.`
        );
      }
      if (facebookStats.unavailable > 0) {
        parts.push(
          `${facebookStats.unavailable} older post(s) are no longer available on Facebook.`
        );
      }
      if (facebookStats.failed > 0 && facebookStats.firstIssue) {
        parts.push(facebookStats.firstIssue);
      }

      return parts.length ? parts.join(' ') : undefined;
    };

    const whatsappMessagesByDirection = Object.fromEntries(
      waMessageRows.map((row) => [String(row.direction).toLowerCase(), Number(row.total) || 0])
    );
    const whatsappConversation = waConversationSummary[0];
    let youtubeVideos: Awaited<ReturnType<typeof fetchYouTubeVideos>> = [];
    let youtubeVideosNote: string | undefined;
    if (ytConnection?.accessToken || ytConnection?.refreshToken) {
      try {
        let accessToken = String(ytConnection.accessToken || '');
        if (ytConnection.refreshToken) {
          accessToken = await fetchGoogleAccessToken(String(ytConnection.refreshToken));
        } else if (
          !accessToken ||
          (ytConnection.expiresAt && new Date(ytConnection.expiresAt).getTime() <= Date.now())
        ) {
          throw new Error('Reconnect YouTube to grant video analytics access.');
        }
        youtubeVideos = await fetchYouTubeVideos(accessToken, 30);
      } catch (error) {
        youtubeVideosNote =
          error instanceof Error ? error.message : 'Unable to load YouTube video insights.';
        console.error('[Analytics] YouTube video insights failed:', {
          message: youtubeVideosNote,
          providerAccountId: ytConnection.providerAccountId,
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: publicationRows.length === 0
        ? 'No published banners found for this user yet'
        : undefined,
      banners: bannerResults,
      youtubeVideos,
      youtubeVideosNote,
      platforms: {
        facebook: {
          connected: Boolean(fbConnection),
          accountName: fbConnection?.pageName || null,
          posts: publicationCount('facebook'),
          impressions: sumMetric('facebook', 'impressions'),
          reach: sumMetric('facebook', 'reach'),
          clicks: sumMetric('facebook', 'clicks'),
          likes: sumMetric('facebook', 'likes'),
          comments: sumMetric('facebook', 'comments'),
          note: buildFacebookNote(),
        },
        instagram: {
          connected: Boolean(igConnection),
          accountName: igConnection?.instagramUsername || igConnection?.instagramName || null,
          posts: publicationCount('instagram'),
          impressions: sumMetric('instagram', 'impressions'),
          views: sumMetric('instagram', 'views'),
          reach: sumMetric('instagram', 'reach'),
          profileVisits: sumMetric('instagram', 'profileVisits'),
          likes: sumMetric('instagram', 'likes'),
          comments: sumMetric('instagram', 'comments'),
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