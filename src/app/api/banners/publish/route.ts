//src/app/api/banners/publish/route
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';

import { db } from '@/db';
import {
  banners,
  instagramConnections,
  facebookConnections,
  whatsappConnections,
  whatsappContacts,
  products,
  socialAccounts,
  bannerPublications,
} from '@/db/schema';

import { eq, and } from 'drizzle-orm';

import {
  getUserIdFromRequest,
  AuthError,
} from '@/lib/auth';

import {
  decryptFacebookToken,
} from '@/lib/facebook-token';

import {
  LINKEDIN_REST_BASE,
  linkedinHeaders,
} from '@/lib/linkedin-targets';

/* =========================================================
   CONFIG
========================================================= */

const META_GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || 'v25.0';

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || 'https://aarnexai.com'
).replace(/\/+$/, '');

const IG_GRAPH_API_BASE =
  `https://graph.instagram.com/${META_GRAPH_VERSION}`;

const FB_GRAPH_API_BASE =
  `https://graph.facebook.com/${META_GRAPH_VERSION}`;

const WA_GRAPH_API_BASE =
  `https://graph.facebook.com/${META_GRAPH_VERSION}`;

const GOOGLE_BUSINESS_API_BASE = 'https://mybusiness.googleapis.com/v4';

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT ||
  '/var/www/aarnexai.com/aarnexai-backend/upload';

const WA_BROADCAST_TEMPLATE = process.env.WA_BROADCAST_TEMPLATE || '';
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'en';

const WA_ERR_REENGAGEMENT = 131047;


/* =========================================================
   TYPES
========================================================= */

interface PublishBody {
  bannerId: number | string;
  platforms: string[];
  linkedinAuthorUrn?: string;
  linkedinOwnerUrns?: string[];
  facebookPageIds?: string[];
  instagramAccountIds?: string[];
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


/* =========================================================
   HELPERS
========================================================= */

function getPublicImageUrl(
  imageUrl: string | null | undefined
): string {
  if (!imageUrl) {
    throw new Error('Banner image URL is missing');
  }

  let url = String(imageUrl).trim();

  if (
    url.startsWith('https://') ||
    url.startsWith('http://')
  ) {
    return url;
  }

  if (!url.startsWith('/')) {
    url = `/${url}`;
  }

  return `${PUBLIC_BASE_URL}/${url.replace(/^\/+/, '')}`;
}


function safeFileName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}


function getMetaErrorMessage(
  data: any,
  fallback = 'Meta API request failed'
): string {
  return (
    data?.error?.message ||
    data?.error_message ||
    data?.message ||
    fallback
  );
}


// social_accounts.metadata is a free-form JSON string holding whatever
// extra fields a given provider needs beyond providerAccountId/accountName
// (see schema-additions.ts). Parse it defensively — a row that predates
// the metadata column, or was never backfilled, just yields {}.
function parseAccountMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};

  // social_accounts.metadata is a MySQL JSON column, so Drizzle normally
  // hands back an already-parsed object. Older rows / some drivers may
  // still return a JSON string, so handle both.
  if (typeof raw === 'object') {
    return raw as Record<string, any>;
  }

  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}


// Records that a banner was published somewhere, so the analytics
// endpoint (src/app/api/banners/analytics/route.ts) can look up the
// external post ID later and pull impressions/clicks/reach for it.
// Best-effort — never let a logging failure fail the publish itself.
async function recordBannerPublication(params: {
  bannerId: number | string;
  userId: number;
  platform: string;
  externalId: string;
  permalink?: string | null;
}) {
  const { bannerId, userId, platform, externalId, permalink } = params;

  try {
    await db.insert(bannerPublications).values({
      bannerId: Number(bannerId),
      userId,
      platform,
      externalId,
      permalink: permalink || null,
      publishedAt: new Date(),
    });
  } catch (error) {
    console.error('[Publish] Failed to record bannerPublications row:', {
      bannerId, platform, error,
    });
  }
}


async function verifyPublicImage(imageUrl: string) {
  console.log('[Publish] Checking public image URL:', imageUrl);

  const response = await fetch(imageUrl, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
  });

  const contentType = response.headers.get('content-type');

  console.log('[Publish] Public image check:', {
    status: response.status,
    contentType,
    finalUrl: response.url,
  });

  return { response, contentType };
}


/* =========================================================
   INSTAGRAM PUBLISHING
========================================================= */

