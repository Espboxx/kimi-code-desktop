import type {
  TeamArtifactContent,
  TeamSnapshotV2,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  buildTeamSnapshotLines,
  handleTeamCommand,
  parseTeamCommand,
} from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const DOWN = '\u001B[B';
const ENTER = '\r';

const snapshot = {
  protocolVersion: 2,
  state: 'ready',
  team: {
    id: 'team-1',
    sessionId: 'session-1',
    channelId: 'general',
    leaderAgentId: 'leader-1',
    createdAt: 1,
  },
  members: [
    {
      agentId: 'agent-1',
      displayName: 'Builder',
      role: 'member',
      parentAgentId: 'leader-1',
      joinedAt: 2,
      joinedSeq: 2,
    },
  ],
  batches: [],
  tasks: [
    {
      id: 'task-1',
      taskKey: 'implementation',
      batchId: 'batch-1',
      dependsOn: [],
      delegationDepth: 0,
      agentId: 'agent-1',
      displayName: 'Builder',
      profileName: 'general',
      description: 'Implement the feature',
      promptRef: 'artifact://prompt-1',
      workspaceMode: 'isolated_write',
      validationMode: 'required',
      status: 'running',
      artifactIds: [],
      createdAt: 2,
      updatedAt: 3,
    },
  ],
  assignments: [],
  attempts: [],
  artifacts: [],
  reviews: [],
  policy: {
    maxConcurrency: 4,
    maxMembers: 16,
    maxDelegationDepth: 2,
    executionRetries: 1,
    validationRetries: 2,
  },
  scheduler: {
    status: 'running',
    activeCount: 1,
    queuedCount: 0,
    updatedAt: 3,
  },
  budget: {
    startedAt: 1,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    elapsedMs: 2_000,
  },
  integration: {
    status: 'idle',
    updatedAt: 3,
  },
  latestSeq: 7,
  latestChannelSeq: 0,
} satisfies TeamSnapshotV2;

const integrationArtifact = {
  artifact: {
    id: 'artifact-diff',
    kind: 'integration_diff',
    contentRef: 'artifact://diff',
    mediaType: 'text/x-diff',
    byteLength: 31,
    createdAt: 4,
  },
  dataBase64: Buffer.from('diff --git a/a.ts b/a.ts\n+done').toString('base64'),
} satisfies TeamArtifactContent;

interface TestPicker {
  handleInput(data: string): void;
}

interface TestComponent {
  render(width: number): string[];
}

function makeHost() {
  const session = {
    getTeamSnapshot: vi.fn(async () => snapshot),
    ensureTeam: vi.fn(async () => snapshot),
    updateTeamPolicy: vi.fn(async () => snapshot),
    pauseTeam: vi.fn(async () => snapshot),
    resumeTeam: vi.fn(async () => snapshot),
    cancelTeamTask: vi.fn(async () => snapshot),
    retryTeamTask: vi.fn(async () => snapshot),
    reassignTeamTask: vi.fn(async () => snapshot),
    sendTeamMessage: vi.fn(async () => ({ channelSeq: 3 })),
    getTeamArtifact: vi.fn(async () => integrationArtifact),
    previewTeamIntegration: vi.fn(async () => integrationArtifact),
    applyTeamIntegration: vi.fn(async () => snapshot),
    discardTeamIntegration: vi.fn(async () => snapshot),
  };
  const host = {
    state: {
      theme: currentTheme,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session,
    requireSession: () => session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

function renderedTranscript(host: SlashCommandHost): string {
  const addChild = host.state.transcriptContainer.addChild as ReturnType<typeof vi.fn>;
  const components = addChild.mock.calls.map(([component]) => component as TestComponent);
  return components.map((component) => component.render(100).join('\n')).join('\n');
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mount = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mount.mock.calls[0]?.[0] as TestPicker;
}

describe('Team slash command', () => {
  it('parses activation policy values and duration units', () => {
    expect(parseTeamCommand('start concurrency=3 members=8 tokens=12000 duration=2m')).toEqual({
      kind: 'start',
      policy: {
        maxConcurrency: 3,
        maxMembers: 8,
        maxTokens: 12_000,
        maxDurationMs: 120_000,
      },
    });
  });

  it('parses task reassignment and direct messages', () => {
    expect(parseTeamCommand('reassign implementation profile=reviewer model=kimi-test')).toEqual({
      kind: 'reassign',
      task: 'implementation',
      profileName: 'reviewer',
      model: 'kimi-test',
    });
    expect(parseTeamCommand('message Builder please validate the patch')).toEqual({
      kind: 'message',
      recipient: 'Builder',
      body: 'please validate the patch',
    });
  });

  it('renders scheduler, budget, and task state', async () => {
    const { host } = makeHost();

    await handleTeamCommand(host, 'status');

    expect(renderedTranscript(host)).toContain('Scheduler');
    expect(renderedTranscript(host)).toContain('150 tokens');
    expect(renderedTranscript(host)).toContain('[running] implementation');
  });

  it('pauses scheduling with optimistic concurrency', async () => {
    const { host, session } = makeHost();

    await handleTeamCommand(host, 'pause inspect validation');

    expect(session.pauseTeam).toHaveBeenCalledWith({
      expectedSeq: 7,
      reason: 'inspect validation',
    });
  });

  it('resolves a display name to a direct-message recipient', async () => {
    const { host, session } = makeHost();

    await handleTeamCommand(host, 'message Builder ready for review');

    expect(session.sendTeamMessage).toHaveBeenCalledWith({
      body: 'ready for review',
      clientMessageId: expect.any(String),
      recipientAgentIds: ['agent-1'],
    });
  });

  it('previews and explicitly confirms the aggregate apply', async () => {
    const { host, session } = makeHost();

    const pending = handleTeamCommand(host, 'apply');
    await vi.waitFor(() => { expect(host.mountEditorReplacement).toHaveBeenCalledOnce(); });
    mountedPicker(host).handleInput(DOWN);
    mountedPicker(host).handleInput(ENTER);
    await pending;

    expect(renderedTranscript(host)).toContain('diff --git a/a.ts b/a.ts');
    expect(session.applyTeamIntegration).toHaveBeenCalledWith({ expectedSeq: 7 });
    expect(host.showStatus).toHaveBeenCalledWith('Team integration applied to the workspace.');
  });

  it('keeps the workspace unchanged when aggregate apply is cancelled', async () => {
    const { host, session } = makeHost();

    const pending = handleTeamCommand(host, 'apply');
    await vi.waitFor(() => { expect(host.mountEditorReplacement).toHaveBeenCalledOnce(); });
    mountedPicker(host).handleInput(ENTER);
    await pending;

    expect(session.applyTeamIntegration).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Team integration was not applied.');
  });

  it('reports invalid policy input through the command host', async () => {
    const { host } = makeHost();

    await handleTeamCommand(host, 'policy concurrency=zero');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('concurrency must be a positive integer'),
    );
  });
});

describe('buildTeamSnapshotLines', () => {
  it('labels legacy Team snapshots as read-only', () => {
    expect(buildTeamSnapshotLines({
      protocolVersion: 1,
      state: 'legacy_readonly',
      members: [],
      batches: [],
      assignments: [],
      latestSeq: 0,
      latestChannelSeq: 0,
    })).toContain('Protocol  v1 legacy read-only');
  });
});
