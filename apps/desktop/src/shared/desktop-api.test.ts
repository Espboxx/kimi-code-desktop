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
});
