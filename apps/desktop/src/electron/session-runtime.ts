import { createHash, randomUUID } from 'node:crypto';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  type Event,
  type PromptInput,
  type QuestionRequest,
  type QuestionResult,
  type Session,
  type TeamArtifactContent,
  type TeamMessage,
  type TeamMessageAttachment,
  type TeamOperation,
  type TeamPolicyInput,
  type TeamSnapshot,
  type TodoItem,
} from '@moonshot-ai/kimi-code-sdk';
import { TranscriptStore, type AgentDescriptor, type TranscriptInteraction } from '@moonshot-ai/transcript';
import { z } from 'zod';

import type {
  KimiDesktopNotification,
  SessionDetailsSnapshot,
  SessionStatusSnapshot,
  ShellSnapshot,
  TeamSubmitResult,
  TranscriptSnapshot,
} from '../shared/desktop-api';
import { applyTeamOperations, createTeamState, type TeamStateSnapshot } from '../shared/team-state';
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
  readonly onSessionMetadataChanged: (
    sessionId: string,
    patch: { readonly title?: string; readonly lastPrompt?: string },
  ) => void;
  readonly onTeamDetected?: (sessionId: string) => void;
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
  private readonly onSessionMetadataChanged: SessionRuntimeOptions['onSessionMetadataChanged'];
  private readonly onTeamDetected: NonNullable<SessionRuntimeOptions['onTeamDetected']>;
  private readonly projectors = new Map<string, DesktopTranscriptProjector>();
  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly seqByAgent = new Map<string, number>();
  private readonly pending = new Map<string, PendingInteraction>();
  private unsubscribe?: () => void;
  private todoUnsubscribe?: () => void;
  private teamUnsubscribe?: () => void;
  private initialized = false;
  private disposed = false;
  private busy = false;
  private status?: SessionStatusSnapshot;
  private details: SessionDetailsSnapshot = emptyDetails();
  private shell: ShellSnapshot = emptyShell();
  private planModeQueue: Promise<void> = Promise.resolve();
  private teamQueue: Promise<void> = Promise.resolve();
  private team?: TeamStateSnapshot;
  private teamDetected = false;
  private readonly teamSubmissions = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<TeamSubmitResult> }
  >();

  constructor(options: SessionRuntimeOptions) {
    this.session = options.session;
    this.mediaCacheDir = options.mediaCacheDir;
    this.id = options.session.id;
    this.store = new TranscriptStore(this.id);
    this.emit = options.emit;
    this.onRawEvent = options.onRawEvent;
    this.onStateChanged = options.onStateChanged;
    this.onSessionMetadataChanged = options.onSessionMetadataChanged;
    this.onTeamDetected = options.onTeamDetected ?? (() => undefined);
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

  get teamState(): TeamStateSnapshot | undefined {
    return this.team;
  }

  async ensureTeam(policy?: TeamPolicyInput): Promise<TeamSnapshot> {
    this.ensureOpen();
    const snapshot = await this.session.ensureTeam(policy);
    const messages = await this.session.getTeamHistory({ limit: 200 });
    this.team = createTeamState(snapshot, messages);
    this.notifyTeamDetected(snapshot);
    this.emit({ type: 'team.reset', sessionId: this.id, state: this.team });
    this.onStateChanged();
    return snapshot;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.unsubscribe = this.session.onEvent((event) => { this.handleEvent(event); });
    this.todoUnsubscribe = this.session.onTodosChanged((todos) => this.publishTodos(todos));
    this.teamUnsubscribe = this.session.onTeamOperation((operation) => this.enqueueTeamOperation(operation));
    this.session.setApprovalHandler((request) => this.requestApproval(request));
    this.session.setQuestionHandler((request) => this.requestQuestion(request));

    const resume = this.session.getResumeState();
    if (resume !== undefined) {
      for (const [agentId, agent] of Object.entries(resume.agents)) {
        const metadata = resume.sessionMetadata.agents[agentId];
        const type = transcriptAgentType(metadata?.type ?? agent.type, agentId);
        this.describeAgent(agentId, {
          type,
          parentAgentId: stringValue(metadata?.parentAgentId),
          label: agent.config.profileName ?? (agentId === 'main' ? 'Main Agent' : agentId),
        });
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
      this.describeAgent('main', { type: 'main', label: 'Main Agent' });
      this.projector('main');
    }
    this.publishTodos(await this.session.getTodos(), false);
    await this.refreshTeam(false);
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

  setPlanMode(enabled: boolean): Promise<void> {
    const operation = this.planModeQueue.then(
      () => this.applyPlanMode(enabled),
      () => this.applyPlanMode(enabled),
    );
    this.planModeQueue = operation.catch(() => undefined);
    return operation;
  }

  async startBtw(): Promise<string> {
    this.ensureOpen();
    const agentId = await this.session.startBtw();
    this.describeAgent(agentId, {
      type: 'sub',
      parentAgentId: 'main',
      label: 'BTW Agent',
      createdAt: new Date().toISOString(),
    });
    this.onStateChanged();
    return agentId;
  }

  async replaceTodos(
    expected: readonly TodoItem[],
    todos: readonly TodoItem[],
  ): Promise<void> {
    this.ensureOpen();
    if (this.todoEditingBlocked()) throw todoEditBusyError(this.id);
    const current = await this.session.getTodos();
    if (!todoItemsEqual(current, expected)) throw todoConflictError(this.id, current);
    if (this.todoEditingBlocked()) throw todoEditBusyError(this.id);
    await this.session.setTodos(todos);
  }

  getTeamSnapshot(): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.getTeamSnapshot();
  }

  getTeamOperations(afterSeq: number, limit?: number): Promise<readonly TeamOperation[]> {
    this.ensureOpen();
    return this.session.getTeamOperations({ afterSeq, limit });
  }

  getTeamHistory(beforeChannelSeq?: number, limit?: number): Promise<readonly TeamMessage[]> {
    this.ensureOpen();
    return this.session.getTeamHistory({ beforeChannelSeq, limit });
  }

  sendTeamMessage(
    body: string,
    clientMessageId: string,
    attachments?: readonly TeamMessageAttachment[],
    recipientAgentIds?: readonly string[],
  ): Promise<TeamMessage> {
    this.ensureOpen();
    return this.session.sendTeamMessage({
      body,
      clientMessageId,
      attachments,
      recipientAgentIds,
    });
  }

  submitTeamMessage(
    body: string,
    clientMessageId: string,
    media: readonly DesktopMediaInput[] = [],
    recipientAgentIds?: readonly string[],
  ): Promise<TeamSubmitResult> {
    this.ensureOpen();
    const fingerprint = teamSubmissionFingerprint(body, media, recipientAgentIds);
    const existing = this.teamSubmissions.get(clientMessageId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw teamSubmissionConflict(clientMessageId);
      return existing.result;
    }
    const result = this.performTeamSubmission(
      body,
      clientMessageId,
      media,
      recipientAgentIds,
    ).catch((error) => {
      this.teamSubmissions.delete(clientMessageId);
      throw error;
    });
    this.teamSubmissions.set(clientMessageId, { fingerprint, result });
    if (this.teamSubmissions.size > 256) {
      this.teamSubmissions.delete(this.teamSubmissions.keys().next().value as string);
    }
    return result;
  }

  updateTeamPolicy(policy: TeamPolicyInput, expectedSeq: number): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.updateTeamPolicy({ policy, expectedSeq });
  }

  pauseTeam(expectedSeq: number, reason?: string): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.pauseTeam({ expectedSeq, reason });
  }

  resumeTeam(expectedSeq: number): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.resumeTeam({ expectedSeq });
  }

  cancelTeamTask(taskId: string, expectedSeq: number): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.cancelTeamTask({ taskId, expectedSeq });
  }

  retryTeamTask(taskId: string, expectedSeq: number): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.retryTeamTask({ taskId, expectedSeq });
  }

  reassignTeamTask(
    taskId: string,
    expectedSeq: number,
    profileName?: string,
    model?: string,
  ): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.reassignTeamTask({ taskId, expectedSeq, profileName, model });
  }

  getTeamArtifact(artifactId: string): Promise<TeamArtifactContent> {
    this.ensureOpen();
    return this.session.getTeamArtifact(artifactId);
  }

  previewTeamIntegration(): Promise<TeamArtifactContent | undefined> {
    this.ensureOpen();
    return this.session.previewTeamIntegration();
  }

  applyTeamIntegration(expectedSeq: number): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.applyTeamIntegration({ expectedSeq });
  }

  discardTeamIntegration(expectedSeq: number): Promise<TeamSnapshot> {
    this.ensureOpen();
    return this.session.discardTeamIntegration({ expectedSeq });
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
    this.todoUnsubscribe?.();
    this.teamUnsubscribe?.();
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
    if (!this.descriptors.has(event.agentId)) {
      this.describeAgent(event.agentId, {
        type: event.agentId === 'main' ? 'main' : 'sub',
        label: event.agentId === 'main' ? 'Main Agent' : event.agentId,
      });
    }
    if (event.type === 'subagent.spawned') {
      this.describeAgent(event.subagentId, {
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
    if (event.type === 'session.meta.updated') {
      const title = event.title ?? stringValue(event.patch?.['title']);
      const lastPrompt = stringValue(event.patch?.['lastPrompt']);
      if (this.session.summary !== undefined && (title !== undefined || lastPrompt !== undefined)) {
        this.session.summary = {
          ...this.session.summary,
          title: title ?? this.session.summary.title,
          lastPrompt: lastPrompt ?? this.session.summary.lastPrompt,
          updatedAt: Date.now(),
        };
      }
      if (title !== undefined || lastPrompt !== undefined) {
        this.onSessionMetadataChanged(this.id, { title, lastPrompt });
      }
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
      const pending: PendingInteraction = {
        interactionId,
        agentId,
        kind: 'approval',
        request,
        resolve: (response) => { resolve(response); },
      };
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
      const pending: PendingInteraction = {
        interactionId,
        agentId,
        kind: 'question',
        request,
        resolve: (response) => { resolve(response); },
      };
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

  private async applyPlanMode(enabled: boolean): Promise<void> {
    this.ensureOpen();
    const before = await this.session.getStatus();
    this.publishStatus(before);
    if (before.planMode === enabled) return;

    try {
      await this.session.setPlanMode(enabled);
    } catch (error) {
      let afterFailure: Awaited<ReturnType<Session['getStatus']>>;
      try {
        afterFailure = await this.session.getStatus();
      } catch {
        throw error;
      }
      this.publishStatus(afterFailure);
      if (errorCode(error) === 'session.plan_mode_invalid' && afterFailure.planMode === enabled) {
        await this.refreshDetails();
        return;
      }
      throw error;
    }
    await this.refreshDetails();
  }

  private publishStatus(status: Omit<SessionStatusSnapshot, 'busy'>): void {
    this.status = { ...status, busy: this.busy };
    this.details = { ...this.details, status: this.status };
    this.emit({ type: 'session.status', sessionId: this.id, status: this.status });
    this.onStateChanged();
  }

  private describeAgent(agentId: string, patch: Omit<AgentDescriptor, 'agentId'>): void {
    const existing = this.descriptors.get(agentId);
    const descriptor: AgentDescriptor = {
      agentId,
      type: patch.type ?? existing?.type ?? (agentId === 'main' ? 'main' : 'sub'),
      parentAgentId: patch.parentAgentId ?? existing?.parentAgentId,
      label: patch.label ?? existing?.label ?? (agentId === 'main' ? 'Main Agent' : agentId),
      createdAt: patch.createdAt ?? existing?.createdAt,
      disposedAt: patch.disposedAt ?? existing?.disposedAt,
    };
    this.store.ensureAgent(agentId);
    if (existing !== undefined && sameDescriptor(existing, descriptor)) return;
    this.descriptors.set(agentId, descriptor);
    this.store.describeAgent(descriptor);
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

  private publishTodos(todos: readonly TodoItem[], publish = true): void {
    if (this.disposed) return;
    this.applyOps('main', [{
      op: 'todo.upsert',
      todo: {
        todoId: 'todo',
        items: todos.map((todo) => ({ ...todo })),
        updatedAt: new Date().toISOString(),
      },
    }], publish);
    this.onStateChanged();
  }

  private async performTeamSubmission(
    body: string,
    clientMessageId: string,
    media: readonly DesktopMediaInput[],
    recipientAgentIds?: readonly string[],
  ): Promise<TeamSubmitResult> {
    const attachments = media.map((item): TeamMessageAttachment => ({
      type: 'image_url',
      url: item.displayUrl,
      name: item.name,
    }));
    const message = await this.sendTeamMessage(
      body,
      clientMessageId,
      attachments.length === 0 ? undefined : attachments,
      recipientAgentIds,
    );
    const wake = this.busy ? 'steer' : 'swarm';
    await this.submit({
      mode: wake,
      text: teamWakePrompt(message.channelSeq, message.body, message.recipientAgentIds),
      media,
    });
    return { message, wake };
  }

  private enqueueTeamOperation(operation: TeamOperation): void {
    if (this.disposed) return;
    const next = this.teamQueue.then(
      () => this.applyLiveTeamOperation(operation),
      () => this.applyLiveTeamOperation(operation),
    );
    this.teamQueue = next.catch((error) => {
      this.emit({
        type: 'error',
        command: 'team.catchup',
        error: {
          code: errorCode(error) ?? 'team.catchup_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }

  private async applyLiveTeamOperation(operation: TeamOperation): Promise<void> {
    if (this.team === undefined) {
      await this.refreshTeam(true);
      return;
    }
    const currentSeq = this.team.snapshot.latestSeq;
    const hadTeam = this.team.snapshot.team !== undefined;
    if (operation.seq <= currentSeq) return;

    let operations: readonly TeamOperation[] = [operation];
    if (operation.seq !== currentSeq + 1) {
      operations = await this.session.getTeamOperations({ afterSeq: currentSeq, limit: 1_000 });
    }
    const next = applyTeamOperations(this.team, operations);
    if (next === undefined || next.snapshot.latestSeq < operation.seq) {
      await this.refreshTeam(true);
      return;
    }
    this.team = next;
    this.notifyTeamDetected(next.snapshot);
    if (!hadTeam && next.snapshot.team !== undefined) {
      this.emit({ type: 'team.reset', sessionId: this.id, state: next });
    } else {
      this.emit({ type: 'team.ops', sessionId: this.id, operations });
    }
    this.onStateChanged();
  }

  private async refreshTeam(publish: boolean): Promise<void> {
    try {
      const snapshot = await this.session.getTeamSnapshot();
      const messages = snapshot.team === undefined
        ? []
        : await this.session.getTeamHistory({ limit: 200 });
      this.team = createTeamState(snapshot, messages);
      this.notifyTeamDetected(snapshot);
      if (publish) this.emit({ type: 'team.reset', sessionId: this.id, state: this.team });
      this.onStateChanged();
    } catch (error) {
      if (errorCode(error) !== 'collaboration.not_enabled') throw error;
      this.team = undefined;
      if (publish) this.emit({ type: 'team.reset', sessionId: this.id, state: undefined });
    }
  }

  private todoEditingBlocked(): boolean {
    if (this.busy || this.pending.size > 0) return true;
    for (const descriptor of this.store.agents()) {
      const transcript = this.store.getAgent(descriptor.agentId);
      const phase = transcript?.getMeta().agent?.phase;
      if (
        phase !== undefined &&
        ['running', 'streaming', 'tool_call', 'retrying', 'awaiting_approval'].includes(phase.kind)
      ) {
        return true;
      }
      for (const task of transcript?.getTasks().values() ?? []) {
        if (task.kind === 'subagent' && task.state === 'running') return true;
      }
    }
    return false;
  }

  private notifyTeamDetected(snapshot: { readonly team?: unknown }): void {
    if (this.teamDetected || snapshot.team === undefined) return;
    this.teamDetected = true;
    this.onTeamDetected(this.id);
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

export function teamWakePrompt(
  channelSeq: number,
  body: string,
  recipientAgentIds?: readonly string[],
): string {
  return [
    `A user message was posted to the Team general channel at #${String(channelSeq)}.`,
    recipientAgentIds === undefined
      ? 'The message was broadcast to the whole Team.'
      : `The message was addressed to these Team members: ${recipientAgentIds.join(', ')}.`,
    '<team_user_message>',
    body,
    '</team_user_message>',
    'Read that channel message, coordinate the team with TeamStatus, TeamSend, and TeamWait, and respond through the appropriate Team workflow.',
  ].join('\n');
}

function teamSubmissionConflict(clientMessageId: string): Error {
  return Object.assign(new Error(`Team message id ${clientMessageId} was reused with different content`), {
    code: 'collaboration.idempotency_conflict',
    details: { clientMessageId },
  });
}

function teamSubmissionFingerprint(
  body: string,
  media: readonly DesktopMediaInput[],
  recipientAgentIds?: readonly string[],
): string {
  const hash = createHash('sha256').update(body);
  for (const item of media) {
    hash.update('\0').update(item.type);
    hash.update('\0').update(item.url);
    hash.update('\0').update(item.displayUrl);
    hash.update('\0').update(item.name ?? '');
  }
  for (const agentId of recipientAgentIds ?? []) hash.update('\0recipient\0').update(agentId);
  return hash.digest('hex');
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

function todoItemsEqual(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.title === other.title && item.status === other.status;
  });
}

function todoEditBusyError(sessionId: string): Error {
  return Object.assign(new Error('Agent 运行期间 TodoList 只读'), {
    code: 'task.todo_edit_busy',
    details: { sessionId },
  });
}

function todoConflictError(sessionId: string, current: readonly TodoItem[]): Error {
  return Object.assign(new Error('TodoList 已被更新，请基于最新列表重试'), {
    code: 'task.todo_conflict',
    details: { sessionId, current },
  });
}

function emptyShell(): ShellSnapshot {
  return { status: 'idle', stdout: '', stderr: '' };
}

function settled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined;
}

function transcriptAgentType(
  type: 'main' | 'sub' | 'independent' | undefined,
  agentId: string,
): AgentDescriptor['type'] {
  if (type === 'main' || type === 'independent') return type;
  return agentId === 'main' ? 'main' : 'sub';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sameDescriptor(left: AgentDescriptor, right: AgentDescriptor): boolean {
  return left.agentId === right.agentId &&
    left.type === right.type &&
    left.parentAgentId === right.parentAgentId &&
    left.label === right.label &&
    left.createdAt === right.createdAt &&
    left.disposedAt === right.disposedAt;
}

function interactionState(
  kind: 'approval' | 'question',
  response: ApprovalResponse | QuestionResult,
): 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed' {
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as ApprovalResponse).decision;
  return decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'cancelled';
}
