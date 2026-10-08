// src/app/api/analytics/summary/route.ts
//
// GET /api/analytics/summary
// Account-wide analytics in the shape Analytics.tsx expects:
// { success: true, platforms: { facebook: { connected, accountName, posts, ... }, ... } }

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import {
  bannerPublications,
  facebookConnections,
  instagramConnections,
  socialAccounts,
  whatsappConnections,
  whatsappConversations,
  whatsappMessages,
} from '@/db/schema';

import { eq, count, sum } from 'drizzle-orm';

import { getUserIdFromRequest, AuthError } from '@/lib/auth';
import { decryptFacebookToken } from '@/lib/facebook-token';
import {
  fetchFacebookPostMetrics,
  type FacebookPostMetrics,
} from '@/lib/facebook-insights';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const IG_GRAPH_API_BASE = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
const LINKEDIN_REST_BASE = 'https://api.linkedin.com/rest';
const YOUTUBE_ANALYTICS_API_BASE = 'https://youtubeanalytics.googleapis.com/v2';

// Max posts per platform we ask the insights API about (keeps response fast)
const MAX_POSTS_PER_PLATFORM = 20;

type PlatformKey =
  | 'facebook'
  | 'instagram'
  | 'google_business'
  | 'youtube'
  | 'linkedin'
  | 'whatsapp';

type PlatformAnalytics = {
  connected: boolean;
  accountName?: string | null;
  posts?: number | null;
  impressions?: number | null;
  reach?: number | null;
  clicks?: number | null;
  directions?: number | null;
  profileVisits?: number | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  conversations?: number | null;
  messages?: number | null;
  incomingMessages?: number | null;
  outgoingMessages?: number | null;
  unread?: number | null;
  note?: string;
  periodDays?: number;
};

/* =========================================================
   Helpers
========================================================= */

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

function parseMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Sums one key across settled results. Returns null if none succeeded.
function sumField(
  results: PromiseSettledResult<Record<string, number>>[],
  key: string
): number | null {
  let total = 0;
  let any = false;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      any = true;
      total += Number(r.value[key]) || 0;
    }
  }
  return any ? total : null;
}

function firstFailure(results: PromiseSettledResult<unknown>[]): string | null {
  for (const r of results) {
    if (r.status === 'rejected') {
      return r.reason?.message || String(r.reason);
    }
  }
  return null;
}

/* =========================================================
   Platform fetchers
========================================================= */

async function fetchInstagramMediaInsights(mediaId: string, accessToken: string) {
  const url =
    `${IG_GRAPH_API_BASE}/${mediaId}/insights` +
    `?metric=views,reach` +
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
    impressions: byName.views || 0,
    reach: byName.reach || 0,
  };
}

async function fetchLinkedInShareStats(
  organizationUrn: string,
  shareUrn: string,
  accessToken: string
) {
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
  };
}

function isLinkedInAuthorMismatch(error: unknown): error is Error {
  return error instanceof Error && /Unable to get activityIds|did not post them/i.test(error.message);
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('YouTube analytics is not configured: Google OAuth client credentials are missing.');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    const errorCode = typeof data?.error === 'string' ? data.error : '';
    const description =
      typeof data?.error_description === 'string' ? data.error_description : '';
    if (/unauthorized|invalid_grant/i.test(`${errorCode} ${description}`)) {
      throw new Error(
        'Google rejected the YouTube refresh authorization. Reconnect YouTube and approve yt-analytics.readonly access.'
      );
    }
    throw new Error(
      errorCode === 'invalid_grant'
        ? 'YouTube authorization expired or was revoked. Reconnect YouTube and grant analytics access.'
        : description || getErrorMessage(data, 'Google token refresh failed')
    );
  }
  return data.access_token as string;
}

