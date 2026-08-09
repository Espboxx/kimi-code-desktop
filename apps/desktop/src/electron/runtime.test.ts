import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import {
  applySessionCreationDefaults,
  assertExternalUrl,
  prepareConfigPatch,
  redactSecrets,
  sanitizeConfig,
  serializeError,
} from './runtime';
import { materializeReplayMedia, prepareDesktopMedia } from './media-service';

describe('desktop runtime boundary', () => {
  it('applies global defaults to new sessions without overriding explicit choices', () => {
    const config = {
      defaultModel: 'kimi-default',
      thinking: { enabled: true, effort: 'high' },
      defaultPermissionMode: 'auto',
      defaultPlanMode: true,
    };
    expect(applySessionCreationDefaults(config, {})).toEqual({
      model: 'kimi-default',
      thinking: 'high',
      permission: 'auto',
      planMode: true,
    });
    expect(applySessionCreationDefaults(config, {
      model: 'session-model',
      thinking: 'off',
      permission: 'manual',
      planMode: false,
    })).toEqual({
      model: 'session-model',
      thinking: 'off',
      permission: 'manual',
      planMode: false,
    });
    expect(applySessionCreationDefaults({ models: { fallback: {}, second: {} } }, {})).toEqual({
      model: 'fallback',
      thinking: undefined,
      permission: undefined,
      planMode: undefined,
    });
  });

  it('redacts nested credentials and removes raw config', () => {
    const value = sanitizeConfig({
      raw: { apiKey: 'raw-secret' },
      providers: {
        demo: { api_key: 'sk-secret', base_url: 'https://example.test/v1' },
      },
      nested: { accessToken: 'oauth-secret', ordinary: 'visible' },
    } as never);

    expect(value['raw']).toBeUndefined();
    expect(value).toMatchObject({
      providers: { demo: { api_key: '[configured]', base_url: 'https://example.test/v1' } },
      nested: { accessToken: '[configured]', ordinary: 'visible' },
    });
    expect(JSON.stringify(value)).not.toContain('sk-secret');
  });

  it('preserves structured Kimi errors without leaking secret details', () => {
    const error = new KimiError(ErrorCodes.SESSION_NOT_FOUND, 'Session is missing', {
      details: { sessionId: 's1', apiKey: 'sk-secret' },
    });
    expect(serializeError(error)).toMatchObject({
      code: ErrorCodes.SESSION_NOT_FOUND,
      message: 'Session is missing',
      details: { sessionId: 's1', apiKey: '[configured]' },
    });

    const sdkError = Object.assign(new Error('Capability is missing'), {
      code: 'capability.not_found',
      details: { id: 'missing', authorization: 'Bearer secret' },
    });
    expect(serializeError(sdkError)).toEqual({
      code: 'capability.not_found',
      message: 'Capability is missing',
      details: { id: 'missing', authorization: '[configured]' },
      retryable: undefined,
    });
  });

  it('keeps write-only secrets out of empty config patches', () => {
    expect(prepareConfigPatch({
      providers: {
        existing: { baseUrl: 'https://example.test/v1', apiKey: undefined },
        configured: { apiKey: '[configured]' },
        replacement: { apiKey: 'sk-new' },
      },
      defaultModel: undefined,
    })).toEqual({
      providers: {
        existing: { baseUrl: 'https://example.test/v1' },
        configured: {},
        replacement: { apiKey: 'sk-new' },
      },
    });
  });

  it('only allows safe external protocols', () => {
    expect(assertExternalUrl('https://example.test/path')).toBe('https://example.test/path');
    expect(assertExternalUrl('mailto:test@example.test')).toBe('mailto:test@example.test');
    expect(() => assertExternalUrl('http://example.test')).toThrow(/not allowed/);
    expect(() => assertExternalUrl('file:///C:/secret.txt')).toThrow(/not allowed/);
    expect(redactSecrets({ password: '' })).toEqual({});
  });

  it('converts allowed local images for the provider and caches replay bytes for rendering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-desktop-media-'));
    const workspace = join(root, 'workspace');
    const cacheDir = join(root, 'cache');
    const imagePath = join(workspace, 'pixel.png');
    const outsidePath = join(root, 'outside.png');
    await mkdir(workspace);
    await Promise.all([
      writeFile(imagePath, Buffer.from('desktop-image-fixture')),
      writeFile(outsidePath, Buffer.from('outside')),
    ]);
    try {
      const prepared = await prepareDesktopMedia(
        { type: 'image_url', url: imagePath },
        { workspaceRoot: workspace, allowedRoots: [workspace], cacheDir },
      );
      expect(prepared.url).toMatch(/^data:image\/png;base64,/);
      expect(fileURLToPath(prepared.displayUrl)).toBe(imagePath);

      const replay = await materializeReplayMedia([
        {
          type: 'message',
          time: 1,
          message: {
            role: 'user',
            content: [{ type: 'image_url', imageUrl: { url: prepared.url } }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
      ], cacheDir);
      const record = replay[0];
      expect(record?.type).toBe('message');
      if (record?.type !== 'message' || record.message.content[0]?.type !== 'image_url') {
        throw new Error('materialized replay did not contain an image');
      }
      const cachedPath = fileURLToPath(record.message.content[0].imageUrl.url);
      expect(await readFile(cachedPath, 'utf8')).toBe('desktop-image-fixture');

      await expect(prepareDesktopMedia(
        { type: 'image_url', url: outsidePath },
        { workspaceRoot: workspace, allowedRoots: [workspace], cacheDir },
      )).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
