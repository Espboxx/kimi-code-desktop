import { randomUUID } from 'node:crypto';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  type Event,
  type PromptInput,
  type QuestionRequest,
  type QuestionResult,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';
import { TranscriptStore, type AgentDescriptor, type TranscriptInteraction } from '@moonshot-ai/transcript';
import { z } from 'zod';

import type {
  KimiDesktopNotification,
  SessionDetailsSnapshot,
  SessionStatusSnapshot,
  ShellSnapshot,
  TranscriptSnapshot,
} from '../shared/desktop-api';
import { materializeReplayMedia, type DesktopMediaInput } from './media-service';
import { DesktopTranscriptProjector } from './transcript-projector';

interface PendingInteractionBase {
  readonly interactionId: string;
  readonly agentId: string;
}

type PendingInteraction =
  | (PendingInteractionBase & {
      readonly kind: 'approval';
      readonly request: ApprovalRequest;
      readonly resolve: (response: ApprovalResponse) => void;
    })
  | (PendingInteractionBase & {
      readonly kind: 'question';
      readonly request: QuestionRequest;
      readonly resolve: (response: QuestionResult) => void;
    });

export interface SessionRuntimeOptions {
  readonly session: Session;
  readonly mediaCacheDir: string;
  readonly emit: (notification: KimiDesktopNotification) => void;
  readonly onRawEvent: (event: Event) => void;
  readonly onStateChanged: () => void;
}

const approvalResponseSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  scope: z.literal('session').optional(),
  feedback: z.string().optional(),
  selectedLabel: z.string().optional(),
}).strict();

const questionResultSchema = z.union([
  z.null(),
  z.record(z.string(), z.union([z.string(), z.literal(true)])),
  z.object({
    answers: z.record(z.string(), z.union([z.string(), z.literal(true)])),
    method: z.enum(['enter', 'space', 'number_key']).optional(),
  }).strict(),
]);

export class SessionRuntime {
  readonly id: string;
  readonly store: TranscriptStore;

  private readonly session: Session;
  private readonly mediaCacheDir: string;
  private readonly emit: SessionRuntimeOptions['emit'];
  private readonly onRawEvent: SessionRuntimeOptions['onRawEvent'];
  private readonly onStateChanged: SessionRuntimeOptions['onStateChanged'];
  private readonly projectors = new Map<string, DesktopTranscriptProjector>();
  private readonly seqByAgent = new Map<string, number>();
  private readonly pending = new Map<string, PendingInteraction>();
  private unsubscribe?: () => void;
  private initialized = false;
  private disposed = false;
  private busy = false;
  private status?: SessionStatusSnapshot;
  private details: SessionDetailsSnapshot = emptyDetails();
  private shell: ShellSnapshot = emptyShell();

  constructor(options: SessionRuntimeOptions) {
    this.session = options.session;
    this.mediaCacheDir = options.mediaCacheDir;
    this.id = options.session.id;
    this.store = new TranscriptStore(this.id);
    this.emit = options.emit;
    this.onRawEvent = options.onRawEvent;
    this.onStateChanged = options.onStateChanged;
  }

  get sdkSession(): Session {
    return this.session;
  }

  get sessionDetails(): SessionDetailsSnapshot {
    return this.details;
  }

  get sessionStatus(): SessionStatusSnapshot | undefined {
    return this.status;
  }

  get shellSnapshot(): ShellSnapshot {
    return this.shell;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.unsubscribe = this.session.onEvent((event) => this.handleEvent(event));
    this.session.setApprovalHandler((request) => this.requestApproval(request));
    this.session.setQuestionHandler((request) => this.requestQuestion(request));

    const resume = this.session.getResumeState();
    if (resume !== undefined) {
      for (const [agentId, agent] of Object.entries(resume.agents)) {
        const descriptor: AgentDescriptor = {
          agentId,
          type: agentId === 'main' ? 'main' : 'sub',
          label: agentId === 'main' ? 'Main Agent' : agentId,
        };
        this.store.ensureAgent(agentId, descriptor);
        const replay = await materializeReplayMedia(agent.replay, this.mediaCacheDir);
        const ops = this.projector(agentId).seedReplay(
          replay,
          agent,
          agentId === 'main' ? this.session.summary?.lastTurnReason : undefined,
        );
        this.applyOps(agentId, ops, false);
      }
    }
    if (this.store.getAgent('main') === undefined) {
      this.store.ensureAgent('main', { agentId: 'main', type: 'main', label: 'Main Agent' });
      this.projector('main');
    }
    await this.refreshDetails();
  }