async function createInstagramJpeg(
  originalImageUrl: string,
  bannerId: string | number
): Promise<string> {

  console.log('[Instagram] Downloading source image:', originalImageUrl);

  const response = await fetch(originalImageUrl, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Could not download banner image. HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const inputBuffer = Buffer.from(arrayBuffer);

  const fileName =
    `banner-${safeFileName(String(bannerId))}-instagram-${Date.now()}.jpg`;

  const outputDirectory = path.join(
    UPLOAD_ROOT, 'products', 'banners', 'instagram'
  );

  await fs.mkdir(outputDirectory, { recursive: true });

  const outputPath = path.join(outputDirectory, fileName);

  console.log('[Instagram] Creating JPEG:', outputPath);

  await sharp(inputBuffer)
    .jpeg({ quality: 90, progressive: false })
    .toFile(outputPath);

  const publicUrl =
    `${PUBLIC_BASE_URL}/upload/products/banners/instagram/${fileName}`;

  console.log('[Instagram] Generated public JPEG URL:', publicUrl);

  return publicUrl;
}


async function waitForInstagramContainer(
  containerId: string,
  accessToken: string,
  maxAttempts = 20,
  delayMs = 3000
) {

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    const url =
      `${IG_GRAPH_API_BASE}/${containerId}` +
      `?fields=status_code,status,error_message` +
      `&access_token=${encodeURIComponent(accessToken)}`;

    console.log(`[Instagram] Container status check ${attempt}/${maxAttempts}`);

    const response = await fetch(url, { method: 'GET', cache: 'no-store' });
    const data = (await response.json()) as InstagramStatusResponse;

    console.log('[Instagram] Container status:', data);

    if (!response.ok) {
      throw new Error(
        getMetaErrorMessage(data, 'Unable to check Instagram media container')
      );
    }

    const statusCode = String(data.status_code || '').toUpperCase();

    if (statusCode === 'FINISHED') {
      return data;
    }

    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new Error(
        data.error_message ||
        `Instagram media container failed with status ${statusCode}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error('Instagram media container did not finish processing in time');
}


async function publishToInstagram(params: {
  instagramUserId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
}) {

  const { instagramUserId, accessToken, imageUrl, caption } = params;

  console.log('[Instagram] Creating media container', { instagramUserId, imageUrl });

  const createUrl = `${IG_GRAPH_API_BASE}/${instagramUserId}/media`;
  const createBody = new URLSearchParams();

  createBody.set('image_url', imageUrl);
  createBody.set('caption', caption || '');
  createBody.set('access_token', accessToken);

  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: createBody.toString(),
  });

  const createData = (await createResponse.json()) as InstagramContainerResponse;

  console.log('[Instagram] Create container response:', createData);

  if (!createResponse.ok || !createData.id) {
    throw new Error(
      getMetaErrorMessage(createData, 'Instagram media container creation failed')
    );
  }

  const containerId = createData.id;

  await waitForInstagramContainer(containerId, accessToken);

  console.log('[Instagram] Publishing container:', containerId);

  const publishUrl = `${IG_GRAPH_API_BASE}/${instagramUserId}/media_publish`;
  const publishBody = new URLSearchParams();

  publishBody.set('creation_id', containerId);
  publishBody.set('access_token', accessToken);

  const publishResponse = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishBody.toString(),
  });

  const publishData = await publishResponse.json();

  console.log('[Instagram] Publish response:', publishData);

  if (!publishResponse.ok || !publishData.id) {
    throw new Error(
      getMetaErrorMessage(publishData, 'Instagram media publishing failed')
    );
  }

  return { mediaId: publishData.id, containerId };
}


/* =========================================================
   FACEBOOK PUBLISHING
========================================================= */

async function publishToFacebook(params: {
  pageId: string;
  pageAccessToken: string;
  imageUrl: string;
  caption: string;
}) {

  const { pageId, pageAccessToken, imageUrl, caption } = params;

  console.log('[Facebook] Publishing photo to page:', pageId);

  const url = `${FB_GRAPH_API_BASE}/${pageId}/photos`;
  const body = new URLSearchParams();

  body.set('url', imageUrl);
  body.set('caption', caption || '');
  body.set('access_token', pageAccessToken);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();

  console.log('[Facebook] Publish response:', data);

  if (!response.ok || (!data.id && !data.post_id)) {
    throw new Error(getMetaErrorMessage(data, 'Facebook publishing failed'));
  }

  return {
    photoId: data.id as string,
    postId: (data.post_id as string) || (data.id as string),
  };
}


/* =========================================================
   WHATSAPP PUBLISHING (broadcast image to contact list)
========================================================= */

class WhatsappSendError extends Error {
  code?: number;
  subcode?: number;

  constructor(message: string, code?: number, subcode?: number) {
    super(message);
    this.name = 'WhatsappSendError';
    this.code = code;
    this.subcode = subcode;
  }
}


// WhatsApp wants digits only, with country code, no "+" or spaces.
function normalizeWhatsappNumber(value: string): string {
  return String(value || '').replace(/\D/g, '');
}


/**
 * Verifies that the stored Phone Number ID and access token belong together.
 * This is intentionally called before broadcasting so a stale/mismatched
 * WhatsApp connection produces a useful error instead of misleading
 * recipient errors such as (#133010).
 */
async function verifyWhatsappSender(params: {
  phoneNumberId: string;
  accessToken: string;
}) {
  const { phoneNumberId, accessToken } = params;

  const url =
    `${WA_GRAPH_API_BASE}/${encodeURIComponent(phoneNumberId)}` +
    `?fields=id,display_phone_number,verified_name`;

  console.log('[WhatsApp] Verifying sender connection:', {
    apiVersion: META_GRAPH_VERSION,
    phoneNumberId,
  });

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: 'no-store',
  });

  const data = await response.json().catch(() => ({}));

  console.log('[WhatsApp] Sender verification response:', {
    ok: response.ok,
    status: response.status,
    id: data?.id,
    display_phone_number: data?.display_phone_number,
    verified_name: data?.verified_name,
    error: data?.error,
  });

  if (!response.ok || !data?.id) {
    throw new WhatsappSendError(
      getMetaErrorMessage(
        data,
        'WhatsApp sender verification failed. Check the stored Phone Number ID and access token.'
      ),
      data?.error?.code,
      data?.error?.error_subcode
    );
  }

  if (String(data.id) !== phoneNumberId) {
    throw new WhatsappSendError(
      `WhatsApp Phone Number ID mismatch. Stored ${phoneNumberId}, Meta returned ${data.id}.`,
      data?.error?.code,
      data?.error?.error_subcode
    );
  }

  return data;
}


// Free-form image. Only works inside the 24-hour customer-service window.
async function sendWhatsappImage(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  imageUrl: string;
  caption: string;
}) {

  const { phoneNumberId, accessToken, imageUrl, caption } = params;
  const to = normalizeWhatsappNumber(params.to);

  const url = `${WA_GRAPH_API_BASE}/${phoneNumberId}/messages`;

  console.log('[WhatsApp] Sending image:', {
    apiVersion: META_GRAPH_VERSION,
    phoneNumberId,
    to,
    imageUrl,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption || '',
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new WhatsappSendError(
      getMetaErrorMessage(data, `WhatsApp send failed for ${to}`),
      data?.error?.code,
      data?.error?.error_subcode
    );
  }

  return data;
}


// Approved template with an image header. Works outside the 24h window.
async function sendWhatsappTemplateImage(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  imageUrl: string;
  caption: string;
}) {

  const { phoneNumberId, accessToken, imageUrl, caption } = params;
  const to = normalizeWhatsappNumber(params.to);

  // Template body variables can't contain newlines/tabs or 4+ spaces in a row.
  const bodyText = (caption || 'Check out this product!')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, 1000);

  const url = `${WA_GRAPH_API_BASE}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: WA_BROADCAST_TEMPLATE,
        language: { code: WA_TEMPLATE_LANG },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'image', image: { link: imageUrl } }],
          },
          {
            type: 'body',
            parameters: [{ type: 'text', text: bodyText }],
          },
        ],
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new WhatsappSendError(
      getMetaErrorMessage(data, `WhatsApp template send failed for ${to}`),
      data?.error?.code,
      data?.error?.error_subcode
    );
  }

  return data;
}


