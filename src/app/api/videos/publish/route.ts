import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';

import { db } from '@/db';
import {
  facebookConnections,
  instagramConnections,
  socialAccounts,
} from '@/db/schema';
import { AuthError, getUserIdFromRequest } from '@/lib/auth';
import { decryptFacebookToken } from '@/lib/facebook-token';
import { getSubscriptionAccess, subscriptionDeniedResponse } from '@/lib/subscriptionAccess';
import { LINKEDIN_REST_BASE, linkedinHeaders } from '@/lib/linkedin-targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const META_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || '/var/www/aarnexai.com/aarnexai-backend/upload';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://aarnexai.com').replace(/\/+$/, '');

type VideoPlatform = 'facebook' | 'instagram' | 'youtube' | 'linkedin';
type PlatformResult = { success: boolean; message?: string; postId?: string };

const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: FormDataEntryValue | null, label: string): string[] {
  if (value === null || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error();
    }
    return [...new Set(parsed.map((item) => item.trim()).filter(Boolean))];
  } catch {
    throw new Error(`Invalid ${label} selection.`);
  }
}

function metaError(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const record = data as Record<string, unknown>;
  const providerError = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : null;
  const message = providerError?.message ?? record.message;
  return typeof message === 'string' ? message : fallback;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json().catch(() => ({}));
  return data && typeof data === 'object' ? data as Record<string, unknown> : {};
}

async function publishFacebookVideo(
  pageId: string,
  pageToken: string,
  video: Buffer,
  caption: string,
): Promise<string> {
  const base = `https://graph.facebook.com/${META_VERSION}/${encodeURIComponent(pageId)}/video_reels`;
  const startUrl = new URL(base);
  startUrl.searchParams.set('upload_phase', 'start');
  startUrl.searchParams.set('access_token', pageToken);
  const startResponse = await fetch(startUrl, { method: 'POST', cache: 'no-store' });
  const start = await responseJson(startResponse);
  if (!startResponse.ok || !start.video_id || !start.upload_url) {
    throw new Error(metaError(start, 'Facebook video upload could not be started.'));
  }

  const uploadResponse = await fetch(String(start.upload_url), {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${pageToken}`,
      offset: '0',
      file_size: String(video.byteLength),
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(video),
    cache: 'no-store',
  });
  const upload = await responseJson(uploadResponse);
  if (!uploadResponse.ok || upload.success === false) {
    throw new Error(metaError(upload, 'Facebook video upload failed.'));
  }

  const finishUrl = new URL(base);
  finishUrl.searchParams.set('upload_phase', 'finish');
  finishUrl.searchParams.set('video_id', String(start.video_id));
  finishUrl.searchParams.set('video_state', 'PUBLISHED');
  finishUrl.searchParams.set('description', caption.slice(0, 5000));
  finishUrl.searchParams.set('access_token', pageToken);
  const finishResponse = await fetch(finishUrl, { method: 'POST', cache: 'no-store' });
  const finish = await responseJson(finishResponse);
  if (!finishResponse.ok || finish.success === false) {
    throw new Error(metaError(finish, 'Facebook could not publish the video.'));
  }
  return String(start.video_id);
}

async function publishInstagramVideo(
  instagramUserId: string,
  accessToken: string,
  videoUrl: string,
  caption: string,
): Promise<string> {
  const base = `https://graph.facebook.com/${META_VERSION}`;
  const create = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption.slice(0, 2200),
    access_token: accessToken,
  });
  const createResponse = await fetch(`${base}/${encodeURIComponent(instagramUserId)}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: create,
    cache: 'no-store',
  });
  const container = await responseJson(createResponse);
  if (!createResponse.ok || !container.id) {
    throw new Error(metaError(container, 'Instagram video upload could not be started.'));
  }

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const statusUrl = new URL(`${base}/${encodeURIComponent(String(container.id))}`);
    statusUrl.searchParams.set('fields', 'status_code,status');
    statusUrl.searchParams.set('access_token', accessToken);
    const statusResponse = await fetch(statusUrl, { cache: 'no-store' });
    const status = await responseJson(statusResponse);
    if (!statusResponse.ok) throw new Error(metaError(status, 'Could not check Instagram video status.'));
    if (status.status_code === 'FINISHED') {
      ready = true;
      break;
    }
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(
        typeof status.error_message === 'string'
          ? status.error_message
          : 'Instagram could not process this video.',
      );
    }
  }
  if (!ready) throw new Error('Instagram is still processing the video. Please try again shortly.');

  const publishResponse = await fetch(`${base}/${encodeURIComponent(instagramUserId)}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: String(container.id), access_token: accessToken }),
    cache: 'no-store',
  });
  const published = await responseJson(publishResponse);
  if (!publishResponse.ok || !published.id) {
    throw new Error(metaError(published, 'Instagram could not publish the video.'));
  }
  return String(published.id);
}

