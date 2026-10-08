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
import {
  getSubscriptionAccess,
  subscriptionDeniedResponse,
} from '@/lib/subscriptionAccess';

import {
  decryptFacebookToken,
} from '@/lib/facebook-token';

import {
  graphUrl,
} from '@/lib/facebook';

type PublishBody = {
  message?: unknown;
  imageUrl?: unknown;
  link?: unknown;
};

function isValidHttpUrl(
  value: string
): boolean {
  try {
    const url =
      new URL(value);

    return (
      url.protocol ===
        'https:' ||
      url.protocol ===
        'http:'
    );
  } catch {
    return false;
  }
}

export async function POST(
  request: NextRequest
) {
  try {
    const userId =
      getUserIdFromRequest(request);
    const subscriptionAccess = await getSubscriptionAccess(userId);
    if (!subscriptionAccess.allowed) {
      return subscriptionDeniedResponse(subscriptionAccess);
    }

    const body =
      (await request.json()
        .catch(() => ({}))) as PublishBody;

    const message =
      typeof body.message ===
      'string'
        ? body.message.trim()
        : '';

    const imageUrl =
      typeof body.imageUrl ===
      'string'
        ? body.imageUrl.trim()
        : '';

    const link =
      typeof body.link ===
      'string'
        ? body.link.trim()
        : '';

    if (
      !message &&
      !imageUrl &&
      !link
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            'message, imageUrl, or link is required',
        },
        {
          status: 400,
        }
      );
    }

    if (
      imageUrl &&
      !isValidHttpUrl(imageUrl)
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            'imageUrl must be a valid HTTP/HTTPS URL',
        },
        {
          status: 400,
        }
      );
    }

    if (
      link &&
      !isValidHttpUrl(link)
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            'link must be a valid HTTP/HTTPS URL',
        },
        {
          status: 400,
        }
      );
    }

    /**
     * Get connected Page.
     */
    const rows =
      await db
        .select({
          id:
            facebookConnections.id,

          pageId:
            facebookConnections.pageId,

          accessToken:
            facebookConnections.accessToken,

          status:
            facebookConnections.status,
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
      return NextResponse.json(
        {
          success: false,
          message:
            'Facebook Page is not connected',
        },
        {
          status: 404,
        }
      );
    }

    if (
      connection.status !==
      'active'
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Facebook connection is not active',
        },
        {
          status: 400,
        }
      );
    }

    /**
     * Decrypt Page access token.
     */
    let pageAccessToken: string;

    try {
      pageAccessToken =
        decryptFacebookToken(
          connection.accessToken
        );
    } catch (error) {
      console.error(
        'Facebook token decryption error:',
        error
      );

      return NextResponse.json(
        {
          success: false,
          message:
            'Stored Facebook token is invalid',
        },
        {
          status: 500,
        }
      );
    }

    /**
     * IMAGE POST
     *
     * Uses Page /photos endpoint.
     */
    if (imageUrl) {
      const form =
        new URLSearchParams();

      form.set(
        'url',
        imageUrl
      );

      if (message) {
        form.set(
          'caption',
          message
        );
      }

      form.set(
        'access_token',
        pageAccessToken
      );

      const response =
        await fetch(
          graphUrl(
            `/${encodeURIComponent(
              connection.pageId
            )}/photos`
          ),
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded',
            },

            body:
              form.toString(),

            cache: 'no-store',
          }
        );

      const text =
        await response.text();

      let data: unknown;

      try {
        data =
          JSON.parse(text);
      } catch {
        data = {
          raw: text,
        };
      }

      if (!response.ok) {
        console.error(
          'Facebook image publish error:',
          data
        );

        await db
          .update(
            facebookConnections
          )
          .set({
            lastError:
              JSON.stringify(data),
            status:
              'error',
            updatedAt:
              new Date(),
          })
          .where(
            eq(
              facebookConnections.id,
              connection.id
            )
          );

        return NextResponse.json(
          {
            success: false,
            message:
              'Facebook image publish failed',
            meta:
              data,
          },
          {
            status:
              response.status >=
              400
                ? response.status
                : 500,
          }
        );
      }

      await db
        .update(
          facebookConnections
        )
        .set({
          status:
            'active',

          lastPublishAt:
            new Date(),

          lastError:
            null,

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            facebookConnections.id,
            connection.id
          )
        );

      return NextResponse.json({
        success: true,

        type: 'image',

        result: data,
      });
    }

    /**
     * TEXT / LINK POST
     */
    const form =
      new URLSearchParams();

    if (message) {
      form.set(
        'message',
        message
      );
    }

    if (link) {
      form.set(
        'link',
        link
      );
    }

    form.set(
      'access_token',
      pageAccessToken
    );

    const response =
      await fetch(
        graphUrl(
          `/${encodeURIComponent(
            connection.pageId
          )}/feed`
        ),
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded',
          },

          body:
            form.toString(),

          cache: 'no-store',
        }
      );

    const text =
      await response.text();

    let data: unknown;

    try {
      data =
        JSON.parse(text);
    } catch {
      data = {
        raw: text,
      };
    }

    if (!response.ok) {
      console.error(
        'Facebook feed publish error:',
        data
      );

      await db
        .update(
          facebookConnections
        )
        .set({
          lastError:
            JSON.stringify(data),

          status:
            'error',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            facebookConnections.id,
            connection.id
          )
        );

      return NextResponse.json(
        {
          success: false,
          message:
            'Facebook post failed',
          meta:
            data,
        },
        {
          status:
            response.status >=
            400
              ? response.status
              : 500,
        }
      );
    }

    await db
      .update(
        facebookConnections
      )
      .set({
        status:
          'active',

        lastPublishAt:
          new Date(),

        lastError:
          null,

        updatedAt:
          new Date(),
      })
      .where(
        eq(
          facebookConnections.id,
          connection.id
        )
      );

    return NextResponse.json({
      success: true,

      type: 'feed',

      result: data,
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
      'Facebook publish error:',
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          'Unable to publish to Facebook',
      },
      {
        status: 500,
      }
    );
  }
}