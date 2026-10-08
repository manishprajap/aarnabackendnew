// src/lib/facebook-insights.ts
//
// Shared Facebook Page-post metrics helper used by
//   - src/app/api/banners/analytics/route.ts
//   - src/app/api/analytics/summary/route.ts
//
// Meta removed post_impressions / post_impressions_unique on 15 Nov 2025.
// Replacements:
//   post_impressions        -> post_media_view
//   post_impressions_unique -> post_total_media_view_unique
//
// Each metric is requested on its own so one invalid/unsupported metric
// can never wipe out the others. This helper never throws.

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const FB_GRAPH_API_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export type FacebookPostMetrics = {
  impressions?: number;
  reach?: number;
  clicks?: number;
  likes?: number;
  comments?: number;
  insightsNote?: string;
  engagementNote?: string;
  /** true when the post no longer exists / cannot be read with this token */
  unavailable?: boolean;
};

export const FACEBOOK_POST_UNAVAILABLE_NOTE =
  'This post is no longer available on Facebook (it may have been deleted or published from a different connection).';

const INSIGHT_METRICS = [
  { key: 'impressions', metric: 'post_media_view' },
  { key: 'reach', metric: 'post_total_media_view_unique' },
  { key: 'clicks', metric: 'post_clicks' },
] as const;

export class FacebookGraphError extends Error {
  code?: number;
  subcode?: number;

  constructor(message: string, code?: number, subcode?: number) {
    super(message);
    this.name = 'FacebookGraphError';
    this.code = code;
    this.subcode = subcode;
  }
}

async function graphGet(url: string): Promise<any> {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.error) {
    const err = data?.error || {};
    throw new FacebookGraphError(
      err.message || 'Facebook request failed',
      typeof err.code === 'number' ? err.code : undefined,
      typeof err.error_subcode === 'number' ? err.error_subcode : undefined
    );
  }

  return data;
}

// "Unsupported get request. Object with ID ... does not exist" = code 100 / subcode 33.
// Happens for deleted posts or posts this token cannot read.
export function isPostUnavailableError(error: unknown): boolean {
  if (!(error instanceof FacebookGraphError)) return false;
  return (
    (error.code === 100 && error.subcode === 33) ||
    /unsupported get request/i.test(error.message)
  );
}

async function fetchInsightMetric(
  postId: string,
  metric: string,
  accessToken: string
): Promise<number> {
  const url = new URL(`${FB_GRAPH_API_BASE}/${encodeURIComponent(postId)}/insights`);
  url.searchParams.set('metric', metric);
  url.searchParams.set('access_token', accessToken);

  const data = await graphGet(url.toString());
  const value = Number(data?.data?.[0]?.values?.[0]?.value);
  return Number.isFinite(value) ? value : 0;
}

export async function fetchFacebookPostMetrics(
  postId: string,
  accessToken: string,
  options: { includeEngagement?: boolean } = {}
): Promise<FacebookPostMetrics> {
  const includeEngagement = options.includeEngagement !== false;
  const result: FacebookPostMetrics = {};

  /* ---------- Insights (views / reach / clicks) ---------- */
  const insightResults = await Promise.allSettled(
    INSIGHT_METRICS.map((item) => fetchInsightMetric(postId, item.metric, accessToken))
  );

  let firstInsightError: unknown = null;
  let postUnavailable = false;

  for (let i = 0; i < insightResults.length; i += 1) {
    const settled = insightResults[i];

    if (settled.status === 'fulfilled') {
      result[INSIGHT_METRICS[i].key] = settled.value;
    } else {
      if (firstInsightError === null) firstInsightError = settled.reason;
      if (isPostUnavailableError(settled.reason)) postUnavailable = true;
    }
  }

  if (postUnavailable) {
    console.warn(`[Analytics] Facebook post unavailable: ${postId}`);
    return {
      unavailable: true,
      insightsNote: FACEBOOK_POST_UNAVAILABLE_NOTE,
    };
  }

  const gotAnyInsight = INSIGHT_METRICS.some(
    (item) => typeof result[item.key] === 'number'
  );

  if (!gotAnyInsight && firstInsightError !== null) {
    const message =
      firstInsightError instanceof Error
        ? firstInsightError.message
        : 'Facebook reach/impressions are unavailable for this post.';
    console.warn(`[Analytics] Facebook insights unavailable for ${postId}: ${message}`);
    result.insightsNote = message;
  }

  /* ---------- Engagement (likes / comments) ---------- */
  if (includeEngagement) {
    try {
      const postUrl = new URL(`${FB_GRAPH_API_BASE}/${encodeURIComponent(postId)}`);
      postUrl.searchParams.set(
        'fields',
        'likes.limit(0).summary(true),comments.limit(0).summary(true)'
      );
      postUrl.searchParams.set('access_token', accessToken);

      const postData = await graphGet(postUrl.toString());

      const likeCount = Number(postData?.likes?.summary?.total_count);
      const commentCount = Number(postData?.comments?.summary?.total_count);

      if (Number.isFinite(likeCount)) result.likes = likeCount;
      if (Number.isFinite(commentCount)) result.comments = commentCount;
    } catch (error) {
      if (isPostUnavailableError(error)) {
        return {
          unavailable: true,
          insightsNote: FACEBOOK_POST_UNAVAILABLE_NOTE,
        };
      }

      const message =
        error instanceof Error
          ? error.message
          : 'Facebook likes/comments are unavailable for this post.';

      console.warn(`[Analytics] Facebook likes/comments unavailable for ${postId}: ${message}`);

      result.engagementNote = /#10|#200|pages_read_engagement|permission/i.test(message)
        ? 'Facebook needs the pages_read_engagement permission for likes and comments. Reconnect Facebook and approve it.'
        : message;
    }
  }

  return result;
}