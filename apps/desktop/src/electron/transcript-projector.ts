import type {
  AgentReplayRecord,
  ContextMessage,
  Event,
  ResumedAgentState,
  ToolCall,
} from '@moonshot-ai/kimi-code-sdk';
import type {
  AgentStatusMeta,
  StepHeader,
  TextFrame,
  TranscriptAttachment,
  ToolCallFrame,
  TranscriptInteraction,
  TranscriptOperation,
  TranscriptTask,
  TranscriptUsage,
  TurnHeader,
  TurnOrigin,
  TurnState,
} from '@moonshot-ai/transcript';

import type { DesktopMediaInput } from './media-service';

interface OpenFrame {
  readonly frameId: string;
  text: string;
}

interface ToolFrameRecord {
  readonly turnId: string;
  readonly stepId: string;
  frame: ToolCallFrame;
}

interface QueuedPromptInput {
  readonly id: number;
  readonly prompt: string;
  readonly media: readonly DesktopMediaInput[];
}

interface MediaReference {
  readonly type: 'image' | 'video' | 'audio';
  readonly url: string;
}

export class DesktopTranscriptProjector {
  private currentTurn?: TurnHeader;
  private currentStep?: StepHeader;
  private frameSeq = 0;
  private markerSeq = 0;
  private attachmentSeq = 0;
  private promptInputSeq = 0;
  private replayTurnSeq = 0;
  private openAssistant?: OpenFrame;
  private openThinking?: OpenFrame;
  private readonly toolFrames = new Map<string, ToolFrameRecord>();
  private readonly tasks = new Map<string, TranscriptTask>();
  private readonly shellTaskIds = new Map<string, string>();
  private readonly interactions = new Map<string, TranscriptInteraction>();
  private readonly stepUsage = new Map<string, NonNullable<StepHeader['usage']>[]>();
  private readonly queuedPromptInputs: QueuedPromptInput[] = [];

  constructor(readonly agentId: string) {}

  queuePromptInput(prompt: string, media: readonly DesktopMediaInput[]): number {
    const id = ++this.promptInputSeq;
    this.queuedPromptInputs.push({ id, prompt, media });
    return id;
  }

  discardPromptInput(id: number): void {
    const index = this.queuedPromptInputs.findIndex((input) => input.id === id);
    if (index !== -1) this.queuedPromptInputs.splice(index, 1);
  }

  appendSteerInput(text: string, media: readonly DesktopMediaInput[]): TranscriptOperation[] {
    if (this.currentStep === undefined) {
      return [this.marker('notice', { level: 'info', message: 'Steer', text })];
    }
    const attachments = this.createAttachments(media.map((item) => ({
      type: item.type === 'image_url' ? 'image' : 'video',
      url: item.displayUrl,
    })));
    const frame: TextFrame = {
      kind: 'text',
      frameId: this.nextFrameId(this.currentStep),
      role: 'user',
      text,
      attachmentIds: attachments.ids.length === 0 ? undefined : attachments.ids,
    };
    return [
      ...attachments.ops,
      {
        op: 'frame.upsert',
        turnId: this.currentStep.turnId,
        stepId: this.currentStep.stepId,
        frame,
      },
    ];
  }

