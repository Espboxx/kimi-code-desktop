/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises the session-creation and plugin-manifest schemas directly with no
 * external collaborators. Run with `pnpm --filter @moonshot-ai/klient exec
 * vitest run test/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { pluginManifestSchema } from '../src/contract/global/plugins.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';
import { todoItemsSchema } from '../src/contract/session/todo.js';
import { teamOperationSchema, teamSnapshotSchema } from '../src/contract/session/collaboration.js';

type McpTimeoutField = 'startupTimeoutMs' | 'toolTimeoutMs';

const timeoutCases = [
  {
    surface: 'plugin manifests',
    parse: (field: McpTimeoutField, value: number) =>
      pluginManifestSchema.safeParse({
        name: 'example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
].flatMap(({ surface, parse }) => [
  { surface, field: 'startupTimeoutMs' as const, parse },
  { surface, field: 'toolTimeoutMs' as const, parse },
]);

describe('MCP timeout contract validation', () => {
  it.each(timeoutCases)('accepts the maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_647).success).toBe(true);
  });

  it.each(timeoutCases)('rejects an above-maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_648).success).toBe(false);
  });

  it('session creation options accept ephemeral mcpServers', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        stdioExample: { transport: 'stdio', command: 'node', args: ['server.mjs'] },
        httpExample: { transport: 'http', url: 'https://example.com/mcp', headers: { a: 'b' } },
        sseExample: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpServers?.['stdioExample']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
  });

  it('session creation options reject malformed mcpServers entries', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        example: { transport: 'http', url: 'not-a-url' },
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('TodoList contract validation', () => {
  it('accepts the three public statuses and rejects blank titles', () => {
    expect(todoItemsSchema.safeParse([
      { title: 'Run tests', status: 'pending' },
      { title: 'Inspect output', status: 'in_progress' },
      { title: 'Commit', status: 'done' },
    ]).success).toBe(true);
    expect(todoItemsSchema.safeParse([{ title: '', status: 'pending' }]).success).toBe(false);
    expect(todoItemsSchema.safeParse([{ title: 'x', status: 'blocked' }]).success).toBe(false);
  });
});

describe('Team collaboration contract validation', () => {
  it('accepts versioned operations and rejects unknown fields or versions', () => {
    const snapshot = {
      state: 'ready', members: [], batches: [], assignments: [], latestSeq: 0, latestChannelSeq: 0,
    };
    expect(teamSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(teamSnapshotSchema.safeParse({ ...snapshot, secret: 'leak' }).success).toBe(false);

    const operation = {
      version: 1, type: 'team.created', seq: 1, at: 1,
      team: { id: 'team-1', sessionId: 's1', channelId: 'general', leaderAgentId: 'main', createdAt: 1 },
    };
    expect(teamOperationSchema.safeParse(operation).success).toBe(true);
    expect(teamOperationSchema.safeParse({ ...operation, version: 2 }).success).toBe(false);
  });
});