/**
 * Broadcasts the banner image to every active contact saved by this user.
 *
 * Strategy per contact:
 *   1. Try a free-form image message (works inside the 24h window).
 *   2. If Meta answers with 131047 (outside the window) and a template is
 *      configured via WA_BROADCAST_TEMPLATE, retry with the template.
 *   3. Otherwise report the failure for that contact.
 *
 * Contacts must have opted in to receive marketing messages.
 */
async function publishToWhatsappContacts(params: {
  phoneNumberId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
  contacts: { phoneNumber: string; name: string | null }[];
}) {

  const { phoneNumberId, accessToken, imageUrl, caption, contacts } = params;

  const sent: string[] = [];
  const sentViaTemplate: string[] = [];
  const failed: { phoneNumber: string; error: string }[] = [];

  for (const contact of contacts) {
    try {
      await sendWhatsappImage({
        phoneNumberId,
        accessToken,
        to: contact.phoneNumber,
        imageUrl,
        caption,
      });

      sent.push(contact.phoneNumber);

    } catch (error: any) {

      const outsideWindow =
        error instanceof WhatsappSendError &&
        error.code === WA_ERR_REENGAGEMENT;

      if (outsideWindow && WA_BROADCAST_TEMPLATE) {
        try {
          await sendWhatsappTemplateImage({
            phoneNumberId,
            accessToken,
            to: contact.phoneNumber,
            imageUrl,
            caption,
          });

          sent.push(contact.phoneNumber);
          sentViaTemplate.push(contact.phoneNumber);
          continue;

        } catch (templateError: any) {
          console.error(
            '[WhatsApp] Template send failed for', contact.phoneNumber, templateError
          );

          failed.push({
            phoneNumber: contact.phoneNumber,
            error:
              templateError?.message || 'Unknown WhatsApp template send error',
          });
          continue;
        }
      }

      console.error(
        '[WhatsApp] Failed to send to', contact.phoneNumber, error
      );

      failed.push({
        phoneNumber: contact.phoneNumber,
        error: outsideWindow
          ? 'Outside the 24-hour messaging window. Set WA_BROADCAST_TEMPLATE to an approved template to reach this contact.'
          : error?.message || 'Unknown WhatsApp send error',
      });
    }
  }

  return { sent, sentViaTemplate, failed };
}


/* =========================================================
   GOOGLE BUSINESS PUBLISHING (Business Profile "local post")
========================================================= */

async function publishToGoogleBusiness(params: {
  accountId: string;
  locationId: string;
  accessToken: string;
  imageUrl: string;
  caption: string;
}) {

  const { accountId, locationId, accessToken, imageUrl, caption } = params;

  console.log('[GoogleBusiness] Creating local post', { accountId, locationId });

  const url =
    `${GOOGLE_BUSINESS_API_BASE}/accounts/${accountId}/locations/${locationId}/localPosts`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      languageCode: 'en-US',
      summary: caption,
      topicType: 'STANDARD',
      media: [
        {
          mediaFormat: 'PHOTO',
          sourceUrl: imageUrl,
        },
      ],
    }),
  });

  const data = await response.json();

  console.log('[GoogleBusiness] Publish response:', data);

  if (!response.ok || !data.name) {
    throw new Error(getMetaErrorMessage(data, 'Google Business post failed'));
  }

  // data.name looks like: accounts/{accountId}/locations/{locationId}/localPosts/{postId}
  return {
    postName: data.name as string,
    searchUrl: (data.searchUrl as string) || null,
  };
}


/* =========================================================
   LINKEDIN PUBLISHING (Images API + Posts API)
   1. initializeUpload  -> uploadUrl + image URN
   2. PUT binary to uploadUrl
   3. POST /rest/posts referencing the image URN
========================================================= */

// LinkedIn "little text" treats these characters as markup; unescaped, they
// can silently truncate the post. '#' is left alone so hashtags still work.
function escapeLinkedInText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}


class LinkedInAuthError extends Error {}


