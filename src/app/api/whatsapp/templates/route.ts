
import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_PAGES = 20;

type MetaComponent = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

type MetaTemplate = {
  id?: string;
  name?: string;
  status?: string;
  category?: string;
  language?: string;
  components?: MetaComponent[];
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

function jsonError(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json(
    { success: false, error, ...extra },
    {
      status,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      },
    },
  );
}

function getBodyText(components: MetaComponent[] = []): string {
  return components
    .filter((component) => component.type === 'BODY')
    .map((component) => component.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function getParameterCount(bodyText: string): number {
  const placeholders = Array.from(
    bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g),
    (match) => Number(match[1]),
  );
  return placeholders.length ? Math.max(...placeholders) : 0;
}

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate the user.
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return jsonError('Authentication required', 401);
    }

    // 2. Fetch the latest WhatsApp connection for this user.
    const [connection] = await db
      .select({
        id: whatsappConnections.id,
        userId: whatsappConnections.userId,
        wabaId: whatsappConnections.wabaId,
        accessToken: whatsappConnections.accessToken,
        status: whatsappConnections.status,
      })
      .from(whatsappConnections)
      .where(eq(whatsappConnections.userId, userId))
      .orderBy(desc(whatsappConnections.id))
      .limit(1);

    if (!connection) {
      return jsonError('WhatsApp account is not connected', 404);
    }

    // Never log access tokens.
    console.log('[WA templates] Connection selected', {
      authenticatedUserId: userId,
      connectionId: connection.id,
      connectionUserId: connection.userId,
      wabaId: connection.wabaId,
      status: connection.status,
    });

    // 3. Validate the connection.
    if (connection.status !== 'active') {
      return jsonError(
        `WhatsApp connection is ${connection.status}`,
        409,
      );
    }

    if (!connection.wabaId || !connection.accessToken) {
      return jsonError(
        'WABA ID or access token is missing',
        400,
      );
    }

    const wabaId = String(connection.wabaId).trim();
    const token = String(connection.accessToken).trim();

    if (!/^\d+$/.test(wabaId)) {
      return jsonError('Invalid WhatsApp Business Account ID', 400);
    }

    if (!token) {
      return jsonError('WhatsApp access token is missing', 400);
    }

    // 4. Fetch templates from Meta Graph API.
    const templates: MetaTemplate[] = [];
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();

    let nextUrl: string | null =
      `${GRAPH_BASE}/${encodeURIComponent(wabaId)}/message_templates` +
      '?fields=id,name,status,category,language,components&limit=100';

    let pageCount = 0;
    let lastPaging: NonNullable<MetaResponse['paging']> | null = null;

    while (nextUrl && pageCount < MAX_PAGES) {
      let currentUrl: URL;

      try {
        currentUrl = new URL(nextUrl);
      } catch {
        return jsonError('Invalid Meta pagination URL', 502);
      }

      // Allow only HTTPS requests to the expected Graph API host/version.
      if (
        currentUrl.protocol !== 'https:' ||
        currentUrl.hostname !== 'graph.facebook.com' ||
        !currentUrl.pathname.startsWith(`/${GRAPH_VERSION}/`)
      ) {
        console.error('[WA templates] Rejected unexpected pagination URL');
        return jsonError('Invalid Meta pagination URL', 502);
      }

      if (seenUrls.has(currentUrl.toString())) {
        console.error('[WA templates] Pagination loop detected');
        return jsonError('Meta pagination loop detected', 502);
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
          httpStatus: response.status,
          page: pageCount,
        });

        return jsonError('Meta returned an invalid response', 502);
      }

      // 5. Handle Meta API errors.
      if (!response.ok || result.error) {
        const metaError = result.error;

        console.error('[WA templates] Meta API error', {
          wabaId,
          httpStatus: response.status,
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

        return jsonError(
          metaError?.message || 'Unable to fetch WhatsApp templates',
          status,
          {
            metaErrorCode: metaError?.code ?? null,
            metaErrorSubcode: metaError?.error_subcode ?? null,
            fbtraceId: metaError?.fbtrace_id ?? null,
          },
        );
      }

      if (!Array.isArray(result.data)) {
        console.error('[WA templates] Unexpected Meta response shape', {
          wabaId,
          page: pageCount,
          responseKeys: Object.keys(result),
        });

        return jsonError(
          'Meta response did not contain a templates data array',
          502,
        );
      }

      // 6. Collect unique templates from all pages.
      for (const item of result.data) {
        const uniqueId =
          item.id ||
          `${item.name ?? ''}:${item.language ?? ''}:${item.category ?? ''}`;

        if (!seenIds.has(uniqueId)) {
          seenIds.add(uniqueId);
          templates.push(item);
        }
      }

      lastPaging = result.paging ?? null;
      nextUrl = result.paging?.next ?? null;
    }

    // 7. Prepare template data for the frontend.
    const normalizedTemplates = templates.map((item) => {
      const components = item.components ?? [];
      const bodyText = getBodyText(components);

      return {
        id: item.id ?? item.name ?? '',
        name: item.name ?? '',
        displayName: item.name ?? 'Message template',
        status: item.status ?? '',
        category: item.category ?? '',
        language: item.language ?? 'en',
        components,
        bodyText,
        parameterCount: getParameterCount(bodyText),
      };
    });

    console.log('[WA templates diagnostic]', {
      wabaId,
      httpStatus: 200,
      pagesFetched: pageCount,
      count: normalizedTemplates.length,
      templates: normalizedTemplates.map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        category: item.category,
        language: item.language,
      })),
      hasMorePages: Boolean(nextUrl),
    });

    // 8. Return templates to the frontend.
    return NextResponse.json(
      {
        success: true,
        templates: normalizedTemplates,
        paging: lastPaging,
        hasMorePages: Boolean(nextUrl),
        pagesFetched: pageCount,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        },
      },
    );
  } catch (error) {
    console.error('[WA templates] GET failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });

    if (error instanceof Error && error.name === 'TimeoutError') {
      return jsonError('Meta API request timed out', 504);
    }

    return jsonError('Failed to load WhatsApp templates', 500);
  }
}
