// src/app/api/instagram/status/route.ts

import {
  NextRequest,
  NextResponse,
} from 'next/server';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { instagramConnections } from '@/db/schema';

import {
  getUserIdFromRequest,
  AuthError,
} from '@/lib/auth';

export async function GET(
  req: NextRequest
) {
  try {
    const userId =
      getUserIdFromRequest(req);

    const connectionRows =
      await db
        .select({
          id:
            instagramConnections.id,

          instagramUserId:
            instagramConnections.instagramUserId,

          instagramUsername:
            instagramConnections.instagramUsername,

          instagramName:
            instagramConnections.instagramName,

          instagramProfilePicture:
            instagramConnections.instagramProfilePicture,

          tokenExpiresAt:
            instagramConnections.tokenExpiresAt,

          status:
            instagramConnections.status,
        })
        .from(
          instagramConnections
        )
        .where(
          eq(
            instagramConnections.userId,
            userId
          )
        )
        .limit(1);

    if (connectionRows.length === 0) {
      return NextResponse.json({
        success: true,
        connected: false,
        connection: null,
      });
    }

    const instagram =
      connectionRows[0];

    /*
     * Check database status.
     */

    if (
      instagram.status !== 'active'
    ) {
      return NextResponse.json({
        success: true,
        connected: false,
        expired:
          instagram.status ===
          'expired',
        connection: null,
      });
    }

    /*
     * Check token expiry.
     */

    if (
      instagram.tokenExpiresAt &&
      new Date(
        instagram.tokenExpiresAt
      ).getTime() <= Date.now()
    ) {
      return NextResponse.json({
        success: true,
        connected: false,
        expired: true,
        connection: null,
      });
    }

    return NextResponse.json({
      success: true,
      connected: true,
      expired: false,

      /*
       * IMPORTANT:
       * Key is "connection" (not "profile") so the frontend's
       * generic username-resolution logic
       * (response?.connection?.username) picks this up
       * the same way it already does for Facebook
       * (response?.connection?.pageName).
       */
      connection: {
        id:
          instagram.instagramUserId,

        username:
          instagram.instagramUsername,

        name:
          instagram.instagramName,

        profilePicture:
          instagram.instagramProfilePicture,
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
        { status: 401 }
      );
    }

    console.error(
      '[Instagram Status] Error:',
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          'Failed to check Instagram connection',
      },
      { status: 500 }
    );
  }
}