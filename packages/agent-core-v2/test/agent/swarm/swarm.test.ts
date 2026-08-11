import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  SUBAGENT_SECTION,
} from '#/session/subagent/configSection';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSwarmService, type SessionSwarmRunResult, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { AgentSwarmService } from '#/agent/swarm/swarmService';
import { SwarmModel } from '#/agent/swarm/swarmOps';
import { SECONDARY_DERIVED_MODEL_ID } from '#/app/kosongConfig/secondaryModelOverlay';
import {
  MODELS_SECTION,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import { AgentSwarmToolInputSchema } from '#/agent/tools/agent-swarm/agent-swarm';
import { AgentSwarmTool } from '#/agent/tools/agent-swarm/agentSwarmTool';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { ModelCapability } from '#/kosong/contract/capability';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ExecutableToolContext } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { IConfigService } from '#/app/config/config';
import { normalizeAgentProfile, type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ISessionCollaborationService } from '#/features/collaboration/collaboration';
import { TEAM_COLLABORATION_FLAG_ID } from '#/features/collaboration/flag';
import { AgentCollaborationPolicyService } from '#/features/collaboration/agentPolicy';
import { BeforeToolExecuteEmitter } from '#/agent/toolExecutor/beforeToolExecuteEvent';

import { stubContextMemory, type StubContextMemory } from '../contextMemory/stubs';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';
import { stubLoopWithHooks } from '../loop/stubs';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../toolExecutor/stubs';
import { stubFlag } from '../../app/flag/stubs';

const signal = new AbortController().signal;

function context<Input>(
  args: Input,
  toolCallId = 'call_swarm',
): ExecutableToolContext & { readonly args: Input } {
  return { turnId: 0, toolCallId, args, signal };
}

function toolCall(name: string, id: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function hookContext(toolCalls: ToolCall[]): ResolvedToolExecutionHookContext {
  return {
    turnId: 0,
    signal,
    toolCall: toolCalls[0]!,
    toolCalls,
    args: {},
    execution: { approvalRule: toolCalls[0]!.name, execute: async () => ({ output: '' }) },
  };
}

function mockSwarmHost({
  run = vi.fn().mockResolvedValue([]),
  getSwarmItem = vi.fn().mockResolvedValue(undefined),
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly run?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly getSwarmItem?: (...args: any[]) => any;
} = {}) {
  return {
    swarmService: {
      _serviceBrand: undefined,
      getSwarmItem,
      launch: ((args) => ({
        batchId: 'test-swarm-batch',
        accepted: args.tasks,
        completion: run(args),
      })) as ISessionSwarmService['launch'],
      run,
      cancel: vi.fn(),
      settle: async () => {},
    },
    callerAgentId: 'main',
  };
}

function mockSwarmMode() {
  return { _serviceBrand: undefined, isActive: false, enter: vi.fn(), exit: vi.fn() };
}

function stubConfig(section?: {
  timeoutMs?: number;
  model?: string;
  defaultEffort?: string;
  models?: Readonly<Record<string, unknown>>;
}): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (domain: string) => {
      if (domain === SUBAGENT_SECTION) {
        return section?.timeoutMs === undefined ? undefined : { timeoutMs: section.timeoutMs };
      }
      if (domain === SECONDARY_MODEL_SECTION) {
        return section?.model === undefined
          ? undefined
          : section.defaultEffort === undefined
            ? { model: section.model }
            : { model: section.model, defaultEffort: section.defaultEffort };
      }
      if (domain === MODELS_SECTION) return section?.models;
      return undefined;
    },
  } as unknown as IConfigService;
}

const DEFAULT_CALLER_PROFILE: AgentProfile = normalizeAgentProfile({
  name: 'agent',
  description: 'test caller',
  systemPrompt: () => 'caller',
});

const DEFAULT_SWARM_TARGET_PROFILES: readonly AgentProfile[] = [
  normalizeAgentProfile({
    name: 'coder',
    description: 'test coder',
    systemPrompt: () => 'coder',
  }),
  normalizeAgentProfile({
    name: 'explore',
    description: 'test explorer',
    systemPrompt: () => 'explore',
  }),
];

function stubSwarmCatalog(
  defaultProfile: AgentProfile = DEFAULT_CALLER_PROFILE,
  targetProfiles: readonly AgentProfile[] = DEFAULT_SWARM_TARGET_PROFILES,
): ISessionAgentProfileCatalog {
  const profiles = [defaultProfile, ...targetProfiles];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (name: string) => profiles.find((profile) => profile.name === name),
    getDefault: () => defaultProfile,
    list: () => profiles,
  } as unknown as ISessionAgentProfileCatalog;
}