async function publishToLinkedIn(params: {
  ownerUrn: string; // 'urn:li:person:abc' or 'urn:li:organization:12345'
  accessToken: string;
  imageUrl: string;
  caption: string;
}) {

  const { ownerUrn, accessToken, imageUrl, caption } = params;

  /* 1. Initialize image upload */

  console.log('[LinkedIn] Initializing image upload', { ownerUrn });

  const initRes = await fetch(
    `${LINKEDIN_REST_BASE}/images?action=initializeUpload`,
    {
      method: 'POST',
      headers: linkedinHeaders(accessToken),
      body: JSON.stringify({
        initializeUploadRequest: { owner: ownerUrn },
      }),
    }
  );

  const initData = await initRes.json().catch(() => ({}));

  console.log('[LinkedIn] Initialize upload response:', initData);

  if (initRes.status === 401) {
    throw new LinkedInAuthError('LinkedIn access token is invalid or expired');
  }

  if (!initRes.ok || !initData?.value?.uploadUrl || !initData?.value?.image) {
    throw new Error(
      getMetaErrorMessage(initData, 'LinkedIn image upload initialization failed')
    );
  }

  const uploadUrl = initData.value.uploadUrl as string;
  const imageUrn = initData.value.image as string;


  /* 2. Download banner and upload the binary */

  console.log('[LinkedIn] Downloading source image:', imageUrl);

  const imgRes = await fetch(imageUrl, { method: 'GET', cache: 'no-store' });

  if (!imgRes.ok) {
    throw new Error(
      `Could not download banner image for LinkedIn. HTTP ${imgRes.status}`
    );
  }

  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

  console.log('[LinkedIn] Uploading image binary:', imageUrn);

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: imageBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`LinkedIn image upload failed. HTTP ${uploadRes.status}`);
  }


  /* 3. Create the post (commentary max is 3000 chars) */

  console.log('[LinkedIn] Creating post with image:', imageUrn);

  const postRes = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
    method: 'POST',
    headers: linkedinHeaders(accessToken),
    body: JSON.stringify({
      author: ownerUrn,
      commentary: escapeLinkedInText((caption || '').slice(0, 3000)),
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        media: { id: imageUrn, altText: 'Product banner' },
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });

  // Success is 201 with an empty body; the post URN is in x-restli-id.
  const postData = postRes.ok ? {} : await postRes.json().catch(() => ({}));

  if (postRes.status === 401) {
    throw new LinkedInAuthError('LinkedIn access token is invalid or expired');
  }

  if (!postRes.ok) {
    console.error('[LinkedIn] Post failed:', postData);
    throw new Error(getMetaErrorMessage(postData, 'LinkedIn post failed'));
  }

  const postId = postRes.headers.get('x-restli-id');

  if (!postId) {
    throw new Error('LinkedIn did not return a post ID');
  }

  console.log('[LinkedIn] Post created:', postId);

  return {
    postId,
    imageUrn,
    permalink: `https://www.linkedin.com/feed/update/${postId}/`,
  };
}


/* =========================================================
   POST /api/banners/publish
========================================================= */