  transcriptSnapshot(): TranscriptSnapshot {
    const transcripts: Record<string, ReturnType<ReturnType<TranscriptStore['ensureAgent']>['snapshot']>> = {};
    const seqByAgent: Record<string, number> = {};
    for (const descriptor of this.store.agents()) {
      const transcript = this.store.getAgent(descriptor.agentId);
      if (transcript === undefined) continue;
      transcripts[descriptor.agentId] = transcript.snapshot();
      seqByAgent[descriptor.agentId] = this.seqByAgent.get(descriptor.agentId) ?? 0;
    }
    return { sessionId: this.id, agents: this.store.agents(), transcripts, seqByAgent };
  }

  async refreshDetails(): Promise<void> {
    this.ensureOpen();
    const [status, plan, backgroundTasks, goal, cron, context, skills, pluginCommands, commands, mcpServers, metrics] = await Promise.allSettled([
      this.session.getStatus(),
      this.session.getPlan(),
      this.session.listBackgroundTasks({ limit: 200 }),
      this.session.getGoal(),
      this.session.getCronTasks(),
      this.session.getContext(),
      this.session.listSkills(),
      this.session.listPluginCommands(),
      this.session.listCommands(),
      this.session.listMcpServers(),
      this.session.getMcpStartupMetrics(),
    ]);
    if (status.status === 'fulfilled') {
      this.status = { ...status.value, busy: this.busy };
      this.emit({ type: 'session.status', sessionId: this.id, status: this.status });
    }
    this.details = {
      status: this.status,
      plan: settled(plan),
      backgroundTasks: settled(backgroundTasks) ?? [],
      goal: settled(goal),
      cron: settled(cron),
      context: context.status === 'fulfilled' ? {
        tokenCount: context.value.tokenCount,
        messageCount: context.value.history.length,
        additionalDirs: this.session.summary?.additionalDirs ?? [],
      } : undefined,
      skills: settled(skills) ?? [],
      pluginCommands: settled(pluginCommands) ?? [],
      commands: settled(commands) ?? [],
      mcpServers: settled(mcpServers) ?? [],
      mcpStartupMetrics: settled(metrics),
    };
    this.onStateChanged();
  }

  async submit(input: {
    readonly mode: 'prompt' | 'steer' | 'swarm';
    readonly text: string;
    readonly media: readonly DesktopMediaInput[];
  }): Promise<void> {
    this.ensureOpen();
    const parts: PromptInput = [
      ...(input.text.length > 0 ? [{ type: 'text' as const, text: input.text }] : []),
      ...input.media.map((item) => item.type === 'image_url'
        ? { type: 'image_url' as const, imageUrl: { url: item.url } }
        : { type: 'video_url' as const, videoUrl: { url: item.url } }),
    ];
    const projector = this.projector('main');
    if (input.mode === 'steer') {
      await this.session.steer(parts);
      this.applyOps('main', projector.appendSteerInput(input.text, input.media));
      return;
    }
    const queuedId = projector.queuePromptInput(input.text, input.media);
    try {
      if (input.mode === 'swarm') await this.session.swarm(parts);
      else await this.session.prompt(parts);
    } catch (error) {
      projector.discardPromptInput(queuedId);
      throw error;
    }
  }

