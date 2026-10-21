
import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaTemplate = {
  id?: string;
  name?: string;
  status?: string;
  category?: string;
  language?: string;
  components?: unknown[];
};

type MetaResponse = {
  data?: MetaTemplate[];
  paging?: {
    next?: string;
    cursors?: {
      before?: string;
      after?: string;
    };
  };
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

export async function GET(request: NextRequest) {
  try {
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      );
    }

    const [connection] = await db
      .select({
        wabaId: whatsappConnections.wabaId,
        accessToken: whatsappConnections.accessToken,
        status: whatsappConnections.status,
      })
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .orderBy(desc(whatsappConnections.id))
      .limit(1);

    if (!connection) {
      return NextResponse.json(
        { success: false, error: 'WhatsApp account is not connected' },
        { status: 404 }
      );
    }

    if (!connection.wabaId || !connection.accessToken) {
      return NextResponse.json(
        {
          success: false,
          error: 'WABA ID or access token is missing',
        },
        { status: 400 }
      );
    }

    // Do not silently use a different business account.
    const wabaId = String(connection.wabaId).trim();

    if (!/^\d+$/.test(wabaId)) {
      return NextResponse.json(
        { success: false, error: 'Invalid WhatsApp Business Account ID' },
        { status: 400 }
      );
    }

    const token = String(connection.accessToken).trim();
    const templates: MetaTemplate[] = [];
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();

    let nextUrl: string | null =
      `${GRAPH_BASE}/${encodeURIComponent(wabaId)}/message_templates` +
      '?fields=id,name,status,category,language,components&limit=100';

    let pageCount = 0;
let lastPaging: NonNullable<MetaResponse['paging']> | null = null;
    // Guard against unexpected pagination loops.
    const MAX_PAGES = 20;

    while (nextUrl && pageCount < MAX_PAGES) {
      const currentUrl = new URL(nextUrl);

      // Only follow pagination links from the expected Graph API host.
      if (
        currentUrl.protocol !== 'https:' ||
        currentUrl.hostname !== 'graph.facebook.com' ||
        !currentUrl.pathname.startsWith(`/${GRAPH_VERSION}/`)
      ) {
        console.error('[WA templates] Rejected unexpected pagination URL');

        return NextResponse.json(
          { success: false, error: 'Invalid Meta pagination URL' },
          { status: 502 }
        );
      }

      if (seenUrls.has(currentUrl.toString())) {
        console.error('[WA templates] Pagination loop detected');

        return NextResponse.json(
          { success: false, error: 'Meta pagination loop detected' },
          { status: 502 }
        );
      }

      seenUrls.add(currentUrl.toString());
      pageCount++;

      const response = await fetch(currentUrl.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });

      const raw = await response.text();
      let result: MetaResponse;

      try {
        result = JSON.parse(raw) as MetaResponse;
      } catch {
        console.error('[WA templates] Meta returned invalid JSON', {
          status: response.status,
          page: pageCount,
        });

        return NextResponse.json(
          {
            success: false,
            error: 'Meta returned an invalid response',
          },
          { status: 502 }
        );
      }

      if (!response.ok || result.error) {
        const metaError = result.error;

        // Never log access tokens or the complete request URL.
        console.error('[WA templates] Meta API error', {
          wabaId,
          status: response.status,
          code: metaError?.code ?? null,
          subcode: metaError?.error_subcode ?? null,
          message: metaError?.message ?? null,
          type: metaError?.type ?? null,
          fbtraceId: metaError?.fbtrace_id ?? null,
        });

        const status =
          response.status === 401 || response.status === 403
            ? 502
            : response.status >= 500
              ? 502
              : 400;

        return NextResponse.json(
          {
            success: false,
            error: metaError?.message || 'Unable to fetch WhatsApp templates',
            metaErrorCode: metaError?.code ?? null,
            metaErrorSubcode: metaError?.error_subcode ?? null,
            fbtraceId: metaError?.fbtrace_id ?? null,
          },
          { status }
        );
      }

      if (!Array.isArray(result.data)) {
        console.error('[WA templates] Unexpected Meta response shape', {
          wabaId,
          page: pageCount,
          responseKeys: Object.keys(result),
        });

        return NextResponse.json(
          {
            success: false,
            error: 'Meta response did not contain a templates data array',
          },
          { status: 502 }
        );
      }

      for (const item of result.data) {
        const uniqueId = item.id || [
          item.name,
          item.language,
          item.category,
        ].join(':');

        if (!seenIds.has(uniqueId)) {
          seenIds.add(uniqueId);
          templates.push(item);
        }
      }

      lastPaging = result.paging ?? null;
      nextUrl = result.paging?.next ?? null;
    }

    console.log('[WA templates diagnostic]', {
      wabaId,
      httpStatus: 200,
      pagesFetched: pageCount,
      count: templates.length,
      templates: templates.map((item) => ({
        id: item.id ?? null,
        name: item.name ?? null,
        status: item.status ?? null,
        category: item.category ?? null,
        language: item.language ?? null,
      })),
      hasMorePages: Boolean(nextUrl),
    });

    return NextResponse.json(
      {
        success: true,
        templates: templates.map((item) => ({
          id: item.id ?? item.name ?? '',
          name: item.name ?? '',
          status: item.status ?? '',
          category: item.category ?? '',
          language: item.language ?? '',
          components: item.components ?? [],
        })),
        paging: lastPaging,
        hasMorePages: Boolean(nextUrl),
        pagesFetched: pageCount,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        },
      }
    );
  } catch (error) {
    console.error('[WA templates] GET failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'Meta API request timed out'
            : 'Failed to load WhatsApp templates',
      },
      { status: 500 }
    );
  }
}