export async function POST(req: NextRequest) {

  try {

    /* AUTHENTICATION */

    let userId: number;

    try {
      userId = getUserIdFromRequest(req);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json(
          { success: false, message: error.message },
          { status: 401 }
        );
      }
      throw error;
    }


    /* REQUEST BODY */

    const body = (await req.json()) as PublishBody;
    const bannerId = body?.bannerId;

    const linkedinAuthorUrn =
      typeof body?.linkedinAuthorUrn === 'string'
        ? body.linkedinAuthorUrn.trim()
        : '';

    const platforms = Array.isArray(body?.platforms) ? body.platforms : [];

    const requestedLinkedInOwnerUrns: string[] = Array.isArray(
      body?.linkedinOwnerUrns
    )
      ? Array.from(
          new Set(
            body.linkedinOwnerUrns
              .map((u: string) => String(u).trim())
              .filter((u: string) =>
                /^urn:li:(person|organization):[A-Za-z0-9_-]+$/.test(u)
              )
          )
        )
      : [];

    // Backwards compatibility: accept the old single LinkedIn author field.
    const linkedinOwnerUrns: string[] = requestedLinkedInOwnerUrns.length > 0
      ? requestedLinkedInOwnerUrns
      : linkedinAuthorUrn &&
          /^urn:li:(person|organization):[A-Za-z0-9_-]+$/.test(linkedinAuthorUrn)
        ? [linkedinAuthorUrn]
        : [];

    // Explicit Facebook Page IDs picked by the user in the target
    // sub-picker. Empty array means "not specified" -> fall back to every
    // active connected Page for this user.
    const requestedFacebookPageIds: string[] = Array.isArray(
      body?.facebookPageIds
    )
      ? Array.from(
          new Set(
            body.facebookPageIds
              .map((id: string) => String(id).trim())
              .filter((id: string) => id.length > 0)
          )
        )
      : [];

    // Explicit Instagram business-account IDs, same idea.
    const requestedInstagramAccountIds: string[] = Array.isArray(
      body?.instagramAccountIds
    )
      ? Array.from(
          new Set(
            body.instagramAccountIds
              .map((id: string) => String(id).trim())
              .filter((id: string) => id.length > 0)
          )
        )
      : [];

    if (!bannerId) {
      return NextResponse.json(
        { success: false, message: 'bannerId is required' },
        { status: 400 }
      );
    }

    if (platforms.length === 0) {
      return NextResponse.json(
        { success: false, message: 'At least one platform is required' },
        { status: 400 }
      );
    }


    /* NORMALIZE PLATFORMS */

    const normalizedPlatforms = platforms.map((platform) =>
      String(platform).toLowerCase().trim()
    );

    const wantsInstagram = normalizedPlatforms.includes('instagram');
    const wantsFacebook = normalizedPlatforms.includes('facebook');
    const wantsWhatsapp = normalizedPlatforms.includes('whatsapp');
    const wantsGoogleBusiness = normalizedPlatforms.includes('google_business');
    const wantsLinkedin = normalizedPlatforms.includes('linkedin');
    const wantsYoutube = normalizedPlatforms.includes('youtube');

    console.log('[Publish] Request:', {
      userId,
      bannerId,
      platforms: normalizedPlatforms,
      requestedFacebookPageIds,
      requestedInstagramAccountIds,
      linkedinOwnerUrns,
    });


    /* LOAD BANNER */

    const bannerRows = await db
      .select()
      .from(banners)
      .where(eq(banners.id, Number(bannerId)))
      .limit(1);

    const banner = bannerRows[0];

    if (!banner) {
      return NextResponse.json(
        { success: false, message: 'Banner not found' },
        { status: 404 }
      );
    }

    console.log('[Publish] Banner:', banner);


    /* LOAD PRODUCT */

    let product: any = null;

    if (banner.productId) {
      const productRows = await db
        .select()
        .from(products)
        .where(eq(products.id, banner.productId))
        .limit(1);

      product = productRows[0] || null;
    }


    /* ORIGINAL IMAGE URL */

    const originalImageUrl = getPublicImageUrl(banner.imageUrl);

    console.log('[Publish] DB image URL:', banner.imageUrl);
    console.log('[Publish] FINAL public image URL:', originalImageUrl);


    /* VERIFY ORIGINAL IMAGE — required by every platform, since
       Facebook/Instagram/WhatsApp/Google Business/LinkedIn all fetch
       this URL server-side. */

    const imageCheck = await verifyPublicImage(originalImageUrl);

    if (!imageCheck.response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: 'Banner image is not publicly accessible',
          imageUrl: originalImageUrl,
          imageStatus: imageCheck.response.status,
          contentType: imageCheck.contentType,
        },
        { status: 400 }
      );
    }


    /* PREPARE INSTAGRAM IMAGE (Instagram specifically wants a JPEG) */

    let instagramImageUrl = originalImageUrl;

    if (wantsInstagram) {

      try {
        instagramImageUrl = await createInstagramJpeg(originalImageUrl, bannerId);
      } catch (error: any) {
        console.error('[Instagram] JPEG conversion failed:', error);
        return NextResponse.json(
          {
            success: false,
            message: 'Failed to prepare banner image for Instagram',
            imageUrl: originalImageUrl,
            error: error?.message || 'JPEG conversion failed',
          },
          { status: 500 }
        );
      }

      const jpegCheck = await verifyPublicImage(instagramImageUrl);

      if (!jpegCheck.response.ok) {
        return NextResponse.json(
          {
            success: false,
            message: 'Generated Instagram JPEG is not publicly accessible',
            imageUrl: instagramImageUrl,
            imageStatus: jpegCheck.response.status,
            contentType: jpegCheck.contentType,
          },
          { status: 400 }
        );
      }

      console.log('[Instagram] Generated JPEG is publicly accessible:', {
        url: instagramImageUrl,
        status: jpegCheck.response.status,
        contentType: jpegCheck.contentType,
      });
    }


    /* CAPTION */

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
          return [value];
        }
      }

      return [];
    }

    const captionParts: string[] = [];

    if (banner.caption) {
      captionParts.push(String(banner.caption));
    } else if (product?.title) {
      captionParts.push(String(product.title));
    }

    if (product?.description) {
      captionParts.push(String(product.description));
    }

    const hashtagList = toStringArray(product?.hashtags);

    if (hashtagList.length > 0) {
      const hashtagLine = hashtagList
        .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
        .join(' ');

      captionParts.push(hashtagLine);
    }

    const caption =
      captionParts.join('\n\n').trim() || 'Check out this product!';

    console.log('[Publish] Hashtags used:', hashtagList);
    console.log('[Publish] Caption:', caption);


    /* RESULT */

    const results: Record<string, any> = {};


    /* =====================================================
       INSTAGRAM — one row PER connected business account. Posts
       to every requested instagramAccountId (or every active
       account if none were specified), same aggregate
       posted/failed shape as LinkedIn.
    ===================================================== */

    if (wantsInstagram) {

      console.log('[Instagram] Looking for connections:', {
        userId,
        requestedInstagramAccountIds,
      });

      const connectionRows = await db
        .select()
        .from(instagramConnections)
        .where(eq(instagramConnections.userId, userId));

      const activeConnections = connectionRows.filter(
        (row) => row.status === 'active'
      );

      console.log('[Instagram] Active connections found:', activeConnections.length);

      if (activeConnections.length === 0) {
        results.instagram = {
          success: false,
          message: 'Instagram is not connected. Please connect Instagram first.',
          requiresInstagramConnection: true,
        };
      } else {

        // No explicit selection -> use every active connected account.
        const targetConnections =
          requestedInstagramAccountIds.length > 0
            ? activeConnections.filter((row) =>
                requestedInstagramAccountIds.includes(
                  String(row.instagramUserId)
                )
              )
            : activeConnections;

        if (targetConnections.length === 0) {
          results.instagram = {
            success: false,
            message:
              'None of the selected Instagram accounts are connected to this user.',
            requestedTargets: requestedInstagramAccountIds,
            availableTargets: activeConnections.map((row) =>
              String(row.instagramUserId)
            ),
          };
        } else {

          const posted: {
            instagramUserId: string;
            mediaId: string;
            containerId: string;
          }[] = [];
          const failedTargets: { instagramUserId: string; message: string }[] = [];

          for (const connection of targetConnections) {

            const instagramUserId = String(connection.instagramUserId || '').trim();
            const accessToken = String(connection.accessToken || '').trim();

            if (!instagramUserId || !accessToken) {
              failedTargets.push({
                instagramUserId,
                message: 'Instagram connection is missing required fields',
              });
              continue;
            }

            try {
              const instagramResult = await publishToInstagram({
                instagramUserId,
                accessToken,
                imageUrl: instagramImageUrl,
                caption,
              });

              posted.push({
                instagramUserId,
                mediaId: instagramResult.mediaId,
                containerId: instagramResult.containerId,
              });

              await recordBannerPublication({
                bannerId,
                userId,
                platform: 'instagram',
                externalId: instagramResult.mediaId,
              });

            } catch (error: any) {
              console.error(
                '[Instagram] Publishing failed for', instagramUserId, error
              );

              failedTargets.push({
                instagramUserId,
                message: error?.message || 'Instagram publishing failed',
              });
            }
          }

          results.instagram = {
            success: posted.length > 0,
            requestedTargets:
              requestedInstagramAccountIds.length > 0
                ? requestedInstagramAccountIds
                : activeConnections.map((row) => String(row.instagramUserId)),
            availableTargets: activeConnections.map((row) =>
              String(row.instagramUserId)
            ),
            posted,
            failed: failedTargets,
            mediaId: posted[0]?.mediaId,
            containerId: posted[0]?.containerId,
            message:
              posted.length > 0
                ? failedTargets.length > 0
                  ? `Posted to ${posted.length} Instagram account(s); ${failedTargets.length} failed: ${failedTargets.map((f) => f.message).join('; ')}`
                  : undefined
                : failedTargets.map((f) => f.message).join('; ') ||
                  'Instagram publishing failed',
            imageUrl: instagramImageUrl,
          };
        }
      }
    }


    /* =====================================================
       FACEBOOK — one row PER connected Page. Posts to every
       requested facebookPageId (or every active Page if none
       were specified), same aggregate posted/failed shape as
       LinkedIn/Instagram.
    ===================================================== */

    if (wantsFacebook) {

      console.log('[Facebook] Looking for connections:', {
        userId,
        requestedFacebookPageIds,
      });

      const connectionRows = await db
        .select()
        .from(facebookConnections)
        .where(eq(facebookConnections.userId, userId));

      const activeConnections = connectionRows.filter(
        (row) => row.status === 'active'
      );

      console.log('[Facebook] Active connections found:', activeConnections.length);

      if (activeConnections.length === 0) {
        results.facebook = {
          success: false,
          message: 'Facebook is not connected. Please connect Facebook first.',
          requiresFacebookConnection: true,
        };
      } else {

        // No explicit selection -> use every active connected Page.
        const targetConnections =
          requestedFacebookPageIds.length > 0
            ? activeConnections.filter((row) =>
                requestedFacebookPageIds.includes(String(row.pageId))
              )
            : activeConnections;

        if (targetConnections.length === 0) {
          results.facebook = {
            success: false,
            message:
              'None of the selected Facebook Pages are connected to this user.',
            requestedTargets: requestedFacebookPageIds,
            availableTargets: activeConnections.map((row) => String(row.pageId)),
          };
        } else {

          const posted: { pageId: string; photoId: string; postId: string }[] = [];
          const failedTargets: { pageId: string; message: string }[] = [];

          for (const connection of targetConnections) {

            const pageId = String(connection.pageId || '').trim();

            let pageAccessToken = '';

            try {
              pageAccessToken = decryptFacebookToken(
                String(connection.accessToken || '')
              );
            } catch (error) {
              console.error(
                '[Facebook] Token decryption failed for', pageId, error
              );
            }

            if (!pageId || !pageAccessToken) {
              failedTargets.push({
                pageId,
                message: 'Facebook connection is missing required fields',
              });
              continue;
            }

            try {
              const facebookResult = await publishToFacebook({
                pageId,
                pageAccessToken,
                imageUrl: originalImageUrl,
                caption,
              });

              posted.push({
                pageId,
                photoId: facebookResult.photoId,
                postId: facebookResult.postId,
              });

              await recordBannerPublication({
                bannerId,
                userId,
                platform: 'facebook',
                externalId: facebookResult.postId,
              });

              // Best-effort — don't fail the whole request if this update fails.
              try {
                await db
                  .update(facebookConnections)
                  .set({
                    lastPublishAt: new Date(),
                    lastError: null,
                  })
                  .where(
                    and(
                      eq(facebookConnections.userId, userId),
                      eq(facebookConnections.pageId, pageId)
                    )
                  );
              } catch (updateError) {
                console.error(
                  '[Facebook] Failed to update lastPublishAt for', pageId, updateError
                );
              }

            } catch (error: any) {
              console.error('[Facebook] Publishing failed for', pageId, error);

              failedTargets.push({
                pageId,
                message: error?.message || 'Facebook publishing failed',
              });

              try {
                await db
                  .update(facebookConnections)
                  .set({ lastError: error?.message || 'Facebook publishing failed' })
                  .where(
                    and(
                      eq(facebookConnections.userId, userId),
                      eq(facebookConnections.pageId, pageId)
                    )
                  );
              } catch (updateError) {
                console.error(
                  '[Facebook] Failed to update lastError for', pageId, updateError
                );
              }
            }
          }

          results.facebook = {
            success: posted.length > 0,
            requestedTargets:
              requestedFacebookPageIds.length > 0
                ? requestedFacebookPageIds
                : activeConnections.map((row) => String(row.pageId)),
            availableTargets: activeConnections.map((row) => String(row.pageId)),
            posted,
            failed: failedTargets,
            photoId: posted[0]?.photoId,
            postId: posted[0]?.postId,
            message:
              posted.length > 0
                ? failedTargets.length > 0
                  ? `Posted to ${posted.length} Facebook Page(s); ${failedTargets.length} failed: ${failedTargets.map((f) => f.message).join('; ')}`
                  : undefined
                : failedTargets.map((f) => f.message).join('; ') ||
                  'Facebook publishing failed',
            imageUrl: originalImageUrl,
          };
        }
      }
    }


    /* =====================================================
       LINKEDIN — backed by social_accounts (provider = 'linkedin').
       Posts to every author URN chosen in the picker (personal
       profile and/or company pages). Falls back to the personal
       profile when none were sent.
    ===================================================== */

    if (wantsLinkedin) {

      console.log('[LinkedIn] Looking for connection:', { userId, linkedinOwnerUrns });

      const connectionRows = await db
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.userId, userId),
            eq(socialAccounts.provider, 'linkedin')
          )
        )
        .limit(1);

      const connection = connectionRows[0];

      console.log('[LinkedIn] Connection found:', !!connection);

      if (!connection) {
        results.linkedin = {
          success: false,
          message: 'LinkedIn is not connected. Please connect LinkedIn first.',
          requiresLinkedinConnection: true,
        };
      } else if (
        connection.expiresAt &&
        new Date(connection.expiresAt).getTime() <= Date.now()
      ) {
        results.linkedin = {
          success: false,
          message: 'LinkedIn access token has expired. Please reconnect LinkedIn.',
          requiresLinkedinConnection: true,
        };
      } else {

        const metadata = parseAccountMetadata(connection.metadata);

        const providerAccountId = String(connection.providerAccountId || '').trim();

        const personalUrn = providerAccountId
          ? `urn:li:person:${providerAccountId}`
          : '';

        const storedPersonalUrn = String(
          metadata.ownerUrn || personalUrn
        ).trim();

        const storedOrganizations = Array.isArray(metadata.organizations)
          ? metadata.organizations
              .map((organization: any) => ({
                urn: String(organization?.urn || '').trim(),
                id: String(organization?.id || '').trim(),
                name: String(organization?.name || '').trim(),
              }))
              .filter(
                (organization: { urn: string }) =>
                  /^urn:li:organization:[A-Za-z0-9_-]+$/.test(organization.urn)
              )
          : [];

        // If the frontend did not explicitly select a target, default to
        // the connected member's personal LinkedIn profile.
        const targets: string[] =
          linkedinOwnerUrns.length > 0
            ? linkedinOwnerUrns
            : [storedPersonalUrn].filter(Boolean);

        // Security: a client may only publish as the connected member or
        // as an organization discovered for that member during OAuth.
        const allowedTargets = new Set<string>([
          storedPersonalUrn,
          personalUrn,
          ...storedOrganizations.map(
            (organization: { urn: string }) => organization.urn
          ),
        ].filter(Boolean));

        const unauthorizedTargets = targets.filter(
          (target) => !allowedTargets.has(target)
        );

        // Tokens in social_accounts are stored as-is (not encrypted).
        const accessToken = String(connection.accessToken || '').trim();

        if (unauthorizedTargets.length > 0) {
          results.linkedin = {
            success: false,
            message:
              `One or more selected LinkedIn targets are not authorized for this connection: ${unauthorizedTargets.join(', ')}`,
            requestedTargets: targets,
            availableTargets: [
              storedPersonalUrn,
              ...storedOrganizations.map(
                (organization: { urn: string }) => organization.urn
              ),
            ].filter(Boolean),
          };
        } else if (!accessToken || targets.length === 0) {
          results.linkedin = {
            success: false,
            message: 'LinkedIn connection is missing required fields',
            requiresLinkedinConnection: true,
          };
        } else {

          const posted: { ownerUrn: string; postId: string; permalink: string }[] = [];
          const failedTargets: { ownerUrn: string; message: string }[] = [];
          let authFailed = false;

          for (const ownerUrn of targets) {
            try {
              const linkedinResult = await publishToLinkedIn({
                ownerUrn,
                accessToken,
                imageUrl: originalImageUrl,
                caption,
              });

              posted.push({
                ownerUrn,
                postId: linkedinResult.postId,
                permalink: linkedinResult.permalink,
              });

              await recordBannerPublication({
                bannerId,
                userId,
                platform: 'linkedin',
                externalId: linkedinResult.postId,
                permalink: linkedinResult.permalink,
              });

            } catch (error: any) {
              console.error('[LinkedIn] Publishing failed for', ownerUrn, error);

              failedTargets.push({
                ownerUrn,
                message: error?.message || 'LinkedIn publishing failed',
              });

              if (error instanceof LinkedInAuthError) {
                authFailed = true;
                break; // same token for every target — no point continuing
              }
            }
          }

          results.linkedin = {
            success: posted.length > 0,
            requestedTargets: targets,
            availableTargets: [
              storedPersonalUrn,
              ...storedOrganizations.map(
                (organization: { urn: string }) => organization.urn
              ),
            ].filter(Boolean),
            posted,
            failed: failedTargets,
            postId: posted[0]?.postId,
            permalink: posted[0]?.permalink,
            message:
              posted.length > 0
                ? failedTargets.length > 0
                  ? `Posted to ${posted.length} LinkedIn account(s); ${failedTargets.length} failed: ${failedTargets.map((f) => f.message).join('; ')}`
                  : undefined
                : authFailed
                  ? 'LinkedIn session expired. Please reconnect LinkedIn.'
                  : failedTargets.map((f) => f.message).join('; ') ||
                    'LinkedIn publishing failed',
            requiresLinkedinConnection: authFailed || undefined,
            imageUrl: originalImageUrl,
          };
        }
      }
    }


    /* =====================================================
       WHATSAPP
    ===================================================== */

    if (wantsWhatsapp) {

      console.log('[WhatsApp] Looking for connection:', { userId });

      const connectionRows = await db
        .select()
        .from(whatsappConnections)
        .where(eq(whatsappConnections.userId, userId))
        .limit(1);

      const connection = connectionRows[0];

      console.log('[WhatsApp] Connection found:', !!connection);

      if (!connection) {
        results.whatsapp = {
          success: false,
          message: 'WhatsApp is not connected. Please connect WhatsApp first.',
          requiresWhatsappConnection: true,
        };
      } else if (connection.status !== 'active') {
        results.whatsapp = {
          success: false,
          message: `WhatsApp connection status is "${connection.status}". Please reconnect WhatsApp.`,
        };
      } else {

        const phoneNumberId = String(connection.phoneNumberId || '').trim();
        const accessToken = String(connection.accessToken || '').trim();

        if (!phoneNumberId || !accessToken) {
          results.whatsapp = {
            success: false,
            message: 'WhatsApp connection is missing required fields',
          };
        } else {

          console.log('[WhatsApp] Connection diagnostics:', {
            apiVersion: META_GRAPH_VERSION,
            phoneNumberId,
            accessTokenPresent: Boolean(accessToken),
            accessTokenLength: accessToken.length,
          });

          // Verify the sender before reading/sending the contact list.
          // This catches stale tokens / wrong Phone Number IDs early.
          try {
            const sender = await verifyWhatsappSender({
              phoneNumberId,
              accessToken,
            });

            console.log('[WhatsApp] Sender verified:', {
              phoneNumberId: sender.id,
              displayPhoneNumber: sender.display_phone_number || null,
              verifiedName: sender.verified_name || null,
            });
          } catch (error: any) {
            console.error('[WhatsApp] Sender verification failed:', error);

            results.whatsapp = {
              success: false,
              message:
                error?.message ||
                'WhatsApp sender verification failed. Please reconnect WhatsApp.',
              requiresWhatsappConnection: true,
            };
          }

          if (results.whatsapp) {
            // Sender validation already produced a concrete result.
            // Do not continue into broadcast logic.
          } else {
          const contactRows = await db
            .select({
              phoneNumber: whatsappContacts.phoneNumber,
              name: whatsappContacts.name,
            })
            .from(whatsappContacts)
            .where(
              and(
                eq(whatsappContacts.userId, userId),
                eq(whatsappContacts.isActive, true)
              )
            );

          console.log('[WhatsApp] Active contacts found:', contactRows.length);

          if (contactRows.length === 0) {

            // Work out WHY there are none, so the message is actionable.
            const allContacts = await db
              .select({ isActive: whatsappContacts.isActive })
              .from(whatsappContacts)
              .where(eq(whatsappContacts.userId, userId));

            console.log('[WhatsApp] Contacts for user', userId, {
              total: allContacts.length,
            });

            results.whatsapp = {
              success: false,
              message:
                allContacts.length === 0
                  ? `No WhatsApp contacts saved for this account (user ${userId}). Add contacts first.`
                  : `${allContacts.length} contact(s) found for this account, but none are active.`,
            };

          } else {

            const { sent, sentViaTemplate, failed } =
              await publishToWhatsappContacts({
                phoneNumberId,
                accessToken,
                imageUrl: originalImageUrl,
                caption,
                contacts: contactRows,
              });

            results.whatsapp = {
              success: sent.length > 0,
              sentCount: sent.length,
              failedCount: failed.length,
              sent,
              sentViaTemplate,
              failed,
              message:
                sent.length === 0
                  ? failed.map((f) => f.error).slice(0, 3).join('; ') ||
                    'WhatsApp broadcast failed'
                  : failed.length > 0
                    ? `Sent to ${sent.length} contact(s); ${failed.length} failed.`
                    : undefined,
              imageUrl: originalImageUrl,
            };

            // WhatsApp is a broadcast (no single "post"), so there's no
            // externalId to look up insights for later — intentionally
            // not recorded in bannerPublications.
          }
          }
        }
      }
    }


    /* =====================================================
       GOOGLE BUSINESS — backed by social_accounts (provider =
       'google_business'). accountId/locationId come out of the
       `metadata` JSON column.
    ===================================================== */

    if (wantsGoogleBusiness) {

      console.log('[GoogleBusiness] Looking for connection:', { userId });

      const connectionRows = await db
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.userId, userId),
            eq(socialAccounts.provider, 'google_business')
          )
        )
        .limit(1);

      const connection = connectionRows[0];

      console.log('[GoogleBusiness] Connection found:', !!connection);

      if (!connection) {
        results.google_business = {
          success: false,
          message: 'Google Business is not connected. Please connect Google Business first.',
          requiresGoogleBusinessConnection: true,
        };
      } else {

        const metadata = parseAccountMetadata((connection as any).metadata);

        const accountId =
          String(metadata.accountId || connection.providerAccountId || '').trim();
        const locationId = String(metadata.locationId || '').trim();

        // NOTE: Google OAuth access tokens expire (~1hr). This assumes
        // connection.accessToken is already fresh. If you store a
        // refreshToken (socialAccounts has one), refresh it here before
        // using it — otherwise this will start failing an hour after
        // connecting.
        const accessToken = String(connection.accessToken || '').trim();

        if (!accountId || !locationId || !accessToken) {
          results.google_business = {
            success: false,
            message: !locationId
              ? 'Google Business connection is missing a locationId in metadata. Backfill social_accounts.metadata for this user/provider.'
              : 'Google Business connection is missing required fields',
          };
        } else {

          try {
            const gbResult = await publishToGoogleBusiness({
              accountId,
              locationId,
              accessToken,
              imageUrl: originalImageUrl,
              caption,
            });

            results.google_business = {
              success: true,
              postName: gbResult.postName,
              searchUrl: gbResult.searchUrl,
              imageUrl: originalImageUrl,
            };

            await recordBannerPublication({
              bannerId,
              userId,
              platform: 'google_business',
              externalId: gbResult.postName,
              permalink: gbResult.searchUrl,
            });

          } catch (error: any) {
            console.error('[GoogleBusiness] Publishing failed:', error);

            results.google_business = {
              success: false,
              message: error?.message || 'Google Business publishing failed',
              imageUrl: originalImageUrl,
            };
          }
        }
      }
    }


    /* =====================================================
       YOUTUBE — checked against social_accounts (provider =
       'youtube'). Still reports "not supported" since the YouTube
       Data API has no endpoint for posting a static image.
    ===================================================== */

    if (wantsYoutube) {

      console.log('[YouTube] Publish requested but not supported by the public API');

      const connectionRows = await db
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.userId, userId),
            eq(socialAccounts.provider, 'youtube')
          )
        )
        .limit(1);

      const connection = connectionRows[0];

      results.youtube = {
        success: false,
        message: connection
          ? "YouTube doesn't support publishing a static image as a public post via the API. YouTube is connected for analytics only."
          : 'YouTube is not connected.',
        supported: false,
      };
    }


    /* FINAL STATUS */

    const successfulPlatforms = Object.entries(results)
      .filter(([, result]) => result?.success === true)
      .map(([platform]) => platform);

    const failedPlatforms = Object.entries(results)
      .filter(([, result]) => result?.success !== true)
      .map(([platform]) => platform);

    if (successfulPlatforms.length === 0) {

      const firstReason = Object.values(results)
        .map((r: any) => r?.message)
        .find((m) => typeof m === 'string' && m.length > 0);

      // 422: the request was valid, but nothing could be published.
      return NextResponse.json(
        {
          success: false,
          message: firstReason
            ? `No platform was successfully published: ${firstReason}`
            : 'No platform was successfully published',
          bannerId,
          results,
        },
        { status: 422 }
      );
    }


    /* MARK BANNER(S) AS POSTED */

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

      console.log('[Publish] Marked banners as posted:', {
        productId: banner.productId,
        day: banner.day,
      });
    } catch (error) {
      console.error('[Publish] Failed to mark banners as posted:', error);
    }


    /* SUCCESS */

    return NextResponse.json(
      {
        success: failedPlatforms.length === 0,
        message:
          failedPlatforms.length === 0
            ? 'Banner published successfully'
            : 'Banner partially published',
        bannerId,
        publishedPlatforms: successfulPlatforms,
        failedPlatforms,
        results,
      },
      { status: failedPlatforms.length === 0 ? 200 : 207 }
    );

  } catch (error: any) {

    console.error('[Publish] Unexpected error:', error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || 'Failed to publish banner',
        error:
          process.env.NODE_ENV === 'development'
            ? String(error?.stack || error)
            : undefined,
      },
      { status: 500 }
    );
  }
}