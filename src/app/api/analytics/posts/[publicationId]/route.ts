import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  bannerPublications,
  banners,
  facebookConnections,
  instagramConnections,
  products,
  socialAccounts,
} from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { decryptFacebookToken } from '@/lib/facebook-token';

export const dynamic = 'force-dynamic';

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';

type RouteContext = {
  params: Promise<{ publicationId: string }>;
};

type ProviderMetric = {
  name?: string;
  values?: Array<{ value?: number | string }>;
};

function providerError(data: any, fallback: string): string {
  return data?.error?.message || data?.message || fallback;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;

  try {
    const result: unknown = JSON.parse(String(value));
    return result && typeof result === 'object' ? result as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getMetricValues(metrics: ProviderMetric[]): Record<string, number> {
  return Object.fromEntries(
    metrics.map((metric) => [
      String(metric.name || ''),
      Number(metric.values?.[0]?.value) || 0,
    ])
  );
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerError(data, 'Social platform analytics request failed'));
  }
  return data;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const userId = getUserIdFromRequest(request);
    const { publicationId: rawId } = await context.params;
    const publicationId = Number(rawId);

    if (!Number.isSafeInteger(publicationId) || publicationId <= 0) {
      return NextResponse.json(
        { success: false, message: 'Invalid post ID' },
        { status: 400 }
      );
    }

    const [post] = await db
      .select({
        id: bannerPublications.id,
        platform: bannerPublications.platform,
        externalId: bannerPublications.externalId,
        permalink: bannerPublications.permalink,
        publishedAt: bannerPublications.publishedAt,
        caption: banners.caption,
        imageUrl: banners.imageUrl,
        productTitle: products.title,
      })
      .from(bannerPublications)
      .innerJoin(banners, eq(bannerPublications.bannerId, banners.id))
      .innerJoin(products, eq(banners.productId, products.id))
      .where(
        and(
          eq(bannerPublications.id, publicationId),
          eq(bannerPublications.userId, userId)
        )
      )
      .limit(1);

    if (!post) {
      return NextResponse.json(
        { success: false, message: 'Published post not found' },
        { status: 404 }
      );
    }

    const postId = String(post.externalId);
    let metrics: Record<string, number> | null = null;
    let note: string | undefined;

    if (post.platform === 'facebook') {
      const pageId = postId.split('_')[0];
      const [connection] = await db
        .select()
        .from(facebookConnections)
        .where(
          and(
            eq(facebookConnections.userId, userId),
            eq(facebookConnections.pageId, pageId),
            eq(facebookConnections.status, 'active')
          )
        )
        .limit(1);

      if (!connection) {
        note = 'Reconnect the Facebook Page used to publish this post to view its insights.';
      } else {
        const token = decryptFacebookToken(String(connection.accessToken));
        const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(postId)}/insights`);
        url.searchParams.set('metric', 'post_impressions,post_impressions_unique,post_clicks');
        url.searchParams.set('access_token', token);
        const data = await getJson(url.toString());
        const values = getMetricValues(data.data || []);
        metrics = {
          impressions: values.post_impressions || 0,
          reach: values.post_impressions_unique || 0,
          clicks: values.post_clicks || 0,
        };
      }
    } else if (post.platform === 'instagram') {
      const [connection] = await db
        .select()
        .from(instagramConnections)
        .where(
          and(
            eq(instagramConnections.userId, userId),
            eq(instagramConnections.status, 'active')
          )
        )
        .limit(1);

      if (!connection) {
        note = 'Reconnect the Instagram account used to publish this post to view its insights.';
      } else {
        const url = new URL(`https://graph.instagram.com/${META_GRAPH_VERSION}/${encodeURIComponent(postId)}/insights`);
        url.searchParams.set('metric', 'views,reach');
        url.searchParams.set('access_token', String(connection.accessToken));
        const data = await getJson(url.toString());
        const values = getMetricValues(data.data || []);
        metrics = {
          views: values.views || 0,
          reach: values.reach || 0,
        };
      }
    } else if (post.platform === 'linkedin') {
      const [connection] = await db
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.userId, userId),
            eq(socialAccounts.provider, 'linkedin')
          )
        )
        .limit(1);

      const metadata = parseMetadata(connection?.metadata);
      const ownerUrn = String(metadata.ownerUrn || '').trim();
      if (!connection?.accessToken || !ownerUrn.startsWith('urn:li:organization:')) {
        note = 'LinkedIn post analytics are available for company-page posts only.';
      } else {
        const postType = postId.startsWith('urn:li:ugcPost:') ? 'ugcPosts' : 'shares';
        const url =
          `https://api.linkedin.com/rest/organizationalEntityShareStatistics` +
          `?q=organizationalEntity&organizationalEntity=${encodeURIComponent(ownerUrn)}` +
          `&${postType}=List(${encodeURIComponent(postId)})`;
        const data = await getJson(url, {
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || '202606',
          },
        });
        const stats = data?.elements?.[0]?.totalShareStatistics || {};
        metrics = {
          impressions: Number(stats.impressionCount) || 0,
          clicks: Number(stats.clickCount) || 0,
          likes: Number(stats.likeCount) || 0,
          comments: Number(stats.commentCount) || 0,
          shares: Number(stats.shareCount) || 0,
        };
      }
    } else if (post.platform === 'youtube' || post.platform === 'youtube_analytics') {
      note = 'YouTube Analytics are currently disabled.';
    } else if (post.platform === 'google_business') {
      note = 'Google Business Profile provides location-level performance, not per-post insights.';
    } else if (post.platform === 'whatsapp') {
      note = 'WhatsApp reports conversations and messages, not analytics for an individual published post.';
    } else {
      note = 'Per-post analytics are not available for this platform.';
    }

    return NextResponse.json({
      success: true,
      post,
      metrics,
      note,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: 401 }
      );
    }

    console.error('[Analytics Post] Failed to load post insights:', error);
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to load post analytics',
      },
      { status: 502 }
    );
  }
}