  async runShell(command: string): Promise<ShellSnapshot> {
    this.ensureOpen();
    const commandId = randomUUID();
    this.shell = { commandId, command, status: 'running', stdout: '', stderr: '' };
    this.onStateChanged();
    try {
      const result = await this.session.runShellCommand(command, { commandId });
      this.shell = {
        commandId,
        command,
        status: result.isError === true ? 'failed' : 'completed',
        stdout: result.stdout,
        stderr: result.stderr,
        isError: result.isError,
        backgrounded: result.backgrounded,
      };
      return this.shell;
    } catch (error) {
      this.shell = {
        commandId,
        command,
        status: 'failed',
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        isError: true,
      };
      throw error;
    } finally {
      this.onStateChanged();
      void this.refreshDetails().catch(() => undefined);
    }
  }

  async cancelShell(commandId: string): Promise<void> {
    this.ensureOpen();
    await this.session.cancelShellCommand(commandId);
    if (this.shell.commandId === commandId) {
      this.shell = { ...this.shell, status: 'cancelled' };
      this.onStateChanged();
    }
  }

  resolveInteraction(interactionId: string, response: unknown): void {
    const item = this.pending.get(interactionId);
    if (item === undefined) throw new Error(`Interaction not found: ${interactionId}`);
    let parsed: ApprovalResponse | QuestionResult;
    if (item.kind === 'approval') {
      const approval = approvalResponseSchema.parse(response);
      parsed = approval;
    } else {
      const question = questionResultSchema.parse(response);
      parsed = question;
    }
    this.pending.delete(interactionId);
    item.resolve(parsed as never);
    const state = interactionState(item.kind, parsed);
    const interaction: TranscriptInteraction = {
      interactionId,
      interactionKind: item.kind,
      toolCallId: item.request.toolCallId,
      state,
      request: item.request,
      response: parsed,
    };
    this.applyOps(item.agentId, this.projector(item.agentId).upsertInteraction(interaction));
    this.emit({
      type: 'interaction.resolved',
      sessionId: this.id,
      agentId: item.agentId,
      interactionId,
      state,
      response: parsed,
    });
    this.onStateChanged();
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.session.setApprovalHandler(undefined);
    this.session.setQuestionHandler(undefined);
    for (const pending of this.pending.values()) {
      if (pending.kind === 'approval') pending.resolve({ decision: 'cancelled' });
      else pending.resolve(null);
    }
    this.pending.clear();
    await this.session.close();
  }

