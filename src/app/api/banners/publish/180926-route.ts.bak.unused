// src/app/api/banners/publish/route.ts

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';

import { db } from '@/db';
import {
  banners,
  instagramConnections,
  products,
} from '@/db/schema';

import { eq, and } from 'drizzle-orm';

import {
  getUserIdFromRequest,
  AuthError,
} from '@/lib/auth';

/* =========================================================
   CONFIG
========================================================= */

const META_GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || 'v26.0';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

const GRAPH_API_BASE =
  `https://graph.instagram.com/${META_GRAPH_VERSION}`;


const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT ||
  '/var/www/aarnexai.com/aarnexai-backend/upload';


/* =========================================================
   TYPES
========================================================= */

interface PublishBody {
  bannerId: number | string;
  platforms: string[];
}

interface InstagramContainerResponse {
  id?: string;
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

interface InstagramStatusResponse {
  status_code?: string;
  status?: string;
  error_message?: string;
  error?: {
    message?: string;
    type?: string;
    code?: number;
  };
}


function getPublicImageUrl(
  imageUrl: string | null | undefined
): string {
  if (!imageUrl) {
    throw new Error('Banner image URL is missing');
  }

  let url = String(imageUrl).trim();

  // Already an absolute URL
  if (
    url.startsWith('https://') ||
    url.startsWith('http://')
  ) {
    return url;
  }

  // Make sure it starts with /
  if (!url.startsWith('/')) {
    url = `/${url}`;
  }

  return `${PUBLIC_BASE_URL}${url}`;
}


/**
 * Creates a safe filename.
 */
function safeFileName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}


/**
 * Extract a useful error message from Meta.
 */
function getMetaErrorMessage(
  data: any,
  fallback = 'Instagram API request failed'
): string {
  return (
    data?.error?.message ||
    data?.error_message ||
    data?.message ||
    fallback
  );
}


/**
 * Verify that an image can actually be accessed publicly.
 */
async function verifyPublicImage(
  imageUrl: string
) {
  console.log(
    '[Instagram] Checking public image URL:',
    imageUrl
  );

  const response = await fetch(imageUrl, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
  });

  const contentType =
    response.headers.get('content-type');

  console.log('[Instagram] Public image check:', {
    status: response.status,
    contentType,
    finalUrl: response.url,
  });

  return {
    response,
    contentType,
  };
}


/**
 * Download the original image and convert it to JPEG.
 *
 * Instagram publishing works much more reliably with a
 * publicly accessible JPEG URL.
 */