function stubCallerProfile(
  data?: {
    readonly profileName?: string;
    readonly subagents?: readonly string[];
    readonly modelAlias?: string;
    readonly thinkingLevel?: string;
  },
): IAgentProfileService {
  return {
    _serviceBrand: undefined,
    data: () => data ?? { profileName: undefined },
  } as unknown as IAgentProfileService;
}

function stubModelCatalog(
  capabilities: Readonly<Record<string, ModelCapability>> = {},
): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (id: string) => {
      const capability = capabilities[id];
      if (capability === undefined) throw new Error(`Model "${id}" is not configured.`);
      return {
        id,
        name: id,
        displayName: id,
        providerName: 'test-provider',
        maxContextSize: capability.max_context_tokens,
        capabilities: capability,
      };
    },
  } as unknown as IModelCatalog;
}

const TEST_MODEL_CAPABILITY: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 262_144,
};

function stubTeamCollaboration(): ISessionCollaborationService {
  return {
    _serviceBrand: undefined,
    isActive: () => true,
    snapshot: vi.fn().mockResolvedValue({ members: [], assignments: [] }),
    prepareSwarmBatch: vi.fn().mockImplementation(async (input) => ({
      batchId: 'team-batch',
      assignments: input.assignments.map((assignment: {
        readonly assignmentId: string;
        readonly description: string;
        readonly displayName?: string;
        readonly profileName: string;
        readonly model?: string;
      }) => ({
        id: assignment.assignmentId,
        description: assignment.description,
        displayName: assignment.displayName,
        profileName: assignment.profileName,
        model: assignment.model,
      })),
    })),
    bindAssignment: vi.fn(),
    scheduleSwarmBatch: vi.fn().mockResolvedValue(undefined),
    settleAssignment: vi.fn(),
    settleBatch: vi.fn(),
  } as unknown as ISessionCollaborationService;
}

function stubAgentTasks(): IAgentTaskService {
  let index = 0;
  return {
    registerTask: vi.fn(() => {
      index += 1;
      return `team-callback-${String(index)}`;
    }),
  } as unknown as IAgentTaskService;
}

