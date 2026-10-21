import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { whatsappConnections } from '@/db/schema';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';

export async function GET(request: NextRequest) {
  try {
    // Use the same authentication helper as your existing inbox APIs.
    const userId = await getUserIdFromRequest(request);

    if (!userId) {
      return NextResponse.json(
        { error: 'Authentication required' },
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
        { error: 'WhatsApp account is not connected' },
        { status: 404 }
      );
    }

    if (!connection.wabaId || !connection.accessToken) {
      return NextResponse.json(
        { error: 'WhatsApp Business Account ID or access token is missing' },
        { status: 400 }
      );
    }

    const url = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
        connection.wabaId
      )}/message_templates`
    );

    url.searchParams.set(
      'fields',
      'id,name,status,category,language,components'
    );
    url.searchParams.set('limit', '100');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
      },
      cache: 'no-store',
    });

    const result = await response.json();
    console.log('[WA templates diagnostic]', {
      wabaId: connection.wabaId,
      httpStatus: response.status,
      count: Array.isArray(result.data)
        ? result.data.length
        : null,
      metaError: result.error?.message ?? null,
      paging: result.paging ?? null,
    });
    if (!response.ok) {
      console.error(
        '[WhatsApp Templates] Meta API error:',
        response.status,
        result
      );

      return NextResponse.json(
        {
          error:
            result?.error?.message ||
            'Unable to fetch WhatsApp message templates',
          metaErrorCode: result?.error?.code ?? null,
        },
        { status: response.status >= 500 ? 502 : 400 }
      );
    }

    const templates = Array.isArray(result.data)
      ? result.data.map((item: {
        id?: string;
        name?: string;
        status?: string;
        category?: string;
        language?: string;
        components?: unknown[];
      }) => ({
        id: item.id ?? item.name ?? '',
        name: item.name ?? '',
        status: item.status ?? '',
        category: item.category ?? '',
        language: item.language ?? '',
        components: item.components ?? [],
      }))
      : [];

    return NextResponse.json(
      {
        success: true,
        templates,
        paging: result.paging ?? null,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (error) {
    console.error('[WhatsApp Templates] GET failed:', error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load WhatsApp templates',
      },
      { status: 500 }
    );
  }
}