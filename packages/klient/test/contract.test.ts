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
  const team = {
    id: 'team-1',
    sessionId: 's1',
    channelId: 'general',
    leaderAgentId: 'main',
    createdAt: 1,
  } as const;
  const policy = {
    maxConcurrency: 4,
    maxMembers: 16,
    maxDelegationDepth: 2,
    executionRetries: 1,
    validationRetries: 2,
  } as const;
  const scheduler = {
    status: 'running',
    activeCount: 0,
    queuedCount: 0,
    updatedAt: 1,
  } as const;
  const budget = {
    startedAt: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    elapsedMs: 0,
  } as const;
  const integration = { status: 'idle', updatedAt: 1 } as const;

  it('accepts both legacy read-only and v2 snapshots', () => {
    const legacySnapshot = {
      protocolVersion: 1,
      state: 'legacy_readonly',
      team,
      members: [],
      batches: [],
      assignments: [],
      latestSeq: 0,
      latestChannelSeq: 0,
    };
    const v2Snapshot = {
      protocolVersion: 2,
      state: 'ready',
      team,
      members: [],
      batches: [],
      tasks: [],
      assignments: [],
      attempts: [],
      artifacts: [],
      reviews: [],
      policy,
      scheduler,
      budget,
      integration,
      latestSeq: 1,
      latestChannelSeq: 0,
    };

    expect(teamSnapshotSchema.safeParse(legacySnapshot).success).toBe(true);
    expect(teamSnapshotSchema.safeParse(v2Snapshot).success).toBe(true);
  });

  it('rejects reserved member names and unknown snapshot fields', () => {
    const snapshot = {
      protocolVersion: 1,
      state: 'legacy_readonly',
      members: [{
        agentId: 'agent-2',
        displayName: '界面侦察',
        role: 'member',
        joinedAt: 1,
        joinedSeq: 1,
      }],
      batches: [],
      assignments: [],
      latestSeq: 0,
      latestChannelSeq: 0,
    };

    expect(teamSnapshotSchema.safeParse({
      ...snapshot,
      members: [{ ...snapshot.members[0], displayName: 'agent-2' }],
    }).success).toBe(false);
    expect(teamSnapshotSchema.safeParse({ ...snapshot, secret: 'leak' }).success).toBe(false);
  });

  it('accepts v1 and v2 operations and rejects unknown versions', () => {
    const legacyOperation = {
      version: 1, type: 'team.created', seq: 1, at: 1,
      team,
    };
    const operationV2 = {
      version: 2,
      type: 'team.created',
      seq: 1,
      at: 1,
      operationId: 'op-1',
      team,
      policy,
      scheduler,
      budget,
      integration,
    };

    expect(teamOperationSchema.safeParse(legacyOperation).success).toBe(true);
    expect(teamOperationSchema.safeParse(operationV2).success).toBe(true);
    expect(teamOperationSchema.safeParse({ ...legacyOperation, version: 3 }).success).toBe(false);
  });
});