async function createInstagramJpeg(
  originalImageUrl: string,
  bannerId: string | number
): Promise<string> {

  console.log(
    '[Instagram] Downloading source image:',
    originalImageUrl
  );

  const response = await fetch(originalImageUrl, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      `Could not download banner image. HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  const inputBuffer =
    Buffer.from(arrayBuffer);

  const fileName =
    `banner-${safeFileName(String(bannerId))}-instagram-${Date.now()}.jpg`;

  const outputDirectory = path.join(
    UPLOAD_ROOT,
    'products',
    'banners',
    'instagram'
  );

  await fs.mkdir(outputDirectory, {
    recursive: true,
  });

  const outputPath = path.join(
    outputDirectory,
    fileName
  );

  console.log(
    '[Instagram] Creating JPEG:',
    outputPath
  );

  await sharp(inputBuffer)
    .jpeg({
      quality: 90,
      progressive: false,
    })
    .toFile(outputPath);

  /**
   * This URL is publicly accessible:
   *
   * https://aarnatechxperts.in/upload/products/banners/instagram/...
   */
  const publicUrl =
    `${PUBLIC_BASE_URL}/upload/products/banners/instagram/${fileName}`;

  console.log(
    '[Instagram] Generated public JPEG URL:',
    publicUrl
  );

  return publicUrl;
}


/**
 * Wait for an Instagram media container to finish processing.
 */
async function waitForInstagramContainer(
  containerId: string,
  accessToken: string,
  maxAttempts = 20,
  delayMs = 3000
) {

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {

    const url =
      `${GRAPH_API_BASE}/${containerId}` +
      `?fields=status_code,status,error_message` +
      `&access_token=${encodeURIComponent(accessToken)}`;

    console.log(
      `[Instagram] Container status check ${attempt}/${maxAttempts}`
    );

    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
    });

    const data =
      (await response.json()) as InstagramStatusResponse;

    console.log(
      '[Instagram] Container status:',
      data
    );

    if (!response.ok) {
      throw new Error(
        getMetaErrorMessage(
          data,
          'Unable to check Instagram media container'
        )
      );
    }

    const statusCode =
      String(data.status_code || '').toUpperCase();

    if (statusCode === 'FINISHED') {
      return data;
    }

    if (
      statusCode === 'ERROR' ||
      statusCode === 'EXPIRED'
    ) {
      throw new Error(
        data.error_message ||
        `Instagram media container failed with status ${statusCode}`
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, delayMs)
    );
  }

  throw new Error(
    'Instagram media container did not finish processing in time'
  );
}


/**
 * Publish one Instagram image.
 */
async function publishToInstagram(params: {
  instagramUserId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
}) {

  const {
    instagramUserId,
    accessToken,
    imageUrl,
    caption,
  } = params;

  console.log(
    '[Instagram] Creating media container',
    {
      instagramUserId,
      imageUrl,
    }
  );

  /* =======================================================
     STEP 1: CREATE MEDIA CONTAINER
  ======================================================= */

  const createUrl =
    `${GRAPH_API_BASE}/${instagramUserId}/media`;

  const createBody =
    new URLSearchParams();

  createBody.set(
    'image_url',
    imageUrl
  );

  createBody.set(
    'caption',
    caption || ''
  );

  createBody.set(
    'access_token',
    accessToken
  );

  const createResponse =
    await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded',
      },
      body: createBody.toString(),
    });

  const createData =
    (await createResponse.json()) as InstagramContainerResponse;

  console.log(
    '[Instagram] Create container response:',
    createData
  );

  if (
    !createResponse.ok ||
    !createData.id
  ) {
    throw new Error(
      getMetaErrorMessage(
        createData,
        'Instagram media container creation failed'
      )
    );
  }

  const containerId =
    createData.id;

  /* =======================================================
     STEP 2: WAIT FOR CONTAINER
  ======================================================= */

  await waitForInstagramContainer(
    containerId,
    accessToken
  );

  /* =======================================================
     STEP 3: PUBLISH MEDIA
  ======================================================= */

  console.log(
    '[Instagram] Publishing container:',
    containerId
  );

  const publishUrl =
    `${GRAPH_API_BASE}/${instagramUserId}/media_publish`;

  const publishBody =
    new URLSearchParams();

  publishBody.set(
    'creation_id',
    containerId
  );

  publishBody.set(
    'access_token',
    accessToken
  );

  const publishResponse =
    await fetch(publishUrl, {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded',
      },
      body: publishBody.toString(),
    });

  const publishData =
    await publishResponse.json();

  console.log(
    '[Instagram] Publish response:',
    publishData
  );

  if (
    !publishResponse.ok ||
    !publishData.id
  ) {
    throw new Error(
      getMetaErrorMessage(
        publishData,
        'Instagram media publishing failed'
      )
    );
  }

  return {
    mediaId: publishData.id,
    containerId,
  };
}


/* =========================================================
   POST /api/banners/publish
========================================================= */

export async function POST(
  req: NextRequest
) {

  try {

    /* =====================================================
       AUTHENTICATION
    ===================================================== */

    let userId: number;

    try {

      userId =
        getUserIdFromRequest(req);

    } catch (error) {

      if (error instanceof AuthError) {
        return NextResponse.json(
          {
            success: false,
            message: error.message,
          },
          {
            status: 401,
          }
        );
      }

      throw error;
    }


    /* =====================================================
       REQUEST BODY
    ===================================================== */

    const body =
      (await req.json()) as PublishBody;

    const bannerId =
      body?.bannerId;

    const platforms =
      Array.isArray(body?.platforms)
        ? body.platforms
        : [];

    if (!bannerId) {
      return NextResponse.json(
        {
          success: false,
          message: 'bannerId is required',
        },
        {
          status: 400,
        }
      );
    }

    if (platforms.length === 0) {
      return NextResponse.json(
        {
          success: false,
          message: 'At least one platform is required',
        },
        {
          status: 400,
        }
      );
    }


    /* =====================================================
       NORMALIZE PLATFORMS
    ===================================================== */

    const normalizedPlatforms =
      platforms.map((platform) =>
        String(platform).toLowerCase().trim()
      );

    const wantsInstagram =
      normalizedPlatforms.includes('instagram');

    const wantsFacebook =
      normalizedPlatforms.includes('facebook');


    console.log(
      '[Publish] Request:',
      {
        userId,
        bannerId,
        platforms: normalizedPlatforms,
      }
    );


    /* =====================================================
       LOAD BANNER
    ===================================================== */

    const bannerRows =
      await db
        .select()
        .from(banners)
        .where(
          eq(
            banners.id,
            Number(bannerId)
          )
        )
        .limit(1);

    const banner =
      bannerRows[0];

    if (!banner) {
      return NextResponse.json(
        {
          success: false,
          message: 'Banner not found',
        },
        {
          status: 404,
        }
      );
    }


    console.log(
      '[Publish] Banner:',
      banner
    );


    /* =====================================================
       LOAD PRODUCT
    ===================================================== */

    let product: any = null;

    if (banner.productId) {

      const productRows =
        await db
          .select()
          .from(products)
          .where(
            eq(
              products.id,
              banner.productId
            )
          )
          .limit(1);

      product =
        productRows[0] || null;
    }


    /* =====================================================
       ORIGINAL IMAGE URL
    ===================================================== */

    const originalImageUrl =
      getPublicImageUrl(
        banner.imageUrl
      );

    console.log(
      '[Publish] DB image URL:',
      banner.imageUrl
    );

    console.log(
      '[Publish] FINAL public image URL:',
      originalImageUrl
    );


    /* =====================================================
       VERIFY ORIGINAL IMAGE
    ===================================================== */

    const imageCheck =
      await verifyPublicImage(
        originalImageUrl
      );

    if (!imageCheck.response.ok) {

      return NextResponse.json(
        {
          success: false,
          message:
            'Instagram could not access the banner image URL',

          imageUrl:
            originalImageUrl,

          imageStatus:
            imageCheck.response.status,

          contentType:
            imageCheck.contentType,
        },
        {
          status: 400,
        }
      );
    }


    /* =====================================================
       PREPARE INSTAGRAM IMAGE
    ===================================================== */

    let instagramImageUrl =
      originalImageUrl;

    if (wantsInstagram) {

      try {

        instagramImageUrl =
          await createInstagramJpeg(
            originalImageUrl,
            bannerId
          );

      } catch (error: any) {

        console.error(
          '[Instagram] JPEG conversion failed:',
          error
        );

        return NextResponse.json(
          {
            success: false,
            message:
              'Failed to prepare banner image for Instagram',

            imageUrl:
              originalImageUrl,

            error:
              error?.message ||
              'JPEG conversion failed',
          },
          {
            status: 500,
          }
        );
      }


      /* ===================================================
         VERIFY GENERATED JPEG
      =================================================== */

      const jpegCheck =
        await verifyPublicImage(
          instagramImageUrl
        );

      if (!jpegCheck.response.ok) {

        return NextResponse.json(
          {
            success: false,
            message:
              'Generated Instagram JPEG is not publicly accessible',

            imageUrl:
              instagramImageUrl,

            imageStatus:
              jpegCheck.response.status,

            contentType:
              jpegCheck.contentType,
          },
          {
            status: 400,
          }
        );
      }

      console.log(
        '[Instagram] Generated JPEG is publicly accessible:',
        {
          url: instagramImageUrl,
          status: jpegCheck.response.status,
          contentType: jpegCheck.contentType,
        }
      );
    }


    /* =====================================================
       CAPTION
    ===================================================== */

    /**
     * NOTE:
     * hashtags / description / features / keywords all live on the
     * PRODUCT row, not on the banner row (see GET /banners route,
     * which reads them from `products`, e.g. `product?.hashtags ?? []`).
     * The `banners` table only has `caption` — nothing else.
     */

    // Safely coerce a value that may be a real array (jsonb column)
    // or a JSON-stringified array (legacy rows) into a string[].
    function toStringArray(value: unknown): string[] {
      if (!value) return [];

      if (Array.isArray(value)) {
        return value.map((v) => String(v));
      }

      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            return parsed.map((v) => String(v));
          }
        } catch {
          // Not JSON — treat the whole string as a single item.
          return [value];
        }
      }

      return [];
    }

    const captionParts: string[] = [];

    if (banner.caption) {
      captionParts.push(
        String(banner.caption)
      );
    } else if (product?.title) {
      captionParts.push(
        String(product.title)
      );
    }

    if (product?.description) {
      captionParts.push(
        String(product.description)
      );
    }

    // Append hashtags so they show up under the Instagram post caption.
    const hashtagList = toStringArray(
      product?.hashtags
    );

    if (hashtagList.length > 0) {
      const hashtagLine = hashtagList
        .map((tag) =>
          tag.startsWith('#') ? tag : `#${tag}`
        )
        .join(' ');

      captionParts.push(hashtagLine);
    }

    const caption =
      captionParts.join('\n\n').trim() ||
      'Check out this product!';

    console.log(
      '[Publish] Hashtags used:',
      hashtagList
    );

    console.log(
      '[Publish] Caption:',
      caption
    );


    /* =====================================================
       RESULT
    ===================================================== */

    const results: Record<
      string,
      any
    > = {};


    /* =====================================================
       INSTAGRAM
    ===================================================== */

    if (wantsInstagram) {

      console.log(
        '[Instagram] Looking for connection:',
        {
          userId,
        }
      );

      const connectionRows =
        await db
          .select()
          .from(instagramConnections)
          .where(
            eq(
              instagramConnections.userId,
              userId
            )
          )
          .limit(1);

      const connection =
        connectionRows[0];

      console.log(
        '[Instagram] Connection found:',
        !!connection
      );

      if (!connection) {

        return NextResponse.json(
          {
            success: false,
            message:
              'Instagram is not connected. Please connect Instagram first.',

            requiresInstagramConnection:
              true,
          },
          {
            status: 401,
          }
        );
      }


      /* ===================================================
         CONNECTION FIELDS
      =================================================== */

      const instagramUserId =
        String(
          connection.instagramUserId ||
          ''
        ).trim();

      const accessToken =
        String(
          connection.accessToken ||
          ''
        ).trim();


      if (!instagramUserId) {

        return NextResponse.json(
          {
            success: false,
            message:
              'Instagram connection is missing instagramUserId',
          },
          {
            status: 400,
          }
        );
      }

      if (!accessToken) {

        return NextResponse.json(
          {
            success: false,
            message:
              'Instagram connection is missing access token',
          },
          {
            status: 400,
          }
        );
      }


      console.log(
        '[Instagram] Publishing with account:',
        instagramUserId
      );


      /* ===================================================
         PUBLISH
      =================================================== */

      try {

        const instagramResult =
          await publishToInstagram({
            instagramUserId,
            accessToken,
            imageUrl:
              instagramImageUrl,
            caption,
          });

        results.instagram = {
          success: true,
          mediaId:
            instagramResult.mediaId,
          containerId:
            instagramResult.containerId,
          imageUrl:
            instagramImageUrl,
        };

      } catch (error: any) {

        console.error(
          '[Instagram] Publishing failed:',
          error
        );

        results.instagram = {
          success: false,
          message:
            error?.message ||
            'Instagram publishing failed',
          imageUrl:
            instagramImageUrl,
        };
      }
    }


    /* =====================================================
       FACEBOOK
       
       NOTE:
       Facebook publishing is not implemented in this
       route yet because the exact Facebook connection
       schema/API flow was not provided.
    ===================================================== */

    if (wantsFacebook) {

      results.facebook = {
        success: false,
        message:
          'Facebook publishing is not implemented in this route yet.',
      };
    }


    /* =====================================================
       FINAL STATUS
    ===================================================== */

    const successfulPlatforms =
      Object.entries(results)
        .filter(
          ([, result]) =>
            result?.success === true
        )
        .map(
          ([platform]) =>
            platform
        );

    const failedPlatforms =
      Object.entries(results)
        .filter(
          ([, result]) =>
            result?.success !== true
        )
        .map(
          ([platform]) =>
            platform
        );


    if (
      successfulPlatforms.length === 0
    ) {

      return NextResponse.json(
        {
          success: false,

          message:
            'No platform was successfully published',

          bannerId,

          results,
        },
        {
          status: 400,
        }
      );
    }


    /* =====================================================
       MARK BANNER(S) AS POSTED
       Once any platform succeeds, mark this whole day's
       banners (this variant + its alternates) as posted so
       GET /banners stops returning them.
    ===================================================== */

    try {
      await db
        .update(banners)
        .set({ posted: true })
        .where(
          and(
            eq(banners.productId, banner.productId),
            eq(banners.day, banner.day)
          )
        );

      console.log(
        '[Publish] Marked banners as posted:',
        {
          productId: banner.productId,
          day: banner.day,
        }
      );
    } catch (error) {
      console.error(
        '[Publish] Failed to mark banners as posted:',
        error
      );
      // Don't fail the whole request just because the
      // posted-flag update failed — the post itself succeeded.
    }


    /* =====================================================
       SUCCESS
    ===================================================== */

    return NextResponse.json(
      {
        success:
          failedPlatforms.length === 0,

        message:
          failedPlatforms.length === 0
            ? 'Banner published successfully'
            : 'Banner partially published',

        bannerId,

        publishedPlatforms:
          successfulPlatforms,

        failedPlatforms,

        results,
      },
      {
        status:
          failedPlatforms.length === 0
            ? 200
            : 207,
      }
    );

  } catch (error: any) {

    console.error(
      '[Publish] Unexpected error:',
      error
    );

    return NextResponse.json(
      {
        success: false,

        message:
          error?.message ||
          'Failed to publish banner',

        error:
          process.env.NODE_ENV === 'development'
            ? String(error?.stack || error)
            : undefined,
      },
      {
        status: 500,
      }
    );
  }
}