  private handleEvent(event: Event): void {
    if (this.disposed) return;
    this.onRawEvent(event);
    this.store.ensureAgent(event.agentId, {
      agentId: event.agentId,
      type: event.agentId === 'main' ? 'main' : 'sub',
      label: event.agentId === 'main' ? 'Main Agent' : event.agentId,
    });
    if (event.type === 'subagent.spawned') {
      this.store.ensureAgent(event.subagentId, {
        agentId: event.subagentId,
        type: 'sub',
        parentAgentId: event.parentAgentId ?? event.callerAgentId ?? event.agentId,
        label: event.subagentName,
        createdAt: new Date().toISOString(),
      });
    }
    this.applyOps(event.agentId, this.projector(event.agentId).map(event));
    if (event.agentId === 'main' && event.type === 'turn.started') this.setBusy(true);
    if (event.agentId === 'main' && event.type === 'turn.ended') this.setBusy(false);
    if (event.agentId === 'main' && event.type === 'agent.status.updated') {
      this.status = {
        model: event.model ?? this.status?.model,
        thinkingEffort: event.thinkingEffort ?? this.status?.thinkingEffort ?? 'off',
        permission: event.permission ?? this.status?.permission ?? 'manual',
        planMode: event.planMode ?? this.status?.planMode ?? false,
        swarmMode: event.swarmMode ?? this.status?.swarmMode,
        contextTokens: event.contextTokens ?? this.status?.contextTokens ?? 0,
        maxContextTokens: event.maxContextTokens ?? this.status?.maxContextTokens ?? 0,
        contextUsage: event.contextUsage ?? this.status?.contextUsage ?? 0,
        usage: event.usage ?? this.status?.usage,
        busy: this.busy,
      };
      this.emit({ type: 'session.status', sessionId: this.id, status: this.status });
    }
    if (event.type === 'session.meta.updated' && event.title !== undefined && this.session.summary !== undefined) {
      this.session.summary = { ...this.session.summary, title: event.title };
    }
    this.onStateChanged();
    if (event.type === 'turn.ended' || event.type === 'goal.updated' || event.type.startsWith('subagent.') || event.type.startsWith('task.') || event.type.startsWith('background.task.')) {
      void this.refreshDetails().catch(() => undefined);
    }
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const interactionId = `approval:${request.toolCallId}`;
      const agentId = this.agentForToolCall(request.toolCallId);
      const pending: PendingInteraction = { interactionId, agentId, kind: 'approval', request, resolve: (response) => resolve(response) };
      this.pending.set(interactionId, pending);
      this.publishPending(pending);
    });
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.status === undefined) return;
    this.status = { ...this.status, busy };
    this.details = { ...this.details, status: this.status };
    this.emit({ type: 'session.status', sessionId: this.id, status: this.status });
  }

  private requestQuestion(request: QuestionRequest): Promise<QuestionResult> {
    return new Promise((resolve) => {
      const interactionId = `question:${request.toolCallId ?? randomUUID()}`;
      const agentId = request.toolCallId === undefined ? 'main' : this.agentForToolCall(request.toolCallId);
      const pending: PendingInteraction = { interactionId, agentId, kind: 'question', request, resolve: (response) => resolve(response) };
      this.pending.set(interactionId, pending);
      this.publishPending(pending);
    });
  }

  private publishPending(item: PendingInteraction): void {
    const interaction: TranscriptInteraction = {
      interactionId: item.interactionId,
      interactionKind: item.kind,
      toolCallId: item.request.toolCallId,
      state: 'pending',
      request: item.request,
    };
    this.applyOps(item.agentId, this.projector(item.agentId).upsertInteraction(interaction));
    this.emit({
      type: 'interaction.pending',
      sessionId: this.id,
      agentId: item.agentId,
      interactionId: item.interactionId,
      interactionKind: item.kind,
      request: item.request,
    });
    this.onStateChanged();
  }

  private projector(agentId: string): DesktopTranscriptProjector {
    let projector = this.projectors.get(agentId);
    if (projector === undefined) {
      projector = new DesktopTranscriptProjector(agentId);
      this.projectors.set(agentId, projector);
      this.seqByAgent.set(agentId, this.seqByAgent.get(agentId) ?? 0);
    }
    return projector;
  }

  private applyOps(agentId: string, ops: readonly import('@moonshot-ai/transcript').TranscriptOperation[], publish = true): void {
    if (ops.length === 0) return;
    const transcript = this.store.ensureAgent(agentId);
    const applied = transcript.apply(ops);
    if (applied.accepted.length === 0) return;
    const seq = (this.seqByAgent.get(agentId) ?? 0) + 1;
    this.seqByAgent.set(agentId, seq);
    if (publish) {
      this.emit({ type: 'transcript.ops', batch: { sessionId: this.id, agentId, seq, ops: applied.accepted } });
    }
  }

  private agentForToolCall(toolCallId: string): string {
    for (const [agentId, projector] of this.projectors) {
      if (projector.hasToolCall(toolCallId)) return agentId;
    }
    return 'main';
  }

  private ensureOpen(): void {
    if (this.disposed) throw new Error(`Session runtime is closed: ${this.id}`);
  }
}

function emptyDetails(): SessionDetailsSnapshot {
  return {
    backgroundTasks: [],
    skills: [],
    pluginCommands: [],
    commands: [],
    mcpServers: [],
  };
}

function emptyShell(): ShellSnapshot {
  return { status: 'idle', stdout: '', stderr: '' };
}

function settled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined;
}

function interactionState(
  kind: 'approval' | 'question',
  response: ApprovalResponse | QuestionResult,
): 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed' {
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as ApprovalResponse).decision;
  return decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'cancelled';
}