describe('AgentSwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionGateRan: boolean;
  let formatDenyMessage: Mock<(message: string) => string>;
  let contextMemory: StubContextMemory;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    contextMemory = stubContextMemory();
    ix.stub(IAgentContextMemoryService, contextMemory);
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.stub(IAgentLifecycleService, {});
    ix.stub(ISessionSwarmService, {
      getSwarmItem: async () => undefined,
      run: async () => [],
      cancel: () => {},
      settle: async () => {},
    });
    executorEvents = stubToolExecutorEvents();
    permissionGateRan = false;
    ix.stub(IAgentToolExecutorService, executorEvents.executor);
    formatDenyMessage = vi.fn((message: string) => message);
    ix.stub(IAgentToolApprovalService, { formatDenyMessage });
    registerTestAgentWire(ix, testWireScope('wire', 'swarm-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.set(IAgentSwarmService, new SyncDescriptor(AgentSwarmService));
  });
  afterEach(() => disposables.dispose());

  async function fire(
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    disposables.add(
      executorEvents.executor.onBeforeExecuteTool(() => {
        permissionGateRan = true;
      }),
    );
    return executorEvents.fireBeforeExecute(ctx);
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const swarm = ix.get(IAgentSwarmService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', swarmMode: true },
      { type: 'agent.status.updated', swarmMode: false },
      { type: 'context.spliced', start: 0, deleteCount: 1, messages: [] },
    ]);
  });

  it('reminds the orchestrator to reuse only related idle team members', () => {
    ix.get(IAgentSwarmService).enter('manual');

    const reminder = contextMemory.messages[0]?.content[0];
    expect(reminder?.type).toBe('text');
    expect(reminder?.type === 'text' ? reminder.text : '').toContain('inspect TeamStatus');
    expect(reminder?.type === 'text' ? reminder.text : '').toContain('resume_agent_ids');
    expect(reminder?.type === 'text' ? reminder.text : '').toContain('never resume a busy member');
  });

  it('injects the coordination reminder after an AgentSwarm tool enters swarm mode', () => {
    ix.get(IAgentSwarmService).enter('tool');

    const reminder = contextMemory.messages[0]?.content[0];
    expect(reminder?.type).toBe('text');
    expect(reminder?.type === 'text' ? reminder.text : '').toContain('coordinator and integrator');
    expect(reminder?.type === 'text' ? reminder.text : '').toContain('automatically wakes its direct delegator');
    expect(reminder?.type === 'text' ? reminder.text : '').toContain('do not call TeamWait merely to await');
  });

  it('dispatch persists enter/exit records and replay rebuilds the trigger (silent)', async () => {
    const swarm = ix.get(IAgentSwarmService);
    swarm.enter('manual');

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'swarm-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'swarm_mode.enter', trigger: 'manual', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fresh = registerTestAgentWire(ix2, testWireScope('wire', 'swarm-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    await restoreTestAgentWire(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'swarm-replay'),
      records,
    );
    expect(fresh.getModel(SwarmModel)).toBe('manual');
  });

  it('blocks a batch with multiple AgentSwarm calls before any other adjudication', async () => {
    ix.get(IAgentSwarmService);
    const decision = await fire(
      hookContext([toolCall('AgentSwarm', 'call_swarm_1'), toolCall('AgentSwarm', 'call_swarm_2')]),
    );

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('one swarm at a time'),
        isError: true,
      },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('blocks an AgentSwarm call mixed with other tools in one batch', async () => {
    ix.get(IAgentSwarmService);
    const decision = await fire(
      hookContext([toolCall('AgentSwarm', 'call_swarm'), toolCall('Bash', 'call_bash')]),
    );

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('must be the only tool call'),
        isError: true,
      },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('abstains on a single AgentSwarm call', async () => {
    ix.get(IAgentSwarmService);
    const decision = await fire(hookContext([toolCall('AgentSwarm', 'call_swarm')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('abstains on tool batches without AgentSwarm', async () => {
    ix.get(IAgentSwarmService);
    const decision = await fire(
      hookContext([toolCall('Bash', 'call_bash'), toolCall('Read', 'call_read')]),
    );

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });
});

describe('AgentCollaborationPolicyService', () => {
  it('vetoes ordinary Agent delegation while a durable Team is active', async () => {
    const beforeExecute = new BeforeToolExecuteEmitter();
    const executor = {
      onBeforeExecuteTool: beforeExecute.event,
    } as unknown as IAgentToolExecutorService;
    const collaboration = {
      ready: Promise.resolve(),
      isActive: () => true,
    } as unknown as ISessionCollaborationService;
    const policy = new AgentCollaborationPolicyService(executor, collaboration);

    try {
      const decision = await beforeExecute.fireBeforeExecute(
        hookContext([toolCall('Agent', 'agent-call')]),
      );

      expect(decision?.veto).toMatchObject({ isError: true });
      expect(decision?.veto?.output).toContain('Use AgentSwarm');
      expect(decision?.veto?.output).toContain('notifies the direct delegator automatically');
    } finally {
      policy.dispose();
      beforeExecute.dispose();
    }
  });
});

describe('AgentSwarmTool', () => {
  it('applies one subagent_type across templated subagents', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: {
              kind: 'spawn',
              index: 1,
              item: 'src/a.ts',
              prompt: 'Review src/a.ts',
            },
            profileName: 'explore',
            parentToolCallId: 'call_swarm',
            prompt: 'Review src/a.ts',
            description: 'Review files #1 (explore)',
            runInBackground: false,
          },
          agentId: 'agent-explore-1',
          status: 'completed',
          result: 'explore result a',
        },
        {
          task: {
            kind: 'spawn',
            data: {
              kind: 'spawn',
              index: 2,
              item: 'src/b.ts',
              prompt: 'Review src/b.ts',
            },
            profileName: 'explore',
            parentToolCallId: 'call_swarm',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (explore)',
            runInBackground: false,
          },
          agentId: 'agent-explore-2',
          status: 'completed',
          result: 'explore result b',
        },
      ]),
    });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), swarmMode, stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
      subagent_type: 'explore',
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        subagent_type: { type: 'string' },
      },
    });
    expect(
      (
        tool.parameters['properties'] as Record<
          string,
          { readonly description?: string }
        >
      )['subagent_type']?.description,
    ).toBe(
      'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
    );
    expect(Object.keys(tool.parameters['properties'] as Record<string, unknown>).at(-1)).toBe(
      'model',
    );

    const result = await executeTool(tool, context(input));

    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(host.swarmService.run).toHaveBeenCalledTimes(1);
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      expect.objectContaining({
        kind: 'spawn',
        data: expect.objectContaining({
          kind: 'spawn',
          index: 1,
          item: 'src/a.ts',
          prompt: 'Review src/a.ts',
          profileName: 'explore',
        }),
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/a.ts',
        description: 'Review files #1 (explore)',
        swarmIndex: 1,
        swarmItem: 'src/a.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
      expect.objectContaining({
        kind: 'spawn',
        data: expect.objectContaining({
          kind: 'spawn',
          index: 2,
          item: 'src/b.ts',
          prompt: 'Review src/b.ts',
          profileName: 'explore',
        }),
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/b.ts',
        description: 'Review files #2 (explore)',
        swarmIndex: 2,
        swarmItem: 'src/b.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 2</summary>',
        '<subagent agent_id="agent-explore-1" item="src/a.ts" outcome="completed">explore result a</subagent>',
        '<subagent agent_id="agent-explore-2" item="src/b.ts" outcome="completed">explore result b</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('does not expose permission rule argument matching', () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });

    expect(execution.isError).toBeUndefined();
    if (execution.isError === true) throw new Error('expected a successful execution');
    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
  });

  it('returns a durable launch receipt without waiting when Team Mode is enabled', async () => {
    const host = mockSwarmHost();
    const scheduleSwarmBatch = vi.fn().mockResolvedValue(undefined);
    const collaboration = {
      _serviceBrand: undefined,
      isActive: () => true,
      snapshot: vi.fn().mockResolvedValue({ members: [], assignments: [] }),
      prepareSwarmBatch: vi.fn().mockResolvedValue({
        batchId: 'team-batch',
        assignments: [
          {
            id: 'assignment-1',
            description: 'Review files #1 (coder)',
            displayName: 'reviewer-a',
            profileName: 'coder',
            model: 'main-model',
          },
          {
            id: 'assignment-2',
            description: 'Review files #2 (explore)',
            displayName: 'reviewer-b',
            profileName: 'explore',
            model: 'main-model',
          },
        ],
      }),
      bindAssignment: vi.fn(),
      scheduleSwarmBatch,
      settleAssignment: vi.fn(),
      settleBatch: vi.fn(),
    } as unknown as ISessionCollaborationService;
    const registerTask = vi.fn((_task) => `team-callback-${String(registerTask.mock.calls.length)}`);
    const agentTasks = { registerTask } as unknown as IAgentTaskService;
    const tool = new AgentSwarmTool(
      host.swarmService,
      makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
      mockSwarmMode(),
      stubConfig({ models: { 'main-model': {} } }),
      stubFlag((id) => id === TEAM_COLLABORATION_FLAG_ID),
      stubSwarmCatalog(),
      stubCallerProfile({ modelAlias: 'main-model', thinkingLevel: 'high' }),
      stubModelCatalog({
        'main-model': { image_in: false, video_in: false, audio_in: false, thinking: true, tool_use: true, max_context_tokens: 262_144 },
      }),
      collaboration,
      agentTasks,
    );

    const result = await executeTool(tool, context({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: [
        { item: 'src/a.ts', task_key: 'review-a', display_name: 'reviewer-a', subagent_type: 'coder', model: 'main-model' },
        { item: 'src/b.ts', task_key: 'review-b', display_name: 'reviewer-b', subagent_type: 'explore', model: 'main-model' },
      ],
    }));

    expect(scheduleSwarmBatch).toHaveBeenCalledOnce();
    expect(scheduleSwarmBatch).toHaveBeenCalledWith(expect.objectContaining({
      batchId: 'team-batch',
      tasks: expect.arrayContaining([
        expect.objectContaining({ runInBackground: true }),
      ]),
    }));
    expect(host.swarmService.run).not.toHaveBeenCalled();
    expect(result.output).toContain('<agent_swarm_started>');
    expect(result.output).toContain('<batch_id>team-batch</batch_id>');
    expect(result.output).toContain('model="main-model"');
    expect(result.output).toContain('<automatic_notification>true</automatic_notification>');
    expect(result.output).toContain('callback_task_id="team-callback-1"');
    expect(result.output).toContain('do not call TeamWait merely to wait');
    expect(result.stopTurn).toBe(true);
    expect(registerTask).toHaveBeenCalledTimes(2);
    expect(collaboration.prepareSwarmBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        assignments: expect.arrayContaining([
          expect.objectContaining({ model: 'main-model', profileName: 'coder' }),
          expect.objectContaining({ model: 'main-model', profileName: 'explore' }),
        ]),
      }),
    );
  });

  it('allows one durable read item without scheduling an independent validator', async () => {
    const host = mockSwarmHost();
    const collaboration = stubTeamCollaboration();
    const tool = new AgentSwarmTool(
      host.swarmService,
      makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
      mockSwarmMode(),
      stubConfig({ models: { 'main-model': {} } }),
      stubFlag((id) => id === TEAM_COLLABORATION_FLAG_ID),
      stubSwarmCatalog(),
      stubCallerProfile({ modelAlias: 'main-model', thinkingLevel: 'high' }),
      stubModelCatalog({ 'main-model': TEST_MODEL_CAPABILITY }),
      collaboration,
      stubAgentTasks(),
    );

    const result = await executeTool(tool, context({
      description: 'Inspect one subsystem',
      prompt_template: 'Inspect {{item}}',
      items: [{
        item: 'src/runtime',
        task_key: 'inspect-runtime',
        display_name: 'runtime-reader',
        subagent_type: 'explore',
        model: 'main-model',
        workspace_access: 'read',
        validation: 'required',
      }],
    }));

    expect(result.isError).toBeUndefined();
    expect(collaboration.prepareSwarmBatch).toHaveBeenCalledWith(expect.objectContaining({
      assignments: [expect.objectContaining({
        taskKey: 'inspect-runtime',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
      })],
    }));
    expect(collaboration.scheduleSwarmBatch).toHaveBeenCalledOnce();
  });

  it('requires a per-item model choice when Team Mode has multiple routable aliases', async () => {
    const host = mockSwarmHost();
    const collaboration = stubTeamCollaboration();
    const tool = new AgentSwarmTool(
      host.swarmService,
      makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
      mockSwarmMode(),
      stubConfig({ models: { fast: {}, deep: {} } }),
      stubFlag((id) => id === TEAM_COLLABORATION_FLAG_ID),
      stubSwarmCatalog(),
      stubCallerProfile({ modelAlias: 'deep', thinkingLevel: 'high' }),
      stubModelCatalog({ fast: TEST_MODEL_CAPABILITY, deep: TEST_MODEL_CAPABILITY }),
      collaboration,
    );

    const result = await executeTool(tool, context({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: [
        { item: 'src/a.ts', task_key: 'review-a', display_name: 'quick-reviewer', subagent_type: 'coder' },
        { item: 'src/b.ts', task_key: 'review-b', display_name: 'deep-reviewer', subagent_type: 'explore' },
      ],
      model: 'fast',
    }));

    expect(result).toMatchObject({
      isError: true,
      output: 'Team Mode requires every new AgentSwarm item to provide an exact model alias when multiple models are available.',
    });
    expect(collaboration.prepareSwarmBatch).not.toHaveBeenCalled();
  });

  it('rejects an unknown per-item Team model alias before persisting assignments', async () => {
    const host = mockSwarmHost();
    const collaboration = stubTeamCollaboration();
    const tool = new AgentSwarmTool(
      host.swarmService,
      makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
      mockSwarmMode(),
      stubConfig({ models: { fast: {}, deep: {} } }),
      stubFlag((id) => id === TEAM_COLLABORATION_FLAG_ID),
      stubSwarmCatalog(),
      stubCallerProfile({ modelAlias: 'deep', thinkingLevel: 'high' }),
      stubModelCatalog({ fast: TEST_MODEL_CAPABILITY, deep: TEST_MODEL_CAPABILITY }),
      collaboration,
    );

    const result = await executeTool(tool, context({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: [
        { item: 'src/a.ts', task_key: 'review-a', display_name: 'quick-reviewer', subagent_type: 'coder', model: 'fast' },
        { item: 'src/b.ts', task_key: 'review-b', display_name: 'deep-reviewer', subagent_type: 'explore', model: 'missing' },
      ],
    }));

    expect(result).toMatchObject({
      isError: true,
      output: 'Unknown Team subagent model alias: "missing".',
    });
    expect(collaboration.prepareSwarmBatch).not.toHaveBeenCalled();
  });

  it('routes each Team item to its selected model and persists the aliases', async () => {
    const host = mockSwarmHost();
    const collaboration = stubTeamCollaboration();
    const tool = new AgentSwarmTool(
      host.swarmService,
      makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
      mockSwarmMode(),
      stubConfig({ models: { fast: {}, deep: {} } }),
      stubFlag((id) => id === TEAM_COLLABORATION_FLAG_ID),
      stubSwarmCatalog(),
      stubCallerProfile({ modelAlias: 'deep', thinkingLevel: 'high' }),
      stubModelCatalog({ fast: TEST_MODEL_CAPABILITY, deep: TEST_MODEL_CAPABILITY }),
      collaboration,
      stubAgentTasks(),
    );

    const result = await executeTool(tool, context({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: [
        { item: 'src/a.ts', task_key: 'review-a', display_name: 'quick-reviewer', subagent_type: 'coder', model: 'fast' },
        { item: 'src/b.ts', task_key: 'review-b', display_name: 'deep-reviewer', subagent_type: 'explore', model: 'deep' },
      ],
    }));

    expect(result.isError).toBeUndefined();
    expect(collaboration.scheduleSwarmBatch).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [
        expect.objectContaining({ binding: { model: 'fast', thinking: undefined } }),
        expect.objectContaining({ binding: { model: 'deep', thinking: undefined } }),
      ],
    }));
    expect(collaboration.prepareSwarmBatch).toHaveBeenCalledWith(expect.objectContaining({
      assignments: [
        expect.objectContaining({ displayName: 'quick-reviewer', model: 'fast' }),
        expect.objectContaining({ displayName: 'deep-reviewer', model: 'deep' }),
      ],
    }));
    expect(result.output).toContain('model="fast"');
    expect(result.output).toContain('model="deep"');
  });

  it('marks the durable Team batch failed when scheduler admission throws', async () => {
    const host = mockSwarmHost();
    const collaboration = {
      _serviceBrand: undefined,
      isActive: () => true,
      snapshot: vi.fn().mockResolvedValue({ members: [], assignments: [] }),
      prepareSwarmBatch: vi.fn().mockResolvedValue({
        batchId: 'team-batch',
        assignments: [
          {
            id: 'assignment-1',
            description: 'Review files #1 (coder)',
            displayName: 'reviewer-a',
            profileName: 'coder',
            model: 'main-model',
          },
          {
            id: 'assignment-2',
            description: 'Review files #2 (explore)',
            displayName: 'reviewer-b',
            profileName: 'explore',
            model: 'main-model',
          },
        ],
      }),
      bindAssignment: vi.fn(),
      scheduleSwarmBatch: vi.fn().mockRejectedValue(new Error('scheduler unavailable')),
      settleAssignment: vi.fn().mockResolvedValue(undefined),
      settleBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as ISessionCollaborationService;
    const tool = new AgentSwarmTool(
      host.swarmService,
      makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
      mockSwarmMode(),
      stubConfig({ models: { 'main-model': {} } }),
      stubFlag((id) => id === TEAM_COLLABORATION_FLAG_ID),
      stubSwarmCatalog(),
      stubCallerProfile({ modelAlias: 'main-model', thinkingLevel: 'high' }),
      stubModelCatalog({
        'main-model': { image_in: false, video_in: false, audio_in: false, thinking: true, tool_use: true, max_context_tokens: 262_144 },
      }),
      collaboration,
      stubAgentTasks(),
    );

    const result = await executeTool(tool, context({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: [
        { item: 'src/a.ts', task_key: 'review-a', display_name: 'reviewer-a', subagent_type: 'coder', model: 'main-model' },
        { item: 'src/b.ts', task_key: 'review-b', display_name: 'reviewer-b', subagent_type: 'explore', model: 'main-model' },
      ],
    }));

    expect(result).toMatchObject({ isError: true, output: 'scheduler unavailable' });
    expect(collaboration.settleAssignment).toHaveBeenCalledTimes(2);
    expect(collaboration.settleAssignment).toHaveBeenCalledWith(expect.objectContaining({
      assignmentId: 'assignment-1',
      status: 'failed',
      error: 'scheduler unavailable',
    }));
    expect(collaboration.settleBatch).toHaveBeenCalledWith({
      batchId: 'team-batch',
      status: 'failed',
    });
  });

  it('description states the enforced input requirements', () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());
    expect(tool.description).toContain('at least 2');
    expect(tool.description).toContain('{{item}}');
    expect(tool.description.toLowerCase()).toContain('distinct');
    expect(tool.description).toContain('reusableMembers');
    expect(tool.description).toContain('genuinely relevant');
  });

  it('uses the persisted caller allowlist instead of the current catalog profile', async () => {
    const host = mockSwarmHost();
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['coder'],
      systemPrompt: () => 'orchestrator',
    });
    const tool = new AgentSwarmTool(
      host.swarmService,
      makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
      mockSwarmMode(),
      stubConfig(),
      stubFlag(true),
      stubSwarmCatalog(caller),
      stubCallerProfile({ profileName: 'deleted-profile', subagents: ['explore'] }),
      stubModelCatalog(),
    );

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        subagent_type: 'coder',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Subagent type "coder" is not allowed for this agent');
    expect(host.swarmService.run).not.toHaveBeenCalled();
  });

  it('rejects invalid launch shapes at execution time', async () => {
    const cases = [
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
        },
        output: 'AgentSwarm supports at most 128 subagents.',
      },
      {
        input: {
          description: 'Review one file',
          prompt_template: 'Review {{item}}',
          items: ['src/only.ts'],
        },
        output: 'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
      },
      {
        input: {
          description: 'Review files',
          items: ['src/a.ts', 'src/b.ts'],
        },
        output: 'prompt_template is required when items are provided.',
      },
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review files',
          items: ['src/a.ts', 'src/b.ts'],
        },
        output: 'prompt_template must include the {{item}} placeholder.',
      },
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['same', 'same'],
        },
        output:
          'Duplicate subagent prompts from items 1 and 2. AgentSwarm requires distinct subagents.',
      },
    ];

    for (const testCase of cases) {
      const host = mockSwarmHost();
      const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());

      const result = await executeTool(tool, context(testCase.input));

      expect(result.output).toBe(testCase.output);
      expect(result.isError).toBe(true);
      expect(host.swarmService.run).not.toHaveBeenCalled();
    }
  });

  it('resumes mapped agents before spawning item subagents', async () => {
    const run = vi.fn(
      async <T>({
        tasks,
      }: {
        tasks: readonly SessionSwarmTask<T>[];
      }): Promise<Array<SessionSwarmRunResult<T>>> => {
        return tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: `result ${String(index + 1)}`,
        }));
      },
    );
    const persistedItems: Record<string, string> = {
      'agent-old-1': 'src/old-a.ts',
      'agent-old-2': 'src/old-b.ts',
    };
    const getSwarmItem = vi.fn(
      async ({ agentId }: { readonly agentId: string }) => persistedItems[agentId],
    );
    const host = mockSwarmHost({ run, getSwarmItem });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());
    const input = {
      description: 'Finish review',
      subagent_type: 'explore',
      prompt_template: 'Review {{item}}',
      items: ['src/new.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
        'agent-old-2': 'Continue previous review B',
      },
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume one agent',
        resume_agent_ids: { 'agent-old-1': 'Continue previous review A' },
      }).success,
    ).toBe(true);

    const result = await executeTool(tool, context(input));

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-2',
    });
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      expect.objectContaining({
        kind: 'resume',
        data: expect.objectContaining({
          kind: 'resume',
          index: 1,
          agentId: 'agent-old-1',
          item: 'src/old-a.ts',
          prompt: 'Continue previous review A',
        }),
        profileName: 'subagent',
        parentToolCallId: 'call_swarm',
        prompt: 'Continue previous review A',
        description: 'Finish review #1 (resume)',
        swarmIndex: 1,
        swarmItem: 'src/old-a.ts',
        runInBackground: false,
        resumeAgentId: 'agent-old-1',
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
      expect.objectContaining({
        kind: 'resume',
        data: expect.objectContaining({
          kind: 'resume',
          index: 2,
          agentId: 'agent-old-2',
          item: 'src/old-b.ts',
          prompt: 'Continue previous review B',
        }),
        profileName: 'subagent',
        parentToolCallId: 'call_swarm',
        prompt: 'Continue previous review B',
        description: 'Finish review #2 (resume)',
        swarmIndex: 2,
        swarmItem: 'src/old-b.ts',
        runInBackground: false,
        resumeAgentId: 'agent-old-2',
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
      expect.objectContaining({
        kind: 'spawn',
        data: expect.objectContaining({
          kind: 'spawn',
          index: 3,
          item: 'src/new.ts',
          prompt: 'Review src/new.ts',
          profileName: 'explore',
        }),
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/new.ts',
        description: 'Finish review #3 (explore)',
        swarmIndex: 3,
        swarmItem: 'src/new.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 3</summary>',
        '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">result 1</subagent>',
        '<subagent mode="resume" agent_id="agent-old-2" item="src/old-b.ts" outcome="completed">result 2</subagent>',
        '<subagent agent_id="agent-new-3" item="src/new.ts" outcome="completed">result 3</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('allows a single resumed subagent without item subagents', async () => {
    const run = vi.fn(
      async <T>({
        tasks,
      }: {
        tasks: readonly SessionSwarmTask<T>[];
      }): Promise<Array<SessionSwarmRunResult<T>>> => {
        return tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: 'resumed result',
        }));
      },
    );
    const getSwarmItem = vi.fn(async () => 'src/old-a.ts');
    const host = mockSwarmHost({ run, getSwarmItem });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());
    const input = {
      description: 'Resume review',
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
      },
    };

    const result = await executeTool(tool, context(input));

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      expect.objectContaining({
        kind: 'resume',
        data: expect.objectContaining({
          kind: 'resume',
          index: 1,
          agentId: 'agent-old-1',
          item: 'src/old-a.ts',
          prompt: 'Continue previous review A',
        }),
        profileName: 'subagent',
        parentToolCallId: 'call_swarm',
        prompt: 'Continue previous review A',
        description: 'Resume review #1 (resume)',
        swarmIndex: 1,
        swarmItem: 'src/old-a.ts',
        runInBackground: false,
        resumeAgentId: 'agent-old-1',
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      }),
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1</summary>',
        '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">resumed result</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
  });

  it('reports failed subagents inside the XML result without failing the tool', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: tasks[1],
          agentId: 'agent-coder-2',
          status: 'failed',
          error: 'Agent timed out after 30s.',
        },
      ]),
    });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, failed: 1</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('passes the configured subagent timeout to swarm tasks', async () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig({ timeoutMs: 5_000 }), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());

    await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(host.swarmService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({ timeout: 5_000 }),
          expect.objectContaining({ timeout: 5_000 }),
        ],
      }),
    );
  });

  it('resolves spawn task bindings from the configured secondary model', async () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig({ model: 'provider/secondary', defaultEffort: 'low' }), stubFlag(true), stubSwarmCatalog(), stubCallerProfile({ modelAlias: 'main-model', thinkingLevel: 'high' }), stubModelCatalog());

    await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(host.swarmService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({ binding: { model: SECONDARY_DERIVED_MODEL_ID, thinking: 'low' } }),
          expect.objectContaining({ binding: { model: SECONDARY_DERIVED_MODEL_ID, thinking: 'low' } }),
        ],
      }),
    );
  });

  it('lets the tool call opt back into the primary model', async () => {
    const host = mockSwarmHost();
    const secondaryCoder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'test coder',
      modelPreference: 'secondary',
      systemPrompt: () => 'coder',
    });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig({ model: 'provider/secondary', defaultEffort: 'low' }), stubFlag(true), stubSwarmCatalog(DEFAULT_CALLER_PROFILE, [secondaryCoder]), stubCallerProfile({ modelAlias: 'main-model', thinkingLevel: 'high' }), stubModelCatalog());

    await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        model: 'primary',
      }),
    );

    expect(host.swarmService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({ binding: { model: 'main-model', thinking: 'high' } }),
          expect.objectContaining({ binding: { model: 'main-model', thinking: 'high' } }),
        ],
      }),
    );
  });

  it('advertises both selectable models in the description only when configured', async () => {
    const host = mockSwarmHost();
    const configured = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig({ model: 'provider/secondary' }), stubFlag(true), stubSwarmCatalog(), stubCallerProfile({ modelAlias: 'main-model' }), stubModelCatalog({
      'provider/secondary': { image_in: true, video_in: false, audio_in: false, thinking: true, tool_use: true, max_context_tokens: 262_144 },
      'main-model': { image_in: false, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 262_144 },
    }));

    expect(configured.description).toContain('Available models (pass via model):');
    expect(configured.description).toContain(
      '- secondary: provider/secondary (default) — the configured secondary model; prefer it for routine subagent tasks; capabilities: image_in, thinking, tool_use',
    );
    expect(configured.description).toContain(
      '- primary: main-model — the main model you are running on; use it for hard, quality-sensitive subagent tasks; capabilities: tool_use',
    );

    const unconfigured = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile({ modelAlias: 'main-model' }), stubModelCatalog());

    expect(unconfigured.description).not.toContain('Available models');
  });

  it('reads secondary capabilities from the derived entry when the recipe carries patch fields', async () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig({ model: 'provider/secondary', defaultEffort: 'low' }), stubFlag(true), stubSwarmCatalog(), stubCallerProfile({ modelAlias: 'main-model' }), stubModelCatalog({
      [SECONDARY_DERIVED_MODEL_ID]: { image_in: false, video_in: false, audio_in: false, thinking: true, tool_use: true, max_context_tokens: 131_072 },
      'main-model': { image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true, max_context_tokens: 262_144 },
    }));

    expect(tool.description).toContain(
      '- secondary: provider/secondary (default) — the configured secondary model; prefer it for routine subagent tasks; capabilities: thinking, tool_use',
    );
    expect(tool.description).toContain('capabilities: image_in, tool_use');
  });

  it('omits the capabilities suffix for models the catalog cannot resolve', async () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig({ model: 'provider/secondary' }), stubFlag(true), stubSwarmCatalog(), stubCallerProfile({ modelAlias: 'main-model' }), stubModelCatalog());

    expect(tool.description).toContain('- secondary: provider/secondary (default)');
    expect(tool.description).toContain('- primary: main-model');
    expect(tool.description).not.toContain('capabilities:');
  });

  it('omits resume hint when incomplete subagents have no agent ids', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          status: 'failed',
          error: 'Agent did not start.',
        },
        {
          task: tasks[1],
          status: 'failed',
          error: 'Agent also did not start.',
        },
      ]),
    });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>failed: 2</summary>',
        '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
        '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
  });

  it('reports partial aborted subagents inside the XML result', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: tasks[1],
          agentId: 'agent-coder-2',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          task: tasks[2],
          status: 'aborted',
          state: 'not_started',
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]),
    });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode(), stubConfig(), stubFlag(true), stubSwarmCatalog(), stubCallerProfile(), stubModelCatalog());

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, aborted: 2</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
        '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });
});