async function publishLinkedInVideo(
  ownerUrn: string,
  accessToken: string,
  video: Buffer,
  caption: string,
): Promise<string> {
  const initResponse = await fetch(`${LINKEDIN_REST_BASE}/videos?action=initializeUpload`, {
    method: 'POST',
    headers: linkedinHeaders(accessToken),
    body: JSON.stringify({
      initializeUploadRequest: { owner: ownerUrn, fileSizeBytes: video.byteLength },
    }),
  });
  const init = await responseJson(initResponse);
  const value = init.value && typeof init.value === 'object'
    ? init.value as Record<string, unknown>
    : null;
  const instructions = Array.isArray(value?.uploadInstructions)
    ? value.uploadInstructions
    : [];
  if (
    !initResponse.ok ||
    typeof value?.video !== 'string' ||
    typeof value.uploadToken !== 'string' ||
    instructions.length === 0
  ) {
    throw new Error(metaError(init, 'LinkedIn video upload could not be initialized.'));
  }

  const uploadedPartIds: string[] = [];
  for (const rawInstruction of instructions) {
    if (!rawInstruction || typeof rawInstruction !== 'object') {
      throw new Error('LinkedIn returned an invalid video upload instruction.');
    }
    const instruction = rawInstruction as Record<string, unknown>;
    const first = Number(instruction.firstByte);
    const last = Number(instruction.lastByte);
    if (
      typeof instruction.uploadUrl !== 'string' ||
      !Number.isInteger(first) ||
      !Number.isInteger(last) ||
      first < 0 ||
      last < first ||
      last >= video.byteLength
    ) {
      throw new Error('LinkedIn returned an invalid video upload instruction.');
    }
    const uploadResponse = await fetch(instruction.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${first}-${last}/${video.byteLength}`,
      },
      body: new Uint8Array(video.subarray(first, last + 1)),
      cache: 'no-store',
    });
    if (!uploadResponse.ok) throw new Error(`LinkedIn video upload failed (HTTP ${uploadResponse.status}).`);
    const partId = uploadResponse.headers.get('etag')?.replace(/^"|"$/g, '');
    if (!partId) throw new Error('LinkedIn did not return the uploaded video part identifier.');
    uploadedPartIds.push(partId);
  }

  const finalizeResponse = await fetch(`${LINKEDIN_REST_BASE}/videos?action=finalizeUpload`, {
    method: 'POST',
    headers: linkedinHeaders(accessToken),
    body: JSON.stringify({
      finalizeUploadRequest: {
        video: value.video,
        uploadToken: value.uploadToken,
        uploadedPartIds,
      },
    }),
  });
  const finalized = await responseJson(finalizeResponse);
  if (!finalizeResponse.ok) {
    throw new Error(metaError(finalized, 'LinkedIn could not finalize the video upload.'));
  }

  let videoAvailable = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const statusResponse = await fetch(
      `${LINKEDIN_REST_BASE}/videos/${encodeURIComponent(value.video)}`,
      { method: 'GET', headers: linkedinHeaders(accessToken, false), cache: 'no-store' },
    );
    const status = await responseJson(statusResponse);
    if (!statusResponse.ok) {
      throw new Error(metaError(status, 'Could not check LinkedIn video processing status.'));
    }
    if (status.status === 'AVAILABLE') {
      videoAvailable = true;
      break;
    }
    if (status.status === 'PROCESSING_FAILED') {
      throw new Error(
        typeof status.processingFailureReason === 'string'
          ? status.processingFailureReason
          : 'LinkedIn could not process this video.',
      );
    }
  }
  if (!videoAvailable) {
    throw new Error('LinkedIn is still processing the video. Please try again shortly.');
  }

  const postResponse = await fetch(`${LINKEDIN_REST_BASE}/posts`, {
    method: 'POST',
    headers: linkedinHeaders(accessToken),
    body: JSON.stringify({
      author: ownerUrn,
      commentary: caption.slice(0, 3000),
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: { media: { id: value.video, title: caption.slice(0, 200) || 'Video' } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  const post = postResponse.ok ? {} : await responseJson(postResponse);
  if (!postResponse.ok) throw new Error(metaError(post, 'LinkedIn could not publish the video.'));
  return postResponse.headers.get('x-restli-id') || postResponse.headers.get('x-linkedin-id') || value.video;
}

async function publishYouTubeVideo(
  userId: number,
  video: Buffer,
  caption: string,
): Promise<string> {
  const [connection] = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.userId, userId), eq(socialAccounts.provider, 'youtube')))
    .limit(1);
  if (!connection?.accessToken) throw new Error('YouTube is not connected.');
  const metadata = parseMetadata(connection.metadata);
  if (metadata.channelSelectionRequired === true || !metadata.channelId) {
    throw new Error('Choose a YouTube channel before publishing videos.');
  }

  let token = connection.accessToken;
  if (connection.expiresAt && connection.expiresAt.getTime() <= Date.now() + 60_000) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!connection.refreshToken || !clientId || !clientSecret) {
      throw new Error('YouTube authorization expired. Reconnect your account.');
    }
    const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: connection.refreshToken,
        grant_type: 'refresh_token',
      }),
      cache: 'no-store',
    });
    const refreshed = await responseJson(refreshResponse);
    if (!refreshResponse.ok || typeof refreshed.access_token !== 'string') {
      throw new Error('YouTube authorization expired. Reconnect your account.');
    }
    token = refreshed.access_token;
    await db.update(socialAccounts).set({
      accessToken: token,
      expiresAt: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000),
    }).where(eq(socialAccounts.id, connection.id));
  }

  const title = (caption.split(/\r?\n/)[0] || 'Video').slice(0, 100);
  const initUrl = new URL('https://www.googleapis.com/upload/youtube/v3/videos');
  initUrl.searchParams.set('uploadType', 'resumable');
  initUrl.searchParams.set('part', 'snippet,status');
  const initResponse = await fetch(initUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(video.byteLength),
    },
    body: JSON.stringify({
      snippet: { title, description: caption.slice(0, 5000), categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    }),
    cache: 'no-store',
  });
  const uploadUrl = initResponse.headers.get('location');
  const init = await responseJson(initResponse);
  if (!initResponse.ok || !uploadUrl) {
    throw new Error(metaError(init, 'YouTube video upload could not be initialized.'));
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(video.byteLength),
    },
    body: new Uint8Array(video),
    cache: 'no-store',
  });
  const uploaded = await responseJson(uploadResponse);
  if (!uploadResponse.ok || !uploaded.id) {
    throw new Error(metaError(uploaded, 'YouTube video upload failed.'));
  }
  return String(uploaded.id);
}

export async function POST(request: NextRequest) {
  let savedPath: string | null = null;
  try {
    const userId = getUserIdFromRequest(request);
    const access = await getSubscriptionAccess(userId);
    if (!access.allowed) return subscriptionDeniedResponse(access);

    const form = await request.formData();
    const file = form.get('video');
    if (!(file instanceof File)) return json({ success: false, message: 'Choose a video file.' }, 400);
    if (file.type !== 'video/mp4') {
      return json({ success: false, message: 'Choose an MP4 video to publish to social channels.' }, 400);
    }
    if (file.size < 100 * 1024 || file.size > MAX_VIDEO_BYTES) {
      return json({ success: false, message: 'Video size must be between 100 KB and 10 MB.' }, 400);
    }

    const rawPlatforms = form.get('platforms');
    let requested: unknown;
    try {
      requested = JSON.parse(String(rawPlatforms || '[]'));
    } catch {
      return json({ success: false, message: 'Invalid platform selection.' }, 400);
    }
    const allowedPlatforms: VideoPlatform[] = ['facebook', 'instagram', 'youtube', 'linkedin'];
    const platforms = Array.isArray(requested)
      ? [...new Set(requested.filter((platform): platform is VideoPlatform =>
          typeof platform === 'string' && allowedPlatforms.includes(platform as VideoPlatform)))]
      : [];
    if (!platforms.length) return json({ success: false, message: 'Select a supported video platform.' }, 400);
    const caption = typeof form.get('caption') === 'string' ? String(form.get('caption')).trim() : '';
    const requestedFacebookPageIds = parseStringArray(form.get('facebookPageIds'), 'Facebook Page');
    const requestedInstagramAccountIds = parseStringArray(form.get('instagramAccountIds'), 'Instagram account');
    const requestedLinkedinOwnerUrns = parseStringArray(form.get('linkedinOwnerUrns'), 'LinkedIn target');
    const bytes = Buffer.from(await file.arrayBuffer());

    const directory = path.join(UPLOAD_ROOT, 'products', 'videos', String(userId));
    await fs.mkdir(directory, { recursive: true });
    const filename = `${crypto.randomUUID()}.mp4`;
    savedPath = path.join(directory, filename);
    await fs.writeFile(savedPath, bytes, { flag: 'wx' });
    const publicVideoUrl = `${PUBLIC_BASE_URL}/upload/products/videos/${userId}/${filename}`;

    const results: Partial<Record<VideoPlatform, PlatformResult>> = {};
    await Promise.all(platforms.map(async (platform) => {
      try {
        if (platform === 'facebook') {
          const connections = await db.select().from(facebookConnections)
            .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.status, 'active')));
          const targets = requestedFacebookPageIds.length
            ? connections.filter((connection) => requestedFacebookPageIds.includes(String(connection.pageId)))
            : connections;
          if (!targets.length) throw new Error('No selected active Facebook Page is connected.');
          const posted = await Promise.all(targets.map(async (connection) => {
            const token = decryptFacebookToken(connection.accessToken);
            return publishFacebookVideo(String(connection.pageId), token, bytes, caption);
          }));
          results.facebook = { success: true, postId: posted.join(',') };
          return;
        }

        if (platform === 'instagram') {
          const [connection] = await db.select().from(instagramConnections)
            .where(and(eq(instagramConnections.userId, userId), eq(instagramConnections.status, 'active')))
            .limit(1);
          if (!connection) throw new Error('Instagram is not connected.');
          if (requestedInstagramAccountIds.length &&
            !requestedInstagramAccountIds.includes(connection.instagramUserId)) {
            throw new Error('The selected Instagram account is not connected.');
          }
          if (connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= Date.now()) {
            throw new Error('Instagram authorization expired. Reconnect Instagram.');
          }
          const id = await publishInstagramVideo(
            connection.instagramUserId, connection.accessToken, publicVideoUrl, caption,
          );
          results.instagram = { success: true, postId: id };
          return;
        }

        if (platform === 'youtube') {
          const id = await publishYouTubeVideo(userId, bytes, caption);
          results.youtube = { success: true, postId: id };
          return;
        }

        const [connection] = await db.select().from(socialAccounts)
          .where(and(eq(socialAccounts.userId, userId), eq(socialAccounts.provider, 'linkedin')))
          .limit(1);
        if (!connection?.accessToken) throw new Error('LinkedIn is not connected.');
        if (connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) {
          throw new Error('LinkedIn authorization expired. Reconnect LinkedIn.');
        }
        const metadata = parseMetadata(connection.metadata);
        const personalId = String(connection.providerAccountId || '').trim();
        const personalUrn = String(metadata.ownerUrn || (personalId ? `urn:li:person:${personalId}` : ''));
        const organizations = Array.isArray(metadata.organizations) ? metadata.organizations : [];
        const availableTargets = [
          ...(personalUrn ? [personalUrn] : []),
          ...organizations.flatMap((target) =>
            target && typeof target === 'object' && typeof (target as Record<string, unknown>).urn === 'string'
              ? [String((target as Record<string, unknown>).urn)]
              : []),
        ];
        const targets = requestedLinkedinOwnerUrns.length
          ? requestedLinkedinOwnerUrns.filter((target) => availableTargets.includes(target))
          : availableTargets;
        if (requestedLinkedinOwnerUrns.some((target) => !availableTargets.includes(target))) {
          throw new Error('One or more selected LinkedIn targets are not connected.');
        }
        if (!targets.length) throw new Error('No LinkedIn profile or company page is available.');
        const posted = await Promise.all(targets.map((target) =>
          publishLinkedInVideo(target, connection.accessToken!, bytes, caption)));
        results.linkedin = { success: true, postId: posted.join(',') };
      } catch (error) {
        results[platform] = {
          success: false,
          message: error instanceof Error ? error.message : `Could not publish to ${platform}.`,
        };
      }
    }));

    const succeeded = Object.values(results).filter((result) => result?.success).length;
    return json({
      success: succeeded > 0,
      results,
      message: succeeded ? 'Video publishing completed.' : 'Video could not be published to the selected platforms.',
    }, succeeded ? 200 : 502);
  } catch (error) {
    if (error instanceof AuthError) return json({ success: false, message: error.message }, 401);
    console.error('[Video Publish] Error:', error);
    return json({ success: false, message: 'Video publishing failed.' }, 500);
  } finally {
    if (savedPath) {
      await fs.unlink(savedPath).catch((error) => {
        console.error('[Video Publish] Could not remove temporary video:', error);
      });
    }
  }
}
