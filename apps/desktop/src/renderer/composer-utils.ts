import type { SessionUsageSnapshot } from '../shared/desktop-api';

export const COMPOSER_HEIGHT_STORAGE_KEY = 'kimi-desktop.composer-height.v1';
export const TEAM_COMPOSER_HEIGHT_STORAGE_KEY = 'kimi-desktop.team-composer-height.v1';
export const DEFAULT_COMPOSER_HEIGHT = 112;
export const MIN_COMPOSER_HEIGHT = 64;
export const MAX_COMPOSER_HEIGHT = 360;
export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
export const COMPOSER_IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

const SUPPORTED_IMAGE_TYPES = new Set(COMPOSER_IMAGE_ACCEPT.split(','));

export interface CacheMetrics {
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly inputOther: number;
  readonly inputTotal: number;
  readonly hitRate: number;
}

export interface ComposerImageValidationError {
  readonly code: 'media.unsupported_type' | 'media.invalid_size';
  readonly message: string;
}

export interface ComposerImageAttachment {
  readonly id: string;
  readonly type: 'image_url';
  readonly url: string;
  readonly label: string;
}

export interface ComposerAttachmentError {
  readonly code: string;
  readonly message: string;
}

export type ImageInputSupport = 'supported' | 'unsupported' | 'unknown';

export function contextPercentage(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.round(ratio * 100));
}

export function contextProgress(ratio: number): number {
  return Math.min(100, contextPercentage(ratio));
}

export function cacheMetrics(usage: SessionUsageSnapshot | undefined): CacheMetrics | undefined {
  const total = usage?.total;
  if (total === undefined) return undefined;
  const inputOther = tokenCount(total.inputOther);
  const cacheRead = tokenCount(total.inputCacheRead);
  const cacheCreation = tokenCount(total.inputCacheCreation);
  const inputTotal = inputOther + cacheRead + cacheCreation;
  return {
    cacheRead,
    cacheCreation,
    inputOther,
    inputTotal,
    hitRate: inputTotal === 0 ? 0 : Math.round((cacheRead / inputTotal) * 100),
  };
}

export function formatTokenCount(value: number): string {
  const count = tokenCount(value);
  if (count >= 1024 * 1024) return `${trimDecimal(count / (1024 * 1024))}M`;
  if (count >= 1024) {
    const thousands = count / 1024;
    return `${thousands >= 100 ? Math.round(thousands) : trimDecimal(thousands)}k`;
  }
  return String(count);
}

export function composerMaxHeight(viewportHeight: number): number {
  const viewportLimit = Number.isFinite(viewportHeight)
    ? Math.floor(Math.max(0, viewportHeight) * 0.45)
    : MAX_COMPOSER_HEIGHT;
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(MAX_COMPOSER_HEIGHT, viewportLimit));
}

export function clampComposerHeight(value: number, viewportHeight: number): number {
  const height = Number.isFinite(value) ? Math.round(value) : DEFAULT_COMPOSER_HEIGHT;
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(composerMaxHeight(viewportHeight), height));
}

export function parseComposerHeight(value: string | null, viewportHeight: number): number {
  if (value === null || value.trim().length === 0) {
    return clampComposerHeight(DEFAULT_COMPOSER_HEIGHT, viewportHeight);
  }
  const parsed = Number(value);
  return clampComposerHeight(parsed, viewportHeight);
}

export function imageFileError(file: Pick<File, 'name' | 'size' | 'type'>): ComposerImageValidationError | undefined {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return { code: 'media.unsupported_type', message: `不支持的图片类型：${file.name}` };
  }
  if (file.size <= 0 || file.size > MAX_INLINE_IMAGE_BYTES) {
    return {
      code: 'media.invalid_size',
      message: `图片大小必须在 1 byte 到 ${formatTokenCount(MAX_INLINE_IMAGE_BYTES)}B 之间：${file.name}`,
    };
  }
  return undefined;
}

export async function readImageAttachment(file: File): Promise<ComposerImageAttachment> {
  const validationError = imageFileError(file);
  if (validationError !== undefined) {
    throw new MediaAttachmentError(validationError.code, validationError.message);
  }
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(`无法读取图片：${file.name}`));
    }, { once: true });
    reader.addEventListener('error', () => {
      reject(new Error(`无法读取图片：${file.name}`));
    }, { once: true });
    reader.readAsDataURL(file);
  });
  return { id: globalThis.crypto.randomUUID(), type: 'image_url', url, label: file.name };
}

export function attachmentProblem(reason: unknown): ComposerAttachmentError {
  if (reason instanceof MediaAttachmentError) return { code: reason.code, message: reason.message };
  if (reason instanceof Error) return { code: 'media.read_failed', message: reason.message };
  return { code: 'media.read_failed', message: String(reason) };
}

export function modelImageInputSupport(raw: unknown): ImageInputSupport {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown';
  const model = raw as Record<string, unknown>;
  const overrides = model['overrides'];
  const overrideCapabilities = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides)
    ? (overrides as Record<string, unknown>)['capabilities']
    : undefined;
  const capabilities = Array.isArray(overrideCapabilities) ? overrideCapabilities : model['capabilities'];
  if (!Array.isArray(capabilities)) return 'unknown';
  return capabilities.includes('image_in') ? 'supported' : 'unsupported';
}

class MediaAttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaAttachmentError';
  }
}

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function trimDecimal(value: number): string {
  const output = value.toFixed(1);
  return output.endsWith('.0') ? output.slice(0, -2) : output;
}
