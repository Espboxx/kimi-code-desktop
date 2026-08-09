import type { AgentReplayRecord, Event, ResumedAgentState } from '@moonshot-ai/kimi-code-sdk';
import { TranscriptStore } from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import { DesktopTranscriptProjector } from './transcript-projector';

describe('DesktopTranscriptProjector', () => {
  it('links mutating TodoList frames to the current Todo document', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    const events = [
      { type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin: { kind: 'user' }, prompt: 'Plan' },
      { type: 'turn.step.started', sessionId: 's1', agentId: 'main', turnId: 1, step: 1, stepId: 'step-1' },
      {
        type: 'tool.call.started', sessionId: 's1', agentId: 'main', turnId: 1,
        toolCallId: 'todo-call', name: 'TodoList',
        args: JSON.stringify({ todos: [{ title: 'Run tests', status: 'pending' }] }),
      },
    ] as unknown as readonly Event[];

    for (const event of events) transcript.apply(projector.map(event));

    expect(transcript.getTurn('t1')?.steps[0]?.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', name: 'TodoList', todoId: 'todo' }),
    ]));
  });

  it('projects ordered streaming text and tool lifecycle events', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    const events = [
      { type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin: { kind: 'user' }, prompt: 'Inspect app.ts' },
      { type: 'turn.step.started', sessionId: 's1', agentId: 'main', turnId: 1, step: 1, stepId: 'step-1' },
      { type: 'thinking.delta', sessionId: 's1', agentId: 'main', turnId: 1, delta: 'Check ' },
      { type: 'thinking.delta', sessionId: 's1', agentId: 'main', turnId: 1, delta: 'types' },
      { type: 'assistant.delta', sessionId: 's1', agentId: 'main', turnId: 1, delta: 'Found ' },
      { type: 'assistant.delta', sessionId: 's1', agentId: 'main', turnId: 1, delta: 'it.' },
      { type: 'tool.call.started', sessionId: 's1', agentId: 'main', turnId: 1, toolCallId: 'call-1', name: 'ReadFile', args: '{"path":"app.ts"}' },
      { type: 'tool.result', sessionId: 's1', agentId: 'main', turnId: 1, toolCallId: 'call-1', output: 'source', isError: false },
      { type: 'turn.step.completed', sessionId: 's1', agentId: 'main', turnId: 1, step: 1, stepId: 'step-1', finishReason: 'stop' },
      { type: 'turn.ended', sessionId: 's1', agentId: 'main', turnId: 1, reason: 'completed', durationMs: 42 },
    ] as unknown as readonly Event[];

    for (const event of events) expect(transcript.apply(projector.map(event)).gap).toBeUndefined();

    const turn = transcript.getTurn('t1');
    const frames = turn?.steps.flatMap((step) => step.frames) ?? [];
    expect(turn).toMatchObject({ prompt: 'Inspect app.ts', state: 'completed', durationMs: 42 });
    expect(frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'thinking', text: 'Check types' }),
      expect.objectContaining({ kind: 'text', text: 'Found it.' }),
      expect.objectContaining({ kind: 'tool', name: 'ReadFile', state: 'done', output: 'source' }),
    ]));
  });

  it('emits no repeated frame upserts after a streaming tool call is visible', () => {
    const projector = new DesktopTranscriptProjector('main');
    projector.map({
      type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1,
      origin: { kind: 'user' }, prompt: 'Write a file',
    } as unknown as Event);
    projector.map({
      type: 'turn.step.started', sessionId: 's1', agentId: 'main', turnId: 1,
      step: 1, stepId: 'step-1',
    } as unknown as Event);

    const first = projector.map({
      type: 'tool.call.delta', sessionId: 's1', agentId: 'main', turnId: 1,
      toolCallId: 'call-1', name: 'Write', argumentsPart: '{"path":',
    } as unknown as Event);
    const second = projector.map({
      type: 'tool.call.delta', sessionId: 's1', agentId: 'main', turnId: 1,
      toolCallId: 'call-1', name: 'Write', argumentsPart: '"sample.txt"}',
    } as unknown as Event);

    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'frame.upsert' })]));
    expect(second).toEqual([]);
  });

  it('publishes authoritative parsed input when streamed tool arguments finish', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    const events = [
      { type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin: { kind: 'user' }, prompt: 'Write a file' },
      { type: 'turn.step.started', sessionId: 's1', agentId: 'main', turnId: 1, step: 1, stepId: 'step-1' },
      { type: 'tool.call.delta', sessionId: 's1', agentId: 'main', turnId: 1, toolCallId: 'call-1', name: 'Write', argumentsPart: '{"path":' },
      { type: 'tool.call.delta', sessionId: 's1', agentId: 'main', turnId: 1, toolCallId: 'call-1', name: 'Write', argumentsPart: '"sample.txt"}' },
      { type: 'tool.call.started', sessionId: 's1', agentId: 'main', turnId: 1, toolCallId: 'call-1', name: 'Write', args: '{"path":"sample.txt","content":"hello"}' },
    ] as unknown as readonly Event[];

    for (const event of events) transcript.apply(projector.map(event));

    const frame = transcript.getTurn('t1')?.steps[0]?.frames[0];
    expect(frame).toMatchObject({
      kind: 'tool',
      input: { path: 'sample.txt', content: 'hello' },
    });
    expect(frame).not.toHaveProperty('inputText');
  });

  it('attaches submitted media to the matching live turn', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    projector.queuePromptInput('Inspect image', [{
      type: 'image_url',
      url: 'data:image/png;base64,AAAA',
      displayUrl: 'https://example.test/pixel.png',
    }]);

    const started = {
      type: 'turn.started',
      sessionId: 's1',
      agentId: 'main',
      turnId: 1,
      origin: { kind: 'user' },
      prompt: 'Inspect image',
    } as unknown as Event;
    const ended = {
      type: 'turn.ended',
      sessionId: 's1',
      agentId: 'main',
      turnId: 1,
      reason: 'completed',
    } as unknown as Event;
    expect(transcript.apply(projector.map(started)).gap).toBeUndefined();
    expect(transcript.apply(projector.map(ended)).gap).toBeUndefined();

    const turn = transcript.getTurn('t1');
    expect(turn?.state).toBe('completed');
    expect(turn?.attachmentIds).toHaveLength(1);
    expect(transcript.getAttachment(turn!.attachmentIds![0]!)).toMatchObject({
      mediaType: 'image/png',
      source: { kind: 'url', url: 'https://example.test/pixel.png' },
    });
  });

  it('attaches a spawned Agent when the parent tool frame arrives later', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    const events = [
      {
        type: 'subagent.spawned', sessionId: 's1', agentId: 'main', subagentId: 'agent-1',
        subagentName: 'explore', parentToolCallId: 'swarm-call', swarmIndex: 1,
        runInBackground: false,
      },
      { type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin: { kind: 'user' }, prompt: 'Inspect' },
      { type: 'turn.step.started', sessionId: 's1', agentId: 'main', turnId: 1, step: 1, stepId: 'step-1' },
      {
        type: 'tool.call.started', sessionId: 's1', agentId: 'main', turnId: 1,
        toolCallId: 'swarm-call', name: 'AgentSwarm', args: '{}',
      },
    ] as unknown as readonly Event[];

    for (const event of events) expect(transcript.apply(projector.map(event)).gap).toBeUndefined();

    const frame = transcript.getTurn('t1')?.steps[0]?.frames[0];
    expect(frame).toMatchObject({
      kind: 'tool',
      toolCallId: 'swarm-call',
      view: 'swarm',
      taskId: 'agent-agent-1',
      agentRefs: [{ agentId: 'agent-1', role: 'member' }],
    });
  });

  it('keeps compaction phases and activations as independent ordered timeline markers', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    const events = [
      { type: 'compaction.started', sessionId: 's1', agentId: 'main', trigger: 'manual' },
      { type: 'compaction.blocked', sessionId: 's1', agentId: 'main', turnId: 2 },
      { type: 'skill.activated', sessionId: 's1', agentId: 'main', activationId: 'skill-1', skillName: 'brainstorming', trigger: 'user-slash' },
      { type: 'plugin_command.activated', sessionId: 's1', agentId: 'main', activationId: 'plugin-1', pluginId: 'example', commandName: 'review', trigger: 'user-slash' },
      {
        type: 'compaction.completed', sessionId: 's1', agentId: 'main',
        result: { summary: 'Compact summary', compactedCount: 2, tokensBefore: 100, tokensAfter: 20 },
      },
    ] as unknown as readonly Event[];

    for (const event of events) expect(transcript.apply(projector.map(event)).gap).toBeUndefined();

    expect(transcript.getItems().map((item) => item.kind === 'marker'
      ? { marker: item.marker, payload: item.payload }
      : { marker: item.kind, payload: undefined })).toEqual([
      { marker: 'compaction', payload: expect.objectContaining({ phase: 'started', trigger: 'manual' }) },
      { marker: 'compaction', payload: expect.objectContaining({ phase: 'blocked', turnId: 2 }) },
      { marker: 'skill', payload: expect.objectContaining({ skillName: 'brainstorming' }) },
      { marker: 'skill', payload: expect.objectContaining({ variant: 'plugin_command', commandName: 'review' }) },
      { marker: 'compaction', payload: expect.objectContaining({ phase: 'completed' }) },
    ]);
  });

  it('builds a replay baseline with persisted status and background tasks', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    const records = [
      { type: 'message', time: 1_000, message: { role: 'user', content: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' } } },
      { type: 'message', time: 1_001, message: { role: 'assistant', content: [{ type: 'think', think: 'reason' }, { type: 'text', text: 'world' }], toolCalls: [] } },
    ] as unknown as readonly AgentReplayRecord[];
    const state = {
      config: { modelAlias: 'kimi-test', thinkingEffort: 'high' },
      usage: { inputTokens: 2, outputTokens: 3 },
      context: { tokenCount: 5 },
      permission: { mode: 'manual' },
      plan: { path: 'plan.md' },
      swarmMode: true,
      background: [{ taskId: 'bg-1', kind: 'process', status: 'running', description: 'watch' }],
    } as unknown as ResumedAgentState;

    expect(transcript.apply(projector.seedReplay(records, state, 'cancelled')).gap).toBeUndefined();
    expect(transcript.getTurn('r1')).toMatchObject({
      prompt: 'hello',
      state: 'cancelled',
      steps: [expect.objectContaining({ state: 'interrupted', endReason: 'cancelled' })],
    });
    expect(transcript.getMeta()).toMatchObject({
      activity: 'idle',
      agent: { model: 'kimi-test', thinkingEffort: 'high', contextTokens: 5 },
      modes: { plan: { reviewPath: 'plan.md' }, swarm: { trigger: 'resume' } },
    });
    expect(transcript.getTask('bg-1')).toMatchObject({ state: 'running', description: 'watch' });
  });

  it('keeps imported context outside the model turn when restoring its outcome', () => {
    const projector = new DesktopTranscriptProjector('main');
    const transcript = new TranscriptStore('s1').ensureAgent('main');
    const records = [
      { type: 'message', time: 1_000, message: { role: 'user', content: [{ type: 'text', text: 'cancel this turn' }], origin: { kind: 'user' } } },
      { type: 'message', time: 1_001, message: { role: 'assistant', content: [{ type: 'text', text: 'Waiting...' }], toolCalls: [] } },
      { type: 'message', time: 1_002, message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system>The user has imported context.</system>' },
          { type: 'text', text: '<imported_context source="desktop&amp;e2e">\nPrior context\n</imported_context>' },
        ],
        origin: { kind: 'user' },
      } },
    ] as unknown as readonly AgentReplayRecord[];
    const state = {
      config: { modelAlias: 'kimi-test', thinkingEffort: 'off' },
      usage: {},
      context: { tokenCount: 1 },
      permission: { mode: 'manual' },
      plan: null,
      swarmMode: false,
      background: [],
    } as unknown as ResumedAgentState;

    expect(transcript.apply(projector.seedReplay(records, state, 'cancelled')).gap).toBeUndefined();
    expect(transcript.getTurn('r1')).toMatchObject({
      prompt: 'cancel this turn',
      state: 'cancelled',
      steps: [expect.objectContaining({ state: 'interrupted', endReason: 'cancelled' })],
    });
    expect(transcript.getTurn('r2')).toBeUndefined();
    expect(transcript.getItems()).toContainEqual(expect.objectContaining({
      kind: 'marker',
      marker: 'context.import',
      payload: { source: 'desktop&e2e' },
    }));
  });
});
