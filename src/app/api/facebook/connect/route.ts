///src/app/api/facebook/connect/route.ts
import {
  NextRequest,
  NextResponse,
} from 'next/server';

import crypto from 'crypto';

import { db } from '@/db';

import {
  facebookOAuthStates,
} from '@/db/schema';

import {
  getUserIdFromRequest,
  AuthError,
} from '@/lib/auth';

import {
  eq,
  lt,
} from 'drizzle-orm';

const FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
];

function getRequiredEnv(
  name: string
): string {
  const value =
    process.env[name];

  if (!value) {
    throw new Error(
      `${name} is not configured`
    );
  }

  return value;
}

export async function POST(
  request: NextRequest
) {
  try {
    const userId =
      getUserIdFromRequest(request);

    const appId =
      getRequiredEnv(
        'META_FACEBOOK_APP_ID'
      );

    const redirectUri =
      getRequiredEnv(
        'META_FACEBOOK_REDIRECT_URI'
      );

    const appUrl =
      getRequiredEnv(
        'AARNA_APP_URL'
      );

    /**
     * Remove expired OAuth states.
     */
    await db
      .delete(facebookOAuthStates)
      .where(
        lt(
          facebookOAuthStates.expiresAt,
          new Date()
        )
      );

    /**
     * Generate cryptographically secure state.
     */
    const state =
      crypto.randomBytes(32)
        .toString('base64url');

    /**
     * Never store raw state.
     * Store SHA-256 hash instead.
     */
    const stateHash =
      crypto
        .createHash('sha256')
        .update(state)
        .digest('hex');

    const expiresAt =
      new Date(
        Date.now() +
          10 * 60 * 1000
      );

    await db
      .insert(facebookOAuthStates)
      .values({
        stateHash,
        userId,
        expiresAt,
      });

    const params =
      new URLSearchParams({
        client_id: appId,

        redirect_uri:
          redirectUri,

        state,

        response_type: 'code',

        scope:
          FACEBOOK_SCOPES.join(','),
      });

    const authUrl =
      `https://www.facebook.com/dialog/oauth?${params.toString()}`;

    /**
     * appUrl is intentionally referenced so configuration
     * is validated here as well.
     */
    void appUrl;

    return NextResponse.json({
      success: true,
      authUrl,
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
      'Facebook connect error:',
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          'Unable to start Facebook connection',
      },
      {
        status: 500,
      }
    );
  }
}