import { describe, expect, it, vi } from 'vitest';

import { createKimiDesktopApi, type DesktopDomain } from './desktop-api';
import { parseDesktopCommand } from './desktop-command-schema';

describe('desktop IPC schema', () => {
  it('accepts a validated historical fork command', () => {
    expect(parseDesktopCommand({
      domain: 'session',
      action: 'fork',
      payload: { sessionId: 'source', turnIndex: 2, title: 'branch' },
    })).toMatchObject({ name: 'session.fork', payload: { sessionId: 'source', turnIndex: 2 } });
  });

  it('rejects unknown commands and unexpected fields', () => {
    expect(() => parseDesktopCommand({ domain: 'session', action: 'missing' })).toThrow(/Unknown desktop command/);
    expect(() => parseDesktopCommand({
      domain: 'session', action: 'resume', payload: { sessionId: 's', injected: true },
    })).toThrow();
  });

  it('rejects invalid turn indexes before they reach the SDK', () => {
    expect(() => parseDesktopCommand({
      domain: 'session', action: 'fork', payload: { sessionId: 's', turnIndex: -1 },
    })).toThrow();
    expect(() => parseDesktopCommand({
      domain: 'session', action: 'fork', payload: { sessionId: 's', turnIndex: 1.5 },
    })).toThrow();
  });

  it('keeps renderer methods inside their fixed command domains', async () => {
    const calls = vi.fn();
    const invoke: Parameters<typeof createKimiDesktopApi>[0] = async <T>(domain: DesktopDomain, action: string, payload?: unknown) => {
      calls(domain, action, payload);
      return undefined as T;
    };
    const api = createKimiDesktopApi(invoke, () => () => undefined);
    await api.turn.cancel('s1');
    expect(calls).toHaveBeenCalledWith('turn', 'cancel', { sessionId: 's1' });
    await api.workspace.writeFile('src/main.ts', 'next', 'version-1', false, true);
    expect(calls).toHaveBeenCalledWith('workspace', 'writeFile', {
      path: 'src/main.ts', content: 'next', expectedVersion: 'version-1', force: false, bom: true,
    });
  });

  it('validates file, diff, and close-coordination payloads', () => {
    expect(parseDesktopCommand({
      domain: 'workspace', action: 'readDiff', payload: { path: 'src/a.ts', area: 'staged' },
    })).toMatchObject({ name: 'workspace.readDiff' });
    expect(() => parseDesktopCommand({
      domain: 'workspace', action: 'writeFile', payload: { path: '../outside', content: '', expectedVersion: '' },
    })).toThrow();
    expect(() => parseDesktopCommand({
      domain: 'host', action: 'resolveClose', payload: { requestId: 'r1', action: 'discard' },
    })).toThrow();
  });

  it('validates TodoList replacement payloads in the task domain', async () => {
    const payload = {
      sessionId: 's1',
      expected: [{ title: 'Inspect', status: 'pending' }],
      todos: [{ title: 'Inspect', status: 'in_progress' }],
    } as const;
    expect(parseDesktopCommand({ domain: 'task', action: 'replaceTodos', payload })).toMatchObject({
      name: 'task.replaceTodos',
      payload,
    });
    expect(() => parseDesktopCommand({
      domain: 'task',
      action: 'replaceTodos',
      payload: { ...payload, todos: [{ title: ' ', status: 'pending' }] },
    })).toThrow();

    const calls = vi.fn();
    const invoke: Parameters<typeof createKimiDesktopApi>[0] = async <T>(
      domain: DesktopDomain,
      action: string,
      commandPayload?: unknown,
    ) => {
      calls(domain, action, commandPayload);
      return undefined as T;
    };
    const api = createKimiDesktopApi(invoke, () => () => undefined);
    await api.task.replaceTodos(payload.expected, payload.todos, 's1');
    expect(calls).toHaveBeenCalledWith('task', 'replaceTodos', payload);
  });

  it('validates Team commands and preserves the retry idempotency key', async () => {
    expect(parseDesktopCommand({
      domain: 'session',
      action: 'create',
      payload: { surface: 'team', permission: 'yolo' },
    })).toMatchObject({ name: 'session.create', payload: { surface: 'team', permission: 'yolo' } });
    expect(parseDesktopCommand({
      domain: 'team',
      action: 'ensure',
      payload: { sessionId: 's1' },
    })).toMatchObject({ name: 'team.ensure' });
    expect(parseDesktopCommand({
      domain: 'team',
      action: 'operations',
      payload: { sessionId: 's1', afterSeq: 12, limit: 200 },
    })).toMatchObject({ name: 'team.operations' });
    expect(() => parseDesktopCommand({
      domain: 'team',
      action: 'send',
      payload: { sessionId: 's1', body: 'x'.repeat(8_193), clientMessageId: 'retry-1' },
    })).toThrow();

    const calls = vi.fn();
    const invoke: Parameters<typeof createKimiDesktopApi>[0] = async <T>(
      domain: DesktopDomain,
      action: string,
      payload?: unknown,
    ) => {
      calls(domain, action, payload);
      return undefined as T;
    };
    const api = createKimiDesktopApi(invoke, () => () => undefined);
    await api.team.ensure('s1');
    expect(calls).toHaveBeenCalledWith('team', 'ensure', { sessionId: 's1' });
    await api.team.send('s1', 'Coordinate', 'retry-1');
    expect(calls).toHaveBeenCalledWith('team', 'send', {
      sessionId: 's1', body: 'Coordinate', clientMessageId: 'retry-1',
    });
    await api.team.submit('s1', 'Coordinate', 'retry-2');
    expect(calls).toHaveBeenCalledWith('team', 'submit', {
      sessionId: 's1', body: 'Coordinate', clientMessageId: 'retry-2',
    });
  });

  it('validates and routes structured Agent profession management commands', async () => {
    const draft = {
      name: 'code-reviewer',
      description: 'Reviews implementation quality',
      whenToUse: 'Use before merging.',
      prompt: 'Review the implementation and report concrete risks.',
      scope: 'workspace' as const,
      override: false,
      tools: ['Read', 'Grep'],
      modelPreference: 'secondary' as const,
    };
    const revision = 'a'.repeat(64);
    expect(parseDesktopCommand({ domain: 'profile', action: 'create', payload: draft }))
      .toMatchObject({ name: 'profile.create', payload: draft });
    expect(parseDesktopCommand({
      domain: 'profile', action: 'update', payload: { ...draft, revision },
    })).toMatchObject({ name: 'profile.update' });
    expect(parseDesktopCommand({
      domain: 'profile',
      action: 'delete',
      payload: { name: draft.name, scope: draft.scope, revision },
    })).toMatchObject({ name: 'profile.delete' });
    expect(() => parseDesktopCommand({
      domain: 'profile', action: 'create', payload: { ...draft, name: '../reviewer' },
    })).toThrow();
    expect(() => parseDesktopCommand({
      domain: 'profile', action: 'update', payload: { ...draft, revision: 'stale' },
    })).toThrow();

    const calls = vi.fn();
    const invoke: Parameters<typeof createKimiDesktopApi>[0] = async <T>(
      domain: DesktopDomain,
      action: string,
      payload?: unknown,
    ) => {
      calls(domain, action, payload);
      return undefined as T;
    };
    const api = createKimiDesktopApi(invoke, () => () => undefined);
    await api.profile.list();
    await api.profile.create(draft);
    await api.profile.update({ ...draft, revision });
    await api.profile.delete({ name: draft.name, scope: draft.scope, revision });
    expect(calls.mock.calls).toEqual([
      ['profile', 'list', undefined],
      ['profile', 'create', draft],
      ['profile', 'update', { ...draft, revision }],
      ['profile', 'delete', { name: draft.name, scope: draft.scope, revision }],
    ]);
  });
});
