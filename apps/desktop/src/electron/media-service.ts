import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentReplayRecord, ContextMessage } from '@moonshot-ai/kimi-code-sdk';

export interface DesktopMediaInput {
  readonly type: 'image_url' | 'video_url';
  readonly url: string;
  readonly displayUrl: string;
  readonly name?: string;
}

interface PrepareDesktopMediaOptions {
  readonly workspaceRoot: string;
  readonly allowedRoots: readonly string[];
  readonly cacheDir: string;
}

const MAX_INLINE_MEDIA_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export async function prepareDesktopMedia(
  input: { readonly type: DesktopMediaInput['type']; readonly url: string; readonly name?: string },
  options: PrepareDesktopMediaOptions,
): Promise<DesktopMediaInput> {
  const value = input.url.trim();
  if (value.length === 0) throw new Error('Media URL or path must not be empty');

  if (isAbsolute(value)) {
    return prepareLocalMedia(input, value, options.allowedRoots);
  }

  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    return prepareLocalMedia(input, resolve(options.workspaceRoot, value), options.allowedRoots);
  }

  if (url.protocol === 'file:') {
    return prepareLocalMedia(input, fileURLToPath(url), options.allowedRoots);
  }
  if (url.protocol === 'data:') {
    const decoded = decodeInlineMedia(value, input.type);
    const displayUrl = await cacheMediaBytes(decoded.bytes, decoded.mimeType, options.cacheDir);
    return { ...input, url: value, displayUrl };
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) {
    return { ...input, url: url.href, displayUrl: url.href };
  }
  throw new Error(`Media protocol is not allowed: ${url.protocol}`);
}

export async function materializeReplayMedia(
  records: readonly AgentReplayRecord[],
  cacheDir: string,
): Promise<readonly AgentReplayRecord[]> {
  return Promise.all(records.map(async (record) => {
    if (record.type !== 'message') return record;
    const content = await Promise.all(record.message.content.map(async (part) => {
      const media = mediaPart(part);
      if (media === undefined || !media.url.startsWith('data:')) return part;
      try {
        const decoded = decodeInlineMedia(media.url, media.type);
        const url = await cacheMediaBytes(decoded.bytes, decoded.mimeType, cacheDir);
        if (part.type === 'image_url') return { ...part, imageUrl: { ...part.imageUrl, url } };
        if (part.type === 'audio_url') return { ...part, audioUrl: { ...part.audioUrl, url } };
        if (part.type === 'video_url') return { ...part, videoUrl: { ...part.videoUrl, url } };
        return part;
      } catch {
        return part;
      }
    }));
    return {
      ...record,
      message: { ...record.message, content } as ContextMessage,
    } as AgentReplayRecord;
  }));
}

export async function resolveAllowedPath(
  input: string,
  allowedRoots: readonly string[],
): Promise<string> {
  const target = await realpath(resolve(input));
  const roots = await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await realpath(resolve(root));
    } catch {
      return undefined;
    }
  }));
  if (!roots.some((root) => root !== undefined && isInside(root, target))) {
    throw new Error('Path is outside the workspace, additional directories, and Kimi Code home');
  }
  return target;
}

async function prepareLocalMedia(
  media: { readonly type: DesktopMediaInput['type']; readonly name?: string },
  inputPath: string,
  allowedRoots: readonly string[],
): Promise<DesktopMediaInput> {
  const path = await resolveAllowedPath(inputPath, allowedRoots);
  const displayUrl = pathToFileURL(path).href;
  if (media.type === 'video_url') return { ...media, url: displayUrl, displayUrl };

  const mimeType = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (mimeType === undefined) {
    throw new Error(`Unsupported image type: ${basename(path)}`);
  }
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > MAX_INLINE_MEDIA_BYTES) {
    throw new Error(`Image size must be between 1 byte and ${String(MAX_INLINE_MEDIA_BYTES)} bytes`);
  }
  return {
    ...media,
    url: `data:${mimeType};base64,${bytes.toString('base64')}`,
    displayUrl,
  };
}

function decodeInlineMedia(
  value: string,
  expectedType: 'image_url' | 'video_url' | 'audio_url',
): { readonly mimeType: string; readonly bytes: Buffer } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (match === null) throw new Error('Media data URL must be base64 encoded');
  const mimeType = match[1]!.toLowerCase();
  const expectedPrefix = expectedType === 'image_url'
    ? 'image/'
    : expectedType === 'video_url'
      ? 'video/'
      : 'audio/';
  if (!mimeType.startsWith(expectedPrefix)) {
    throw new Error(`Media type ${mimeType} does not match ${expectedType}`);
  }
  const encoded = match[2]!.replaceAll(/\s/g, '');
  if (encoded.length > Math.ceil(MAX_INLINE_MEDIA_BYTES / 3) * 4 + 4) {
    throw new Error('Inline media is too large');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_INLINE_MEDIA_BYTES) {
    throw new Error('Inline media is empty or too large');
  }
  return { mimeType, bytes };
}

async function cacheMediaBytes(bytes: Buffer, mimeType: string, cacheDir: string): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const extension = EXTENSION_BY_MIME[mimeType] ?? 'bin';
  const target = join(cacheDir, `${digest}.${extension}`);
  await mkdir(cacheDir, { recursive: true });
  try {
    await realpath(target);
  } catch {
    const temporary = join(cacheDir, `.${digest}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      try {
        await realpath(target);
      } catch {
        throw error;
      }
    }
  }
  return pathToFileURL(target).href;
}

function mediaPart(part: ContextMessage['content'][number]): {
  readonly type: 'image_url' | 'video_url' | 'audio_url';
  readonly url: string;
} | undefined {
  if (part.type === 'image_url') return { type: part.type, url: part.imageUrl.url };
  if (part.type === 'video_url') return { type: part.type, url: part.videoUrl.url };
  if (part.type === 'audio_url') return { type: part.type, url: part.audioUrl.url };
  return undefined;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
