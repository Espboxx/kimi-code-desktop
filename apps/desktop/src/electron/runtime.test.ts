import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

const refreshWorkspaceMock = vi.hoisted(() => vi.fn());
vi.mock('./workspace-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('./workspace-service')>(),
  refreshWorkspace: refreshWorkspaceMock,
}));

import {
  applySessionCreationDefaults,
  assertExternalUrl,
  isCurrentWorkspace,
  prepareConfigPatch,
  redactSecrets,
  sanitizeConfig,
  KimiDesktopRuntime,
  serializeError,
} from './runtime';
import { materializeReplayMedia, prepareDesktopMedia } from './media-service';
import { desktopSessionSurface, TEAM_SESSION_METADATA } from '../shared/team-session';
import {
  isWorkspaceDirectory,
  readWorkspacePreferences,
  selectInitialWorkspace,
  workspacePreferencesPath,
  writeWorkspacePreferences,
} from './workspace-preferences';

describe('workspace freshness', () => {
  it('accepts only the active workspace generation', () => {
    expect(isCurrentWorkspace('D:\\workspace-a', 3, 'D:\\workspace-a', 3)).toBe(true);
    expect(isCurrentWorkspace('D:\\workspace-a', 3, 'D:\\workspace-b', 3)).toBe(false);
    expect(isCurrentWorkspace('D:\\workspace-a', 2, 'D:\\workspace-a', 3)).toBe(false);
    expect(isCurrentWorkspace('D:\\workspace-a', 3, undefined, 3)).toBe(false);
  });

  it('does not publish a stale workspace refresh after an A-to-B switch', async () => {
    type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };
    const deferred = <T>(): Deferred<T> => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((next) => { resolve = next; });
      return { promise, resolve };
    };
    const workspaceResult = (root: string, name: string, tree: readonly string[]) => ({
      workspace: {
        name,
        root,
        branch: 'HEAD',
        changedFiles: tree.length,
        isRepo: false,
        gatedMcpServers: [],
      },
      isRepo: false,
      tree,
      files: [],
    });
    const trust = { trusted: false, gatedMcpServers: [] };
    const workspaceA = await mkdtemp(join(tmpdir(), 'kimi-desktop-race-a-'));
    const workspaceB = await mkdtemp(join(tmpdir(), 'kimi-desktop-race-b-'));
    const openA = deferred<ReturnType<typeof workspaceResult>>();
    const refreshA = deferred<ReturnType<typeof workspaceResult>>();
    const openB = deferred<ReturnType<typeof workspaceResult>>();
    const refreshTrustA = deferred<typeof trust>();
    const notifications: Array<{ readonly workspace: { readonly root: string }; readonly tree: readonly string[] }> = [];
    const runtime = new KimiDesktopRuntime({
      workspaceRoot: workspaceA,
      host: {
        chooseDirectory: async () => null,
        openExternal: async () => {},
        openPath: async () => {},
        setDirtyFiles: () => {},
        resolveClose: () => {},
        rememberWorkspace: async () => {},
        notify: (notification) => {
          if (notification.type === 'workspace.changed') notifications.push(notification);
        },
      },
    });
    const harness = runtime.harness;
    const trustResults = [Promise.resolve(trust), refreshTrustA.promise, Promise.resolve(trust)];
    const refreshResults = [openA.promise, refreshA.promise, openB.promise];
    refreshWorkspaceMock.mockReset();
    refreshWorkspaceMock.mockImplementation(() => refreshResults.shift()!);
    vi.spyOn(harness, 'getWorkspaceTrustInfo').mockImplementation(async () => trustResults.shift()!);
    vi.spyOn(harness, 'listSessions').mockResolvedValue([]);
    vi.spyOn(harness, 'listPlugins').mockResolvedValue([]);
    vi.spyOn(harness, 'listCapabilities').mockResolvedValue([]);
    vi.spyOn(harness, 'listWorkspaceSkills').mockResolvedValue([]);
    (runtime as unknown as { restartWorkspaceWatcher: () => Promise<void> }).restartWorkspaceWatcher = async () => {};
    const openWorkspace = (runtime as unknown as {
      openWorkspace: (path: string, options: { remember: boolean; publish: boolean }) => Promise<void>;
    }).openWorkspace.bind(runtime);
    const refreshWorkspace = (runtime as unknown as {
      refreshWorkspace: (paths: readonly string[], root: string, generation: number) => Promise<void>;
    }).refreshWorkspace.bind(runtime);

    try {
      const openingA = openWorkspace(workspaceA, { remember: false, publish: false });
      openA.resolve(workspaceResult(workspaceA, 'A', ['a.txt']));
      await openingA;
      expect(runtime.snapshot().workspace.root).toBe(workspaceA);

      const staleRefresh = refreshWorkspace([], workspaceA, 1);
      const openingB = openWorkspace(workspaceB, { remember: false, publish: false });
      openB.resolve(workspaceResult(workspaceB, 'B', ['b.txt']));
      await openingB;
      expect(runtime.snapshot()).toMatchObject({ workspace: { root: workspaceB }, tree: ['b.txt'] });

      refreshA.resolve(workspaceResult(workspaceA, 'A', ['stale-a.txt']));
      refreshTrustA.resolve(trust);
      await staleRefresh;
      expect(runtime.snapshot()).toMatchObject({ workspace: { root: workspaceB }, tree: ['b.txt'] });
      expect(notifications.map(({ workspace, tree }) => ({ root: workspace.root, tree }))).toEqual([
        { root: workspaceA, tree: ['a.txt'] },
        { root: workspaceB, tree: ['b.txt'] },
      ]);
    } finally {
      await runtime.close();
      await Promise.all([
        rm(workspaceA, { recursive: true, force: true }),
        rm(workspaceB, { recursive: true, force: true }),
      ]);
    }
  });
});