async function fetchYoutubeChannelStats(accessToken: string) {
  const { startDate, endDate } = dateRange(30);

  const url =
    `${YOUTUBE_ANALYTICS_API_BASE}/reports` +
    `?ids=${encodeURIComponent('channel==MINE')}` +
    `&startDate=${startDate}&endDate=${endDate}` +
    `&metrics=views,likes,comments`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });

  const data = await response.json();

  if (!response.ok) {
    const message = getErrorMessage(data, 'YouTube Analytics request failed');
    const reason = String(data?.error?.errors?.[0]?.reason || '');
    const authorizationRejected =
      response.status === 401 ||
      response.status === 403 ||
      /unauthorized|invalid credentials/i.test(message) ||
      /insufficient.*scope|insufficientpermissions/i.test(reason);
    throw new Error(
      authorizationRejected
        ? 'YouTube Analytics rejected the saved authorization or required scope. Reconnect YouTube and approve yt-analytics.readonly access.'
        : message
    );
  }

  const row: number[] = data?.rows?.[0] || [0, 0, 0];

  return {
    views: row[0] || 0,
    likes: row[1] || 0,
    comments: row[2] || 0,
  };
}

/* =========================================================
   GET /api/analytics/summary
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

    const [
      fbConnRows,
      igConnRows,
      socialRows,
      publicationRows,
      waConnRows,
      waConversationSummary,
      waMessageRows,
    ] = await Promise.all([
      db.select().from(facebookConnections).where(eq(facebookConnections.userId, userId)),
      db.select().from(instagramConnections).where(eq(instagramConnections.userId, userId)),
      db.select().from(socialAccounts).where(eq(socialAccounts.userId, userId)),
      db.select().from(bannerPublications).where(eq(bannerPublications.userId, userId)),
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

    const pubsBy = (platform: string) =>
      publicationRows
        .filter((p) => p.platform === platform)
        .sort((a, b) => Number(b.id) - Number(a.id));

    const platforms: Partial<Record<PlatformKey, PlatformAnalytics>> = {};

    /* ---------------- FACEBOOK ---------------- */
    {
      const pubs = pubsBy('facebook');
      const activeFb = fbConnRows.filter(
        (c) =>
          c.status === 'active' &&
          Boolean(c.accessToken) &&
          (!c.tokenExpiresAt || new Date(c.tokenExpiresAt).getTime() > Date.now())
      );
      const conn = activeFb[0] as any;

      const out: PlatformAnalytics = {
        connected: activeFb.length > 0,
        accountName: conn ? conn.pageName || conn.pageId || null : null,
        posts: pubs.length,
        impressions: null,
        reach: null,
        clicks: null,
        likes: null,
        comments: null,
      };

      if (out.connected && pubs.length > 0) {
        const notConnectedPages = new Set<string>();
        let unavailable = 0;
        let failed = 0;
        let firstIssue: string | null = null;

        const jobs = pubs.slice(0, MAX_POSTS_PER_PLATFORM).map(
          async (pub): Promise<FacebookPostMetrics | null> => {
            const pageId = String(pub.externalId).split('_')[0];
            const match = activeFb.find((c) => String(c.pageId) === pageId);

            if (!match) {
              notConnectedPages.add(pageId);
              return null;
            }

            try {
              const token = decryptFacebookToken(String(match.accessToken || ''));
              const metrics = await fetchFacebookPostMetrics(String(pub.externalId), token);

              if (metrics.unavailable) {
                unavailable += 1;
                return null;
              }

              const hasNumbers = ['impressions', 'reach', 'clicks', 'likes', 'comments'].some(
                (key) => typeof (metrics as Record<string, unknown>)[key] === 'number'
              );
              if (!hasNumbers) {
                failed += 1;
                firstIssue ??= metrics.insightsNote || metrics.engagementNote || null;
                return null;
              }

              return metrics;
            } catch (error) {
              failed += 1;
              firstIssue ??= error instanceof Error ? error.message : 'Facebook token unavailable';
              return null;
            }
          }
        );

        const results = (await Promise.all(jobs)).filter(
          (m): m is FacebookPostMetrics => m !== null
        );

        const total = (
          key: 'impressions' | 'reach' | 'clicks' | 'likes' | 'comments'
        ): number | null => {
          let any = false;
          let sumValue = 0;
          for (const m of results) {
            const v = m[key];
            if (typeof v === 'number') {
              any = true;
              sumValue += v;
            }
          }
          return any ? sumValue : null;
        };

        out.impressions = total('impressions');
        out.reach = total('reach');
        out.clicks = total('clicks');
        out.likes = total('likes');
        out.comments = total('comments');

        const parts: string[] = [];
        if (notConnectedPages.size > 0) {
          parts.push(
            `Reconnect Facebook and select these Pages to see their analytics: ${Array.from(
              notConnectedPages
            ).join(', ')}.`
          );
        }
        if (unavailable > 0) {
          parts.push(`${unavailable} older post(s) are no longer available on Facebook.`);
        }
        if (failed > 0 && firstIssue) {
          parts.push(firstIssue);
        }
        if (parts.length) out.note = parts.join(' ');
      }

      platforms.facebook = out;
    }

    /* ---------------- INSTAGRAM ---------------- */
    {
      const pubs = pubsBy('instagram');
      const conn = igConnRows.find(
        (row) =>
          row.status === 'active' &&
          (!row.tokenExpiresAt || new Date(row.tokenExpiresAt).getTime() > Date.now())
      ) as any;

      const out: PlatformAnalytics = {
        connected: Boolean(conn),
        accountName: conn
          ? conn.instagramUsername || conn.username || conn.accountName || null
          : null,
        posts: pubs.length,
        impressions: null,
        reach: null,
        profileVisits: null,
      };

      if (out.connected && pubs.length > 0 && conn?.accessToken) {
        const jobs = pubs
          .slice(0, MAX_POSTS_PER_PLATFORM)
          .map((pub) =>
            fetchInstagramMediaInsights(String(pub.externalId), String(conn.accessToken))
          );

        const results = await Promise.allSettled(jobs);
        out.impressions = sumField(results, 'impressions');
        out.reach = sumField(results, 'reach');

        const failure = firstFailure(results);
        if (failure) {
          console.warn('[AnalyticsSummary] instagram:', failure);
          if (out.impressions === null) {
            out.note = 'Instagram insights are unavailable for your published posts right now.';
          }
        }
      }

      platforms.instagram = out;
    }

    /* ---------------- LINKEDIN ---------------- */
    {
      const pubs = pubsBy('linkedin');
      const conn = socialRows.find((r) => r.provider === 'linkedin') as any;
      const out: PlatformAnalytics = {
        connected: Boolean(conn),
        accountName: conn?.accountName || null,
        posts: pubs.length,
        impressions: null,
        clicks: null,
        likes: null,
      };

      if (conn && pubs.length > 0) {
        const metadata = parseMetadata(conn.metadata);
        const publicationOwners =
          metadata.publicationOwners && typeof metadata.publicationOwners === 'object'
            ? metadata.publicationOwners
            : {};
        const organizationOwners = [
          String(metadata.selectedOrgUrn || ''),
          ...(Array.isArray(metadata.organizations)
            ? metadata.organizations.map((organization: any) => String(organization?.urn || ''))
            : []),
        ].filter(
          (ownerUrn, index, owners) =>
            /^urn:li:organization:[A-Za-z0-9_-]+$/.test(ownerUrn) &&
            owners.indexOf(ownerUrn) === index
        );

        if (!organizationOwners.length && !Object.values(publicationOwners).some(
          (ownerUrn) => typeof ownerUrn === 'string' && ownerUrn.startsWith('urn:li:organization:')
        )) {
          out.note =
            'LinkedIn only reports post analytics for company pages. Connect a company page to see impressions and clicks.';
        } else if (conn.accessToken) {
          const jobs = pubs
            .slice(0, MAX_POSTS_PER_PLATFORM)
            .map(async (pub) => {
              const postId = String(pub.externalId);
              const savedOwnerUrn = String((publicationOwners as Record<string, unknown>)[postId] || '');
              const candidates = [
                ...(savedOwnerUrn.startsWith('urn:li:organization:') ? [savedOwnerUrn] : []),
                ...organizationOwners,
              ].filter((ownerUrn, index, owners) => owners.indexOf(ownerUrn) === index);
              let lastMismatch: Error | null = null;

              for (const ownerUrn of candidates) {
                try {
                  return await fetchLinkedInShareStats(
                    ownerUrn,
                    postId,
                    String(conn.accessToken)
                  );
                } catch (error) {
                  if (!isLinkedInAuthorMismatch(error) || savedOwnerUrn) throw error;
                  lastMismatch = error;
                }
              }

              if (lastMismatch) {
                throw new Error(
                  'LinkedIn could not match this older post to a connected company page. Republish it to track its metrics.'
                );
              }

              throw new Error('No connected LinkedIn company page is available for this post.');
            });

          const results = await Promise.allSettled(jobs);
          out.impressions = sumField(results, 'impressions');
          out.clicks = sumField(results, 'clicks');
          out.likes = sumField(results, 'likes');

          const failure = firstFailure(results);
          if (failure) console.warn('[AnalyticsSummary] linkedin:', failure);
        }
      }

      platforms.linkedin = out;
    }

    /* ---------------- YOUTUBE ---------------- */
    {
      const pubs = pubsBy('youtube');
      const conn = socialRows.find((r) => r.provider === 'youtube') as any;
      const out: PlatformAnalytics = {
        connected: Boolean(conn),
        accountName: conn?.accountName || null,
        posts: pubs.length,
        views: null,
        likes: null,
        comments: null,
        periodDays: 30,
      };

      if (conn?.refreshToken || conn?.accessToken) {
        try {
          let token = String(conn.accessToken || '');
          if (conn.refreshToken) {
            token = await refreshGoogleAccessToken(String(conn.refreshToken));
          }
          const stats = await fetchYoutubeChannelStats(token);
          out.views = stats.views;
          out.likes = stats.likes;
          out.comments = stats.comments;
        } catch (error: any) {
          console.warn('[AnalyticsSummary] youtube:', error?.message || error);
          out.note = error instanceof Error
            ? error.message
            : 'YouTube insights are unavailable. Try reconnecting YouTube.';
        }
      }

      platforms.youtube = out;
    }

    /* ---------------- GOOGLE BUSINESS ---------------- */
    {
      const pubs = pubsBy('google_business');
      const conn = socialRows.find((r) => r.provider === 'google_business') as any;
      platforms.google_business = {
        connected: Boolean(conn),
        accountName: conn?.accountName || null,
        posts: pubs.length,
        views: null,
        clicks: null,
        directions: null,
        note: conn
          ? 'Google Business reports location-level performance only, not per post.'
          : undefined,
      };
    }

    /* ---------------- WHATSAPP ---------------- */
    {
      const waConnection = waConnRows.find(
        (row) =>
          row.status === 'active' &&
          (!row.tokenExpiresAt || new Date(row.tokenExpiresAt).getTime() > Date.now())
      );
      const byDirection = Object.fromEntries(
        waMessageRows.map((row) => [String(row.direction).toLowerCase(), Number(row.total) || 0])
      );
      const conversation = waConversationSummary[0];

      platforms.whatsapp = {
        connected: Boolean(waConnection),
        accountName: waConnection?.businessName || waConnection?.businessPhoneNumber || null,
        conversations: Number(conversation?.conversations) || 0,
        messages: Object.values(byDirection).reduce((total, value) => total + value, 0),
        unread: Number(conversation?.unread) || 0,
        incomingMessages: byDirection.inbound ?? byDirection.incoming ?? 0,
        outgoingMessages: byDirection.outbound ?? byDirection.outgoing ?? 0,
      };
    }

    return NextResponse.json({ success: true, platforms });
  } catch (error: any) {
    console.error('[AnalyticsSummary] Unexpected error:', error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || 'Failed to load analytics',
      },
      { status: 500 }
    );
  }
}