  seedReplay(
    records: readonly AgentReplayRecord[],
    state: ResumedAgentState,
    lastTurnReason: 'completed' | 'cancelled' | 'failed' = 'completed',
  ): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    for (const record of records) {
      switch (record.type) {
        case 'message':
          this.seedMessage(record.message, record.time, ops);
          break;
        case 'compaction':
          ops.push(this.marker('compaction', {
            phase: record.result === 'cancelled' ? 'cancelled' : 'completed',
            instruction: record.instruction,
            result: record.result,
          }, record.time));
          break;
        case 'goal_updated':
          ops.push(
            this.marker('goal', { snapshot: record.snapshot, change: record.change }, record.time),
            {
              op: 'meta.merge',
              meta: {
                goal: {
                  objective: record.snapshot.objective,
                  status: record.snapshot.status,
                  completionCriterion: record.snapshot.completionCriterion,
                  budgetUsed: record.snapshot.tokensUsed,
                  budgetLimit: record.snapshot.budget.tokenBudget ?? undefined,
                },
              },
            },
          );
          break;
        case 'plan_updated':
          ops.push(
            this.marker(record.enabled ? 'plan.enter' : 'plan.exit', { enabled: record.enabled }, record.time),
            { op: 'meta.merge', meta: { modes: { plan: record.enabled ? {} : null } } },
          );
          break;
        case 'permission_updated':
          ops.push({ op: 'meta.merge', meta: { agent: { permission: record.mode } } });
          break;
        case 'approval_result':
          ops.push(this.marker('notice', {
            level: 'info',
            message: `${record.record.result.decision}: ${record.record.action}`,
            approval: record.record,
          }, record.time));
          break;
        case 'config_updated':
          break;
      }
    }
    this.finishReplayTurn(ops, Date.now(), lastTurnReason);
    ops.push({
      op: 'meta.merge',
      meta: {
        agent: {
          model: state.config.modelAlias,
          thinkingEffort: state.config.thinkingEffort,
          usage: state.usage,
          contextTokens: state.context.tokenCount,
          permission: state.permission.mode,
        },
        modes: {
          plan: state.plan !== null ? { reviewPath: state.plan.path } : null,
          swarm: state.swarmMode === true ? { trigger: 'resume' } : null,
        },
        activity: 'idle',
      },
    });
    for (const background of state.background) {
      const info = background as unknown as Record<string, unknown>;
      const taskId = stringValue(info['taskId'])
        ?? stringValue(info['id'])
        ?? `background-${this.tasks.size + 1}`;
      const status = taskState(info['status']);
      const task: TranscriptTask = {
        taskId,
        kind: info['kind'] === 'agent' ? 'subagent' : 'shell',
        state: status,
        detached: true,
        description: stringValue(info['description']) ?? stringValue(info['command']),
        agentId: stringValue(info['agentId']),
        outputTail: stringValue(info['output']) ?? '',
        startedAt: timeValue(info['startedAt']),
        endedAt: timeValue(info['endedAt']),
      };
      this.tasks.set(taskId, task);
      ops.push({ op: 'task.upsert', task });
    }
    return ops;
  }

  map(event: Event): TranscriptOperation[] {
    switch (event.type) {
      case 'turn.started':
        return this.turnStarted(event);
      case 'turn.ended':
        return this.turnEnded(event);
      case 'turn.step.started':
        return this.stepStarted(event);
      case 'turn.step.completed':
        return this.stepCompleted(event);
      case 'turn.step.retrying':
        return this.stepRetrying(event);
      case 'turn.step.interrupted':
        return this.stepInterrupted(event);
      case 'assistant.delta':
        return this.textDelta(event.turnId, 'assistant', event.delta);
      case 'thinking.delta':
        return this.textDelta(event.turnId, 'thinking', event.delta);
      case 'tool.call.delta':
        return this.toolDelta(event);
      case 'tool.call.started':
        return this.toolStarted(event);
      case 'tool.progress':
        return this.toolProgress(event);
      case 'tool.result':
        return this.toolResult(event);
      case 'agent.status.updated':
        return this.agentStatus(event);
      case 'goal.updated':
        return this.goalUpdated(event);
      case 'subagent.spawned':
        return this.subagentSpawned(event);
      case 'subagent.started':
      case 'subagent.suspended':
      case 'subagent.completed':
      case 'subagent.failed':
        return this.subagentChanged(event);
      case 'task.started':
      case 'task.terminated':
      case 'background.task.started':
      case 'background.task.terminated':
        return this.taskChanged(event.info, event.type.endsWith('started'));
      case 'shell.started':
        return this.shellStarted(event);
      case 'shell.output':
        return this.shellOutput(event);
      case 'shell.completed':
        return this.shellCompleted(event);
      case 'prompt.submitted':
        return [{ op: 'prompt.upsert', prompt: {
          promptId: event.promptId,
          userMessageId: event.userMessageId,
          status: event.status,
          content: event.content,
          createdAt: event.createdAt,
        } }];
      case 'prompt.completed':
        return [{ op: 'prompt.upsert', prompt: {
          promptId: event.promptId,
          status: event.reason === 'failed' ? 'failed' : 'completed',
          createdAt: event.finishedAt,
          finishedAt: event.finishedAt,
        } }];
      case 'prompt.aborted':
        return [{ op: 'prompt.upsert', prompt: {
          promptId: event.promptId,
          status: 'aborted',
          createdAt: event.abortedAt,
          finishedAt: event.abortedAt,
        } }];
      case 'prompt.steered':
        return [{ op: 'prompt.upsert', prompt: {
          promptId: event.activePromptId,
          status: 'running',
          content: event.content,
          createdAt: event.steeredAt,
          steeredAt: event.steeredAt,
        } }];
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
        return [this.marker('compaction', { phase: event.type.slice('compaction.'.length), ...withoutEnvelope(event) })];
      case 'skill.activated':
        return [this.marker('skill', withoutEnvelope(event))];
      case 'plugin_command.activated':
        return [this.marker('skill', { variant: 'plugin_command', ...withoutEnvelope(event) })];
      case 'cron.fired':
        return [this.marker('cron.fired', withoutEnvelope(event))];
      case 'hook.result':
        return [this.marker('hook', withoutEnvelope(event))];
      case 'error':
        return [this.marker('notice', { level: 'error', message: event.message, detail: withoutEnvelope(event) })];
      case 'warning':
        return [this.marker('notice', { level: 'warning', message: event.message, detail: withoutEnvelope(event) })];
      default:
        return [];
    }
  }

  hasToolCall(toolCallId: string): boolean {
    return this.toolFrames.has(toolCallId);
  }

  upsertInteraction(interaction: TranscriptInteraction): TranscriptOperation[] {
    this.interactions.set(interaction.interactionId, interaction);
    const ops: TranscriptOperation[] = [{ op: 'interaction.upsert', interaction }];
    if (interaction.toolCallId !== undefined) {
      const hit = this.toolFrames.get(interaction.toolCallId);
      if (hit !== undefined) {
        hit.frame = { ...hit.frame, approvalId: interaction.interactionId };
        ops.push({ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame: hit.frame });
      }
    }
    return ops;
  }

  private seedMessage(message: ContextMessage, time: number, ops: TranscriptOperation[]): void {
    if (message.role === 'system') return;
    if (message.role === 'user') {
      if (message.origin?.kind === 'injection' || message.origin?.kind === 'system_trigger') return;
      const importedContextSource = readImportedContextSource(message);
      if (importedContextSource !== undefined) {
        ops.push(this.marker('context.import', { source: importedContextSource }, time));
        return;
      }
      if (message.origin?.kind === 'hook_result') {
        ops.push(this.marker('hook', { origin: message.origin, content: messageText(message) }, time));
        return;
      }
      if (message.origin?.kind === 'cron_job') {
        ops.push(this.marker('cron.fired', { origin: message.origin, prompt: messageText(message) }, time));
      }
      if (message.origin?.kind === 'shell_command') {
        ops.push(this.marker('notice', { level: 'info', source: 'shell', content: messageText(message), origin: message.origin }, time));
        return;
      }
      this.finishReplayTurn(ops, time);
      const ordinal = ++this.replayTurnSeq;
      const turnId = `r${ordinal}`;
      this.currentTurn = {
        kind: 'turn',
        turnId,
        ordinal,
        state: 'running',
        origin: mapOrigin(message.origin),
        prompt: visibleMessageText(message),
        attachmentIds: undefined,
        startedAt: new Date(time).toISOString(),
      };
      const attachments = this.createAttachments(mediaReferences(message));
      if (attachments.ids.length > 0) {
        this.currentTurn = { ...this.currentTurn, attachmentIds: attachments.ids };
        ops.push(...attachments.ops);
      }
      this.currentStep = undefined;
      this.frameSeq = 0;
      ops.push({ op: 'turn.upsert', turn: this.currentTurn });
      return;
    }

    const step = this.ensureReplayStep(time, ops);
    if (message.role === 'assistant') {
      const thinking = message.content
        .filter((part) => part.type === 'think')
        .map((part) => part.type === 'think' ? part.think : '')
        .join('');
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.type === 'text' ? part.text : '')
        .join('');
      const attachments = this.createAttachments(mediaReferences(message));
      ops.push(...attachments.ops);
      if (thinking.length > 0) {
        ops.push({ op: 'frame.upsert', turnId: step.turnId, stepId: step.stepId, frame: {
          kind: 'thinking', frameId: this.nextFrameId(step), text: thinking,
        } });
      }
      if (text.length > 0 || attachments.ids.length > 0) {
        ops.push({ op: 'frame.upsert', turnId: step.turnId, stepId: step.stepId, frame: {
          kind: 'text', frameId: this.nextFrameId(step), role: 'assistant', text,
          attachmentIds: attachments.ids.length === 0 ? undefined : attachments.ids,
        } });
      }
      for (const call of message.toolCalls) this.seedToolCall(call, message, step, ops);
      return;
    }

    const toolCallId = message.toolCallId;
    if (toolCallId === undefined) return;
    const hit = this.toolFrames.get(toolCallId);
    if (hit === undefined) return;
    hit.frame = {
      ...hit.frame,
      state: message.isError === true ? 'error' : 'done',
      output: messageText(message),
      error: message.isError === true ? messageText(message) : undefined,
    };
    ops.push({ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame: hit.frame });
  }

  private seedToolCall(
    call: ToolCall,
    message: ContextMessage,
    step: StepHeader,
    ops: TranscriptOperation[],
  ): void {
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId: `${step.stepId}.tool.${call.id}`,
      toolCallId: call.id,
      name: call.name,
      state: 'running',
      input: parseArguments(call.arguments),
      inputText: call.arguments ?? undefined,
      display: message.toolCallDisplays?.[call.id],
    };
    this.toolFrames.set(call.id, { turnId: step.turnId, stepId: step.stepId, frame });
    ops.push({ op: 'frame.upsert', turnId: step.turnId, stepId: step.stepId, frame });
  }

  private ensureReplayStep(time: number, ops: TranscriptOperation[]): StepHeader {
    if (this.currentTurn === undefined) {
      const ordinal = ++this.replayTurnSeq;
      this.currentTurn = {
        kind: 'turn', turnId: `r${ordinal}`, ordinal, state: 'running', origin: { kind: 'other' }, startedAt: new Date(time).toISOString(),
      };
      ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    }
    if (this.currentStep !== undefined && this.currentStep.turnId === this.currentTurn.turnId) return this.currentStep;
    this.currentStep = {
      kind: 'step',
      stepId: `${this.currentTurn.turnId}.1`,
      turnId: this.currentTurn.turnId,
      ordinal: 1,
      state: 'running',
      startedAt: new Date(time).toISOString(),
    };
    ops.push({ op: 'step.upsert', turnId: this.currentTurn.turnId, step: this.currentStep });
    return this.currentStep;
  }

  private finishReplayTurn(
    ops: TranscriptOperation[],
    time = Date.now(),
    reason: 'completed' | 'cancelled' | 'failed' = 'completed',
  ): void {
    if (this.currentStep !== undefined) {
      this.currentStep = {
        ...this.currentStep,
        state: reason === 'completed' ? 'completed' : reason === 'failed' ? 'failed' : 'interrupted',
        endedAt: new Date(time).toISOString(),
        endReason: reason === 'completed' ? undefined : reason,
      };
      ops.push({ op: 'step.upsert', turnId: this.currentStep.turnId, step: this.currentStep });
    }
    if (this.currentTurn !== undefined) {
      this.currentTurn = { ...this.currentTurn, state: reason, endedAt: new Date(time).toISOString() };
      ops.push({ op: 'turn.upsert', turn: this.currentTurn });
    }
    this.currentStep = undefined;
    this.currentTurn = undefined;
  }

  private turnStarted(event: Extract<Event, { type: 'turn.started' }>): TranscriptOperation[] {
    const turnId = `t${event.turnId}`;
    const queued = this.takePromptInput(event.prompt);
    const attachments = this.createAttachments((queued?.media ?? []).map((item) => ({
      type: item.type === 'image_url' ? 'image' : 'video',
      url: item.displayUrl,
    })));
    this.currentTurn = {
      kind: 'turn',
      turnId,
      ordinal: event.turnId,
      state: 'running',
      origin: mapOrigin(event.origin),
      prompt: event.prompt,
      attachmentIds: attachments.ids.length === 0 ? undefined : attachments.ids,
      startedAt: now(),
    };
    this.currentStep = undefined;
    this.frameSeq = 0;
    this.openAssistant = undefined;
    this.openThinking = undefined;
    return [...attachments.ops, { op: 'turn.upsert', turn: this.currentTurn }];
  }

  private turnEnded(event: Extract<Event, { type: 'turn.ended' }>): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushStreams(ops);
    const turnId = `t${event.turnId}`;
    if (this.currentStep?.state === 'running') {
      this.currentStep = { ...this.currentStep, state: 'interrupted', endedAt: now() };
      ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    }
    const previous = this.currentTurn?.turnId === turnId ? this.currentTurn : undefined;
    const turn: TurnHeader = {
      kind: 'turn',
      turnId,
      ordinal: event.turnId,
      state: turnState(event.reason),
      origin: previous?.origin ?? { kind: 'other' },
      prompt: previous?.prompt,
      attachmentIds: previous?.attachmentIds,
      startedAt: previous?.startedAt,
      endedAt: now(),
      durationMs: event.durationMs,
      error: event.error?.message,
      usage: this.takeUsage(turnId),
    };
    this.currentTurn = turn;
    this.currentStep = undefined;
    ops.push({ op: 'turn.upsert', turn });
    return ops;
  }

  private stepStarted(event: Extract<Event, { type: 'turn.step.started' }>): TranscriptOperation[] {
    const turnId = `t${event.turnId}`;
    this.currentStep = {
      kind: 'step',
      stepId: event.stepId ?? `${turnId}.${event.step}`,
      turnId,
      ordinal: event.step,
      state: 'running',
      startedAt: now(),
    };
    this.openAssistant = undefined;
    this.openThinking = undefined;
    this.frameSeq = 0;
    return [{ op: 'step.upsert', turnId, step: this.currentStep }];
  }

  private stepCompleted(event: Extract<Event, { type: 'turn.step.completed' }>): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushStreams(ops);
    const turnId = `t${event.turnId}`;
    const stepId = event.stepId ?? `${turnId}.${event.step}`;
    if (event.usage !== undefined) {
      const usages = this.stepUsage.get(turnId) ?? [];
      usages.push(event.usage);
      this.stepUsage.set(turnId, usages);
    }
    this.currentStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: event.step,
      state: 'completed',
      startedAt: this.currentStep?.stepId === stepId ? this.currentStep.startedAt : undefined,
      endedAt: now(),
      usage: event.usage,
      finishReason: event.finishReason ?? event.rawFinishReason ?? event.providerFinishReason,
      timing: {
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        llmRequestBuildMs: event.llmRequestBuildMs,
        llmServerFirstTokenMs: event.llmServerFirstTokenMs,
        llmServerDecodeMs: event.llmServerDecodeMs,
        llmClientConsumeMs: event.llmClientConsumeMs,
      },
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  private stepRetrying(event: Extract<Event, { type: 'turn.step.retrying' }>): TranscriptOperation[] {
    const turnId = `t${event.turnId}`;
    const stepId = event.stepId ?? `${turnId}.${event.step}`;
    this.currentStep = {
      kind: 'step', stepId, turnId, ordinal: event.step, state: 'running',
      startedAt: this.currentStep?.stepId === stepId ? this.currentStep.startedAt : now(),
      retry: {
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      },
    };
    return [{ op: 'step.upsert', turnId, step: this.currentStep }];
  }

  private stepInterrupted(event: Extract<Event, { type: 'turn.step.interrupted' }>): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    this.flushStreams(ops);
    const turnId = `t${event.turnId}`;
    const stepId = event.stepId ?? `${turnId}.${event.step}`;
    this.currentStep = {
      kind: 'step', stepId, turnId, ordinal: event.step, state: 'interrupted',
      startedAt: this.currentStep?.stepId === stepId ? this.currentStep.startedAt : undefined,
      endedAt: now(), endReason: event.reason, endMessage: event.message,
    };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return ops;
  }

  private textDelta(turnNumber: number, kind: 'assistant' | 'thinking', delta: string): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${turnNumber}`;
    const step = this.ensureLiveStep(turnId, ops);
    let open = kind === 'assistant' ? this.openAssistant : this.openThinking;
    if (open === undefined) {
      open = { frameId: this.nextFrameId(step), text: '' };
      ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame: kind === 'assistant'
        ? { kind: 'text', frameId: open.frameId, role: 'assistant', text: '' }
        : { kind: 'thinking', frameId: open.frameId, text: '' } });
    }
    ops.push({
      op: 'append',
      target: { type: 'frame', turnId, stepId: step.stepId, frameId: open.frameId },
      offset: open.text.length,
      text: delta,
    });
    open.text += delta;
    if (kind === 'assistant') this.openAssistant = open;
    else this.openThinking = open;
    return ops;
  }

  private toolDelta(event: Extract<Event, { type: 'tool.call.delta' }>): TranscriptOperation[] {
    const hit = this.toolFrames.get(event.toolCallId);
    if (hit !== undefined) {
      hit.frame = { ...hit.frame, inputText: `${hit.frame.inputText ?? ''}${event.argumentsPart ?? ''}` };
      return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame: hit.frame }];
    }
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const step = this.ensureLiveStep(turnId, ops);
    const frame: ToolCallFrame = {
      kind: 'tool', frameId: `${step.stepId}.tool.${event.toolCallId}`, toolCallId: event.toolCallId,
      name: event.name ?? '', state: 'running', inputText: event.argumentsPart ?? '',
    };
    this.toolFrames.set(event.toolCallId, { turnId, stepId: step.stepId, frame });
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  private toolStarted(event: Extract<Event, { type: 'tool.call.started' }>): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const turnId = `t${event.turnId}`;
    const step = this.ensureLiveStep(turnId, ops);
    const prior = this.toolFrames.get(event.toolCallId)?.frame;
    const frame: ToolCallFrame = {
      kind: 'tool', frameId: prior?.frameId ?? `${step.stepId}.tool.${event.toolCallId}`,
      toolCallId: event.toolCallId, name: event.name, state: 'running', input: parseArguments(event.args),
      inputText: prior?.inputText, display: event.display, approvalId: prior?.approvalId,
    };
    this.toolFrames.set(event.toolCallId, { turnId, stepId: step.stepId, frame });
    ops.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    return ops;
  }

  private toolProgress(event: Extract<Event, { type: 'tool.progress' }>): TranscriptOperation[] {
    const hit = this.toolFrames.get(event.toolCallId);
    if (hit === undefined) return [];
    hit.frame = { ...hit.frame, progress: event.update };
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame: hit.frame }];
  }

  private toolResult(event: Extract<Event, { type: 'tool.result' }>): TranscriptOperation[] {
    const hit = this.toolFrames.get(event.toolCallId);
    if (hit === undefined) return [];
    hit.frame = {
      ...hit.frame,
      state: event.isError === true ? 'error' : 'done',
      output: event.output,
      error: event.isError === true ? valueText(event.output) : undefined,
    };
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame: hit.frame }];
  }

  private agentStatus(event: Extract<Event, { type: 'agent.status.updated' }>): TranscriptOperation[] {
    const agent: AgentStatusMeta = {
      model: event.model,
      thinkingEffort: event.thinkingEffort,
      usage: event.usage,
      contextTokens: event.contextTokens,
      maxContextTokens: event.maxContextTokens,
      contextUsage: event.contextUsage,
      permission: event.permission,
      phase: event.phase,
    };
    return [{
      op: 'meta.merge',
      meta: {
        agent,
        modes: {
          plan: event.planMode === undefined ? undefined : event.planMode ? {} : null,
          swarm: event.swarmMode === undefined ? undefined : event.swarmMode ? { trigger: 'session' } : null,
        },
        activity: event.phase?.kind === 'idle' || event.phase?.kind === 'ended' ? 'idle' : event.phase === undefined ? undefined : 'turn',
      },
    }];
  }

  private goalUpdated(event: Extract<Event, { type: 'goal.updated' }>): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [this.marker('goal', withoutEnvelope(event))];
    if (event.snapshot !== null) {
      ops.push({ op: 'meta.merge', meta: { goal: {
        objective: event.snapshot.objective,
        status: event.snapshot.status,
        completionCriterion: event.snapshot.completionCriterion,
        budgetUsed: event.snapshot.tokensUsed,
        budgetLimit: event.snapshot.budget.tokenBudget ?? undefined,
      } } });
    }
    return ops;
  }

  private subagentSpawned(event: Extract<Event, { type: 'subagent.spawned' }>): TranscriptOperation[] {
    const taskId = `agent-${event.subagentId}`;
    const task: TranscriptTask = {
      taskId, kind: 'subagent', state: 'running', detached: event.runInBackground,
      description: event.description ?? event.subagentName, agentId: event.subagentId,
      outputTail: '', startedAt: now(),
    };
    this.tasks.set(taskId, task);
    const ops: TranscriptOperation[] = [
      { op: 'task.upsert', task },
      { op: 'taskref.upsert', item: { kind: 'taskref', refId: `ref-${taskId}`, taskId, at: now() } },
    ];
    const parent = this.toolFrames.get(event.parentToolCallId);
    if (parent !== undefined) {
      const refs = [...(parent.frame.agentRefs ?? [])];
      if (!refs.some((ref) => ref.agentId === event.subagentId)) {
        refs.push({ agentId: event.subagentId, role: event.swarmIndex === undefined ? 'child' : 'member' });
      }
      parent.frame = { ...parent.frame, taskId, agentRefs: refs, view: event.swarmIndex === undefined ? parent.frame.view : 'swarm' };
      ops.push({ op: 'frame.upsert', turnId: parent.turnId, stepId: parent.stepId, frame: parent.frame });
    }
    return ops;
  }

  private subagentChanged(event: Extract<Event, { type: 'subagent.started' | 'subagent.suspended' | 'subagent.completed' | 'subagent.failed' }>): TranscriptOperation[] {
    const taskId = `agent-${event.subagentId}`;
    const previous = this.tasks.get(taskId);
    const task: TranscriptTask = {
      taskId, kind: 'subagent', detached: previous?.detached ?? true,
      description: previous?.description, agentId: event.subagentId,
      outputTail: previous?.outputTail ?? '', startedAt: previous?.startedAt ?? now(),
      state: event.type === 'subagent.completed' ? 'completed' : event.type === 'subagent.failed' ? 'failed' : 'running',
      endedAt: event.type === 'subagent.completed' || event.type === 'subagent.failed' ? now() : undefined,
      resultSummary: event.type === 'subagent.completed' ? event.resultSummary : undefined,
      error: event.type === 'subagent.failed' ? event.error : undefined,
      stateReason: event.type === 'subagent.suspended' ? event.reason : undefined,
      usage: event.type === 'subagent.completed' ? event.usage : undefined,
    };
    this.tasks.set(taskId, task);
    return [{ op: 'task.upsert', task }];
  }

  private taskChanged(info: Extract<Event, { type: 'task.started' }>['info'], started: boolean): TranscriptOperation[] {
    const previous = this.tasks.get(info.taskId);
    const task: TranscriptTask = {
      taskId: info.taskId,
      kind: info.kind === 'agent' ? 'subagent' : info.kind === 'process' ? 'shell' : 'other',
      state: taskState(info.status),
      detached: info.detached ?? previous?.detached ?? true,
      description: info.description,
      agentId: info.kind === 'agent' ? info.agentId : previous?.agentId,
      outputTail: previous?.outputTail ?? '',
      startedAt: previous?.startedAt ?? new Date(info.startedAt).toISOString(),
      endedAt: info.endedAt === null ? previous?.endedAt : new Date(info.endedAt).toISOString(),
      stateReason: info.stopReason,
    };
    this.tasks.set(task.taskId, task);
    const ops: TranscriptOperation[] = [{ op: 'task.upsert', task }];
    if (started) ops.push({ op: 'taskref.upsert', item: { kind: 'taskref', refId: `ref-${task.taskId}`, taskId: task.taskId, at: now() } });
    return ops;
  }

  private shellStarted(event: Extract<Event, { type: 'shell.started' }>): TranscriptOperation[] {
    this.shellTaskIds.set(event.commandId, event.taskId);
    const task: TranscriptTask = {
      taskId: event.taskId, kind: 'shell', state: 'running', detached: false,
      outputTail: '', startedAt: now(),
    };
    this.tasks.set(task.taskId, task);
    return [
      { op: 'task.upsert', task },
      { op: 'taskref.upsert', item: { kind: 'taskref', refId: `ref-${task.taskId}`, taskId: task.taskId, at: now() } },
    ];
  }

  private shellOutput(event: Extract<Event, { type: 'shell.output' }>): TranscriptOperation[] {
    const taskId = this.shellTaskIds.get(event.commandId) ?? event.taskId ?? `shell-${event.commandId}`;
    this.shellTaskIds.set(event.commandId, taskId);
    const previous = this.tasks.get(taskId);
    const text = event.update.text ?? '';
    const task: TranscriptTask = previous ?? {
      taskId, kind: 'shell', state: 'running', detached: false, outputTail: '', startedAt: now(),
    };
    this.tasks.set(taskId, { ...task, outputTail: task.outputTail + text });
    const ops: TranscriptOperation[] = [];
    if (previous === undefined) ops.push({ op: 'task.upsert', task });
    if (text.length > 0) ops.push({ op: 'append', target: { type: 'task', taskId }, offset: task.outputTail.length, text });
    return ops;
  }

  private shellCompleted(event: Extract<Event, { type: 'shell.completed' }>): TranscriptOperation[] {
    const taskId = this.shellTaskIds.get(event.commandId) ?? event.taskId ?? `shell-${event.commandId}`;
    const previous = this.tasks.get(taskId);
    const task: TranscriptTask = {
      taskId, kind: 'shell', state: event.isError ? 'failed' : 'completed', detached: false,
      outputTail: previous?.outputTail ?? '', startedAt: previous?.startedAt ?? now(), endedAt: now(),
    };
    this.tasks.set(taskId, task);
    return [{ op: 'task.upsert', task }];
  }

  private ensureLiveStep(turnId: string, ops: TranscriptOperation[]): StepHeader {
    if (this.currentStep?.turnId === turnId) return this.currentStep;
    this.currentStep = { kind: 'step', stepId: `${turnId}.1`, turnId, ordinal: 1, state: 'running', startedAt: now() };
    ops.push({ op: 'step.upsert', turnId, step: this.currentStep });
    return this.currentStep;
  }

  private flushStreams(ops: TranscriptOperation[]): void {
    if (this.currentStep !== undefined && this.openAssistant !== undefined) {
      ops.push({ op: 'frame.upsert', turnId: this.currentStep.turnId, stepId: this.currentStep.stepId, frame: {
        kind: 'text', frameId: this.openAssistant.frameId, role: 'assistant', text: this.openAssistant.text,
      } });
    }
    if (this.currentStep !== undefined && this.openThinking !== undefined) {
      ops.push({ op: 'frame.upsert', turnId: this.currentStep.turnId, stepId: this.currentStep.stepId, frame: {
        kind: 'thinking', frameId: this.openThinking.frameId, text: this.openThinking.text,
      } });
    }
    this.openAssistant = undefined;
    this.openThinking = undefined;
  }

  private takePromptInput(prompt: string | undefined): QueuedPromptInput | undefined {
    const normalized = prompt ?? '';
    const exact = this.queuedPromptInputs.findIndex((input) => input.prompt === normalized);
    const index = exact === -1 && this.queuedPromptInputs.length === 1 ? 0 : exact;
    if (index === -1) return undefined;
    return this.queuedPromptInputs.splice(index, 1)[0];
  }

  private createAttachments(media: readonly MediaReference[]): {
    readonly ids: readonly string[];
    readonly ops: readonly TranscriptOperation[];
  } {
    const ids: string[] = [];
    const ops: TranscriptOperation[] = [];
    for (const [index, item] of media.entries()) {
      const attachmentId = `${this.agentId}.att.${++this.attachmentSeq}`;
      const attachment: TranscriptAttachment = {
        attachmentId,
        mediaType: mediaType(item),
        name: mediaName(item.url),
        source: attachmentSource(item.url),
        placeholder: `[${item.type[0]!.toUpperCase()}${item.type.slice(1)} #${String(index + 1)}]`,
      };
      ids.push(attachmentId);
      ops.push({ op: 'attachment.upsert', attachment });
    }
    return { ids, ops };
  }

  private nextFrameId(step: StepHeader): string {
    this.frameSeq += 1;
    return `${step.stepId}.f${this.frameSeq}`;
  }

  private marker(marker: string, payload: unknown, time = Date.now()): TranscriptOperation {
    this.markerSeq += 1;
    return {
      op: 'marker.upsert',
      item: { kind: 'marker', markerId: `${this.agentId}.m${this.markerSeq}`, marker, payload, at: new Date(time).toISOString() },
    };
  }

  private takeUsage(turnId: string): TranscriptUsage | undefined {
    const usages = this.stepUsage.get(turnId);
    this.stepUsage.delete(turnId);
    if (usages === undefined || usages.length === 0) return undefined;
    return usages.reduce<TranscriptUsage>((sum, usage) => ({
      inputTokens: (sum.inputTokens ?? 0) + usage.inputOther + usage.inputCacheCreation,
      outputTokens: (sum.outputTokens ?? 0) + usage.output,
      cachedTokens: (sum.cachedTokens ?? 0) + usage.inputCacheRead,
    }), {});
  }
}

function mapOrigin(origin: unknown): TurnOrigin {
  const value = origin as Record<string, unknown> | undefined;
  switch (value?.['kind']) {
    case 'user':
      return { kind: 'user' };
    case 'cron_job':
      return { kind: 'cron', taskId: stringValue(value['jobId']), payload: origin };
    case 'task':
    case 'background_task':
      return { kind: 'task', taskId: stringValue(value['taskId']) ?? 'unknown', payload: origin };
    case 'hook_result':
      return { kind: 'hook', payload: origin };
    case 'compaction_summary':
      return { kind: 'compaction', payload: origin };
    default:
      return { kind: 'other', payload: origin };
  }
}

function turnState(reason: string): TurnState {
  if (reason === 'completed') return 'completed';
  if (reason === 'cancelled') return 'cancelled';
  return 'failed';
}

function taskState(value: unknown): TranscriptTask['state'] {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return value;
    default:
      return 'running';
  }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => {
    switch (part.type) {
      case 'text': return part.text;
      case 'think': return part.think;
      case 'image_url': return '[Image]';
      case 'audio_url': return '[Audio]';
      case 'video_url': return '[Video]';
    }
  }).join('\n').trim();
}

function visibleMessageText(message: ContextMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.type === 'text' ? part.text : '')
    .join('\n')
    .trim();
}

function mediaReferences(message: ContextMessage): MediaReference[] {
  return message.content.flatMap((part): MediaReference[] => {
    if (part.type === 'image_url') return [{ type: 'image', url: part.imageUrl.url }];
    if (part.type === 'video_url') return [{ type: 'video', url: part.videoUrl.url }];
    if (part.type === 'audio_url') return [{ type: 'audio', url: part.audioUrl.url }];
    return [];
  });
}

function mediaType(media: MediaReference): string {
  const dataMime = /^data:([^;,]+)/i.exec(media.url)?.[1];
  if (dataMime !== undefined) return dataMime.toLowerCase();
  let path = media.url;
  try {
    path = new URL(media.url).pathname;
  } catch {
  }
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const known: Readonly<Record<string, string>> = {
    gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav',
    m4v: 'video/mp4', mov: 'video/quicktime', mp4: 'video/mp4', webm: 'video/webm',
  };
  return extension === undefined ? `${media.type}/*` : known[extension] ?? `${media.type}/*`;
}

function mediaName(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.split('/').at(-1);
    return name === undefined || name.length === 0 ? undefined : decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

function attachmentSource(url: string): TranscriptAttachment['source'] {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'file:' || protocol === 'https:' || protocol === 'http:') {
      return { kind: 'url', url };
    }
  } catch {
  }
  return undefined;
}

function readImportedContextSource(message: ContextMessage): string | undefined {
  for (const part of message.content) {
    if (part.type !== 'text') continue;
    const match = /^<imported_context source="([^"]*)">/.exec(part.text.trimStart());
    if (match === null) continue;
    return match[1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  }
  return undefined;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function timeValue(value: unknown): string | undefined {
  return typeof value === 'number' ? new Date(value).toISOString() : typeof value === 'string' ? value : undefined;
}

function now(): string {
  return new Date().toISOString();
}

function withoutEnvelope(event: Event): Record<string, unknown> {
  const { type: _type, sessionId: _sessionId, agentId: _agentId, ...payload } = event;
  return payload;
}