describe('desktop runtime boundary', () => {
  it('routes Agent profession commands through the harness with the active workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kimi-desktop-profiles-work-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-desktop-profiles-home-'));
    const runtime = new KimiDesktopRuntime({
      workspaceRoot: workspace,
      homeDir,
      host: {
        chooseDirectory: async () => null,
        openExternal: async () => {},
        openPath: async () => {},
        setDirtyFiles: () => {},
        resolveClose: () => {},
        rememberWorkspace: async () => {},
        notify: () => {},
      },
    });
    const revision = 'a'.repeat(64);
    const draft = {
      name: 'reviewer',
      description: 'Reviews changes',
      prompt: 'Review the change.',
      scope: 'workspace' as const,
    };
    const descriptor = {
      id: 'workspace:reviewer',
      name: 'reviewer',
      description: 'Reviews changes',
      prompt: 'Review the change.',
      override: false,
      modelPreference: 'auto' as const,
      sourceId: 'workspace',
      scope: 'workspace' as const,
      editable: true,
      effective: true,
      revision,
    };
    const list = vi.spyOn(runtime.harness, 'listAgentProfiles').mockResolvedValue({
      profiles: [],
      diagnostics: [],
    });
    const create = vi.spyOn(runtime.harness, 'createAgentProfile').mockResolvedValue({
      profile: descriptor,
      created: true,
    });
    const update = vi.spyOn(runtime.harness, 'updateAgentProfile').mockResolvedValue({
      profile: descriptor,
    });
    const remove = vi.spyOn(runtime.harness, 'deleteAgentProfile').mockResolvedValue({
      id: 'workspace:reviewer',
      name: 'reviewer',
      scope: 'workspace',
      deleted: true,
    });

    try {
      await runtime.execute({ domain: 'profile', action: 'list', name: 'profile.list' });
      await runtime.execute({ domain: 'profile', action: 'create', name: 'profile.create', payload: draft });
      await runtime.execute({ domain: 'profile', action: 'update', name: 'profile.update', payload: { ...draft, revision } });
      await runtime.execute({ domain: 'profile', action: 'delete', name: 'profile.delete', payload: { name: draft.name, scope: draft.scope, revision } });

      expect(list).toHaveBeenCalledWith(workspace);
      expect(create).toHaveBeenCalledWith(workspace, draft);
      expect(update).toHaveBeenCalledWith(workspace, { ...draft, revision });
      expect(remove).toHaveBeenCalledWith(workspace, { name: draft.name, scope: draft.scope, revision });
    } finally {
      await runtime.close();
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(homeDir, { recursive: true, force: true }),
      ]);
    }
  });

  it('classifies explicit and live Team sessions without guessing from unrelated metadata', () => {
    expect(desktopSessionSurface(TEAM_SESSION_METADATA)).toBe('team');
    expect(desktopSessionSurface(undefined, true)).toBe('team');
    expect(desktopSessionSurface({ kimiDesktop: { surface: 'chat' } })).toBe('chat');
    expect(desktopSessionSurface({ surface: 'team' })).toBe('chat');
  });

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

  it('selects an explicit startup workspace before the remembered workspace', () => {
    expect(selectInitialWorkspace('D:\\explicit', { version: 1, lastWorkspace: 'D:\\remembered' }))
      .toBe('D:\\explicit');
    expect(selectInitialWorkspace(undefined, { version: 1, lastWorkspace: 'D:\\remembered' }))
      .toBe('D:\\remembered');
    expect(selectInitialWorkspace('   ', { version: 1 })).toBeUndefined();
  });

  it('persists and validates the last workspace without leaving temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-desktop-preferences-'));
    const path = workspacePreferencesPath(root);
    try {
      expect(await readWorkspacePreferences(path)).toEqual({ version: 1 });
      await writeWorkspacePreferences(path, 'D:\\first');
      expect(await readWorkspacePreferences(path)).toEqual({ version: 1, lastWorkspace: 'D:\\first' });
      await writeWorkspacePreferences(path, 'D:\\second');
      expect(await readWorkspacePreferences(path)).toEqual({ version: 1, lastWorkspace: 'D:\\second' });
      expect((await readdir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);

      await writeFile(path, '{"version":2,"lastWorkspace":42}', 'utf8');
      expect(await readWorkspacePreferences(path)).toEqual({ version: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts only existing directories as remembered workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-desktop-workspace-'));
    const file = join(root, 'file.txt');
    try {
      await writeFile(file, 'not a workspace', 'utf8');
      expect(await isWorkspaceDirectory(root)).toBe(true);
      expect(await isWorkspaceDirectory(file)).toBe(false);
      expect(await isWorkspaceDirectory(join(root, 'missing'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      expect(fileURLToPath(prepared.displayUrl)).toBe(await realpath(imagePath));

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
