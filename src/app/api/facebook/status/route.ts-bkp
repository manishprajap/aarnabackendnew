import {
  NextRequest,
  NextResponse,
} from 'next/server';

import {
  eq,
} from 'drizzle-orm';

import { db } from '@/db';

import {
  facebookConnections,
} from '@/db/schema';

import {
  getUserIdFromRequest,
  AuthError,
} from '@/lib/auth';

export async function GET(
  request: NextRequest
) {
  try {
    const userId =
      getUserIdFromRequest(request);

    const rows =
      await db
        .select({
          id:
            facebookConnections.id,

          pageId:
            facebookConnections.pageId,

          pageName:
            facebookConnections.pageName,

          pageProfilePicture:
            facebookConnections.pageProfilePicture,

          status:
            facebookConnections.status,

          connectedAt:
            facebookConnections.connectedAt,

          lastVerifiedAt:
            facebookConnections.lastVerifiedAt,

          lastPublishAt:
            facebookConnections.lastPublishAt,

          lastError:
            facebookConnections.lastError,
        })
        .from(
          facebookConnections
        )
        .where(
          eq(
            facebookConnections.userId,
            userId
          )
        )
        .limit(1);

    const connection =
      rows[0];

    if (!connection) {
      return NextResponse.json({
        success: true,
        connected: false,
        connection: null,
      });
    }

    return NextResponse.json({
      success: true,
      connected:
        connection.status ===
        'active',

      connection: {
        id:
          connection.id,

        pageId:
          connection.pageId,

        pageName:
          connection.pageName,

        pageProfilePicture:
          connection.pageProfilePicture,

        status:
          connection.status,

        connectedAt:
          connection.connectedAt,

        lastVerifiedAt:
          connection.lastVerifiedAt,

        lastPublishAt:
          connection.lastPublishAt,

        lastError:
          connection.lastError,
      },
    });
  } catch (error) {
    if (
      error instanceof AuthError
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            error.message,
        },
        {
          status: 401,
        }
      );
    }

    console.error(
      'Facebook status error:',
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          'Unable to get Facebook status',
      },
      {
        status: 500,
      }
    );
  }
}