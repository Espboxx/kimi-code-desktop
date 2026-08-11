/**
 * `tools` domain — `AgentSwarmTool` implementation (the `AgentSwarm`
 * tool).
 *
 * Launches a batch of child agents (an ordinary Agent scope each) through the
 * session swarm coordinator (`ISessionSwarmService`) and renders the
 * per-subagent XML result. Reads persisted swarm item labels through the
 * Session-scoped coordinator so later `resume_agent_ids` calls relabel
 * resumed subagents like v1. When the caller has a model bound, the tool
 * resolves the explicit or target-profile model preference up front via
 * `resolveSubagentBinding` (against `IConfigService`, `IFlagService`,
 * `ISessionAgentProfileCatalog`, and the caller's `IAgentProfileService`) and
 * threads it through the swarm tasks; otherwise binding is left to the
 * service, which keeps its own "no model bound" check and inherit-caller
 * fallback. The advertised `model` parameter lists the secondary/primary
 * pair via `buildSubagentModelDescriptions`, suffixing each line with the
 * entry's capability flags resolved through `IModelCatalog`. Swarm mode is
 * entered through `IAgentSwarmService`; the caller's agent id comes from
 * `IAgentScopeContext`. In an active Team, stages durable assignments through
 * the Session-scoped collaboration service and registers their completion
 * observers through the Agent-scoped task service. Pure tool — owns no scoped
 * state.
 *
 * Registered via the module-level `registerAgentToolService(IAgentSwarmTool,
 * AgentSwarmTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { BugIndicatingError, Error2, ErrorCodes } from '#/errors';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionSwarmService, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
} from '#/app/agentProfileCatalog/profile-shared';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IAgentTaskService } from '#/agent/task/task';
import {
  buildSubagentModelDescriptions,
  buildTeamSubagentModelDescriptions,
  listRoutableSubagentModels,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  stripSubagentModelParameter,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import {
  AgentSwarmToolInputSchema,
  IAgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  type AgentSwarmToolInput,
} from './agent-swarm';
import { randomUUID } from 'node:crypto';
import { ISessionCollaborationService } from '#/features/collaboration/collaboration';
import { TEAM_COLLABORATION_FLAG_ID } from '#/features/collaboration/flag';
import { TeamAssignmentTask } from '#/features/collaboration/teamAssignmentTask';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';

const AGENT_SWARM_PARAMETERS = toInputJsonSchema(AgentSwarmToolInputSchema);
const AGENT_SWARM_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_SWARM_PARAMETERS);

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
  readonly displayName?: string;
  readonly profileName: string;
  readonly model?: string;
  readonly taskKey?: string;
  readonly dependsOn: readonly string[];
  readonly workspaceMode: 'shared_readonly' | 'isolated_write';
  readonly validationMode: 'none' | 'required';
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
  readonly taskKey?: string;
  readonly dependsOn: readonly string[];
  readonly workspaceMode: 'shared_readonly' | 'isolated_write';
  readonly validationMode: 'none' | 'required';
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface NormalizedSwarmItem {
  readonly item: string;
  readonly taskKey?: string;
  readonly dependsOn: readonly string[];
  readonly displayName?: string;
  readonly profileName: string;
  readonly model?: string;
  readonly workspaceMode: 'shared_readonly' | 'isolated_write';
  readonly validationMode: 'none' | 'required';
  readonly resumeAgentId?: string;
}

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements IAgentSwarmTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentSwarm' as const;

  get parameters(): Record<string, unknown> {
    return this.teamModeEnabled() || this.flags.enabled(SECONDARY_MODEL_FLAG_ID)
      ? AGENT_SWARM_PARAMETERS
      : AGENT_SWARM_PARAMETERS_NO_MODEL;
  }

  private readonly callerAgentId: string;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionCollaborationService private readonly collaboration?: ISessionCollaborationService,
    @IAgentTaskService private readonly agentTasks?: IAgentTaskService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    const callerModelAlias = this.profile.data().modelAlias;
    const modelLines = this.teamModeEnabled()
      ? buildTeamSubagentModelDescriptions(
          listRoutableSubagentModels(this.config, this.modelCatalog, callerModelAlias),
        )
      : buildSubagentModelDescriptions(
          this.config,
          this.flags,
          callerModelAlias,
          this.modelCatalog,
        );
    const profileLines = this.availableProfileLines();
    return [AGENT_SWARM_DESCRIPTION, profileLines, modelLines].filter(
      (part): part is string => part !== undefined,
    ).join('\n\n');
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const teamMode = this.teamModeEnabled();
      this.swarmMode.enter('tool');
      const result = await this.runSwarm(args, context.signal, context.toolCallId);
      return {
        output: result,
        stopTurn: teamMode,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    const teamMode = this.teamModeEnabled();
    const timeoutMs = resolveSubagentTimeoutMs(this.config);
    const specs = await createAgentSwarmSpecs(
      args,
      (agentId) => this.swarmService.getSwarmItem({ callerAgentId: this.callerAgentId, agentId }),
      teamMode,
    );
    if (teamMode && Object.keys(args.resume_agent_ids ?? {}).length > 0) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Team Mode uses item-level resume_agent_id so every logical task keeps its task_key and dependencies.',
      );
    }
    if (teamMode && specs.some((spec) => spec.taskKey === undefined)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Team Mode requires every AgentSwarm item to provide task_key.',
      );
    }
    if (teamMode && specs.some((spec) => spec.kind === 'spawn' && spec.displayName === undefined)) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Team Mode requires every new AgentSwarm item to provide display_name and subagent_type.',
      );
    }
    const bindings = new Map<
      number,
      { readonly model: string; readonly thinking?: string; readonly displayModel: string }
    >();
    const spawnSpecs = specs.filter((spec): spec is AgentSwarmSpawnSpec => spec.kind === 'spawn');
    if (spawnSpecs.length > 0) {
      await this.catalog.ready;
      const own = this.profile.data();
      const teamModels = teamMode
        ? listRoutableSubagentModels(this.config, this.modelCatalog, own.modelAlias)
        : [];
      if (teamMode && teamModels.length === 0) {
        throw new Error2(
          ErrorCodes.MODEL_NOT_CONFIGURED,
          'Team Mode cannot assign subagents because no configured model alias is routable.',
        );
      }
      if (teamMode && teamModels.length > 1) {
        const missingModelItems = (args.items ?? []).flatMap((item, index) =>
          typeof item !== 'string' && normalizeOptionalString(item.model) === undefined
            ? [index + 1]
            : [],
        );
        if (missingModelItems.length > 0) {
          throw new Error2(
            ErrorCodes.VALIDATION_FAILED,
            'Team Mode requires every new AgentSwarm item to provide an exact model alias when multiple models are available.',
            {
              details: {
                missingModelItems,
                availableModels: teamModels.map((model) => model.alias),
              },
            },
          );
        }
      }
      const allowlist = teamMode && this.callerAgentId === 'main'
        ? undefined
        : subagentAllowlistFor(this.catalog, own);
      for (const spec of spawnSpecs) {
        if (allowlist !== undefined && !allowlist.includes(spec.profileName)) {
          throw new Error2(
            ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
            subagentTypeNotAllowedMessage(spec.profileName, allowlist),
            { details: { profileName: spec.profileName, allowlist } },
          );
        }
        const targetProfile = this.catalog.get(spec.profileName);
        if (targetProfile === undefined) {
          throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${spec.profileName}"`, {
            details: { profileName: spec.profileName },
          });
        }
        if (teamMode) {
          const requestedModel = normalizeOptionalString(spec.model) ?? teamModels[0]?.alias;
          const route = teamModels.find((model) => model.alias === requestedModel);
          if (route === undefined) {
            throw new Error2(
              ErrorCodes.VALIDATION_FAILED,
              `Unknown Team subagent model alias: "${requestedModel ?? ''}".`,
              {
                details: {
                  requestedModel,
                  availableModels: teamModels.map((model) => model.alias),
                },
              },
            );
          }
          bindings.set(spec.index, {
            model: route.alias,
            thinking: undefined,
            displayModel: route.alias,
          });
        } else if (own.modelAlias !== undefined) {
          const resolved = resolveSubagentBinding(
            this.config,
            this.flags,
            { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
            spec.model ?? targetProfile.modelPreference,
          );
          bindings.set(spec.index, resolved);
        }
      }
    }
    let teamReceipt: Awaited<ReturnType<ISessionCollaborationService['prepareSwarmBatch']>> | undefined;
    const resumeMetadata = new Map<
      string,
      { readonly displayName?: string; readonly profileName: string; readonly model?: string }
    >();
    if (teamMode) {
      const collaboration = this.requireCollaboration();
      const snapshot = await collaboration.snapshot();
      for (const spec of specs) {
        if (spec.kind !== 'resume') continue;
        const member = snapshot.members.find((candidate) => candidate.agentId === spec.agentId);
        const latestAssignment = snapshot.assignments.findLast(
          (assignment) => assignment.agentId === spec.agentId,
        );
        resumeMetadata.set(spec.agentId, {
          displayName: member?.displayName ?? latestAssignment?.displayName,
          profileName: latestAssignment?.profileName ?? 'subagent',
          model: latestAssignment?.model,
        });
      }
      teamReceipt = await collaboration.prepareSwarmBatch({
        callerAgentId: this.callerAgentId,
        assignments: specs.map((spec) => {
          const metadata = spec.kind === 'resume' ? resumeMetadata.get(spec.agentId) : undefined;
          const profileName = spec.kind === 'spawn' ? spec.profileName : metadata?.profileName ?? 'subagent';
          return {
            assignmentId: `assignment_${randomUUID()}`,
            taskKey: spec.taskKey,
            dependsOn: spec.dependsOn,
            displayName: spec.kind === 'spawn' ? spec.displayName : metadata?.displayName,
            profileName,
            model: spec.kind === 'spawn'
              ? bindings.get(spec.index)?.displayModel
              : metadata?.model,
            description: childDescription(args.description, spec.index, profileName),
            item: spec.item,
            prompt: spec.prompt,
            workspaceMode: spec.workspaceMode,
            validationMode: spec.validationMode,
            resumeAgentId: spec.kind === 'resume' ? spec.agentId : undefined,
          };
        }),
      });
    }
    const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec, taskIndex) => {
      const resumeProfileName = spec.kind === 'resume'
        ? resumeMetadata.get(spec.agentId)?.profileName ?? 'subagent'
        : undefined;
      const profileName = spec.kind === 'spawn' ? spec.profileName : resumeProfileName!;
      const descriptionProfileName = spec.kind === 'resume' && !teamMode ? 'resume' : profileName;
      const assignment = teamReceipt?.assignments[taskIndex];
      const common = {
        data: spec,
        profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionProfileName),
        swarmIndex: spec.index,
        runInBackground: teamMode,
        swarmItem: spec.item,
        signal,
        timeout: timeoutMs,
        onAgentBound: assignment === undefined
          ? undefined
          : (agentId: string) => this.requireCollaboration().bindAssignment({
              assignmentId: assignment.id,
              agentId,
              parentAgentId: this.callerAgentId,
            }),
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume' as const,
          resumeAgentId: spec.agentId,
        };
      }
      const binding = bindings.get(spec.index);
      return {
        ...common,
        kind: 'spawn' as const,
        binding: binding === undefined
          ? undefined
          : { model: binding.model, thinking: binding.thinking },
      };
    });
    if (teamReceipt !== undefined) {
      const receipt = teamReceipt;
      const callbackTaskIds: string[] = [];
      try {
        if (this.agentTasks === undefined) {
          throw new BugIndicatingError('AgentSwarm Team Mode requires the Agent task service');
        }
        for (const assignment of receipt.assignments) {
          callbackTaskIds.push(
            this.agentTasks.registerTask(
              new TeamAssignmentTask(this.requireCollaboration(), assignment),
              { detached: true },
            ),
          );
        }
        await this.requireCollaboration().scheduleSwarmBatch({
          batchId: receipt.batchId,
          tasks,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const assignment of receipt.assignments) {
          await this.requireCollaboration().settleAssignment({
            assignmentId: assignment.id,
            status: 'failed',
            error: message,
          });
        }
        await this.requireCollaboration().settleBatch({ batchId: receipt.batchId, status: 'failed' });
        throw error;
      }
      return renderSwarmLaunchReceipt(receipt.batchId, receipt.assignments, callbackTaskIds);
    }
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
    });
    return renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data as AgentSwarmSpec, ...result })),
    );
  }

  private requireCollaboration(): ISessionCollaborationService {
    if (this.collaboration === undefined) {
      throw new Error2(
        ErrorCodes.COLLABORATION_NOT_ENABLED,
        'Team collaboration service is unavailable',
      );
    }
    return this.collaboration;
  }

  private teamModeEnabled(): boolean {
    return this.collaboration !== undefined
      && this.flags.enabled(TEAM_COLLABORATION_FLAG_ID)
      && this.collaboration.isActive();
  }

  private availableProfileLines(): string {
    const own = this.profile.data();
    const allowlist = this.collaboration !== undefined
      && this.flags.enabled(TEAM_COLLABORATION_FLAG_ID)
      && this.collaboration.isActive()
      && this.callerAgentId === 'main'
      ? undefined
      : subagentAllowlistFor(this.catalog, own);
    const profiles = this.catalog.list().filter(
      (candidate) => allowlist === undefined || allowlist.includes(candidate.name),
    );
    return [
      'Available profession profiles (compare each Introduction and Best for before choosing subagent_type for a Team item):',
      ...profiles.map(renderAvailableProfile),
      '- In Team Mode, if none fits, the leader can call AgentProfileCreate first and then use the newly created profile name.',
    ].join('\n');
  }
}

function renderAvailableProfile(
  profile: Pick<AgentProfile, 'name' | 'description' | 'whenToUse'>,
): string {
  const introduction = profile.description?.trim() || 'No introduction provided.';
  const bestFor = profile.whenToUse?.trim();
  return [
    `- ${profile.name}`,
    `  Introduction: ${introduction}`,
    bestFor === undefined || bestFor.length === 0 ? undefined : `  Best for: ${bestFor}`,
  ].filter((line): line is string => line !== undefined).join('\n');
}

function renderSwarmLaunchReceipt(
  batchId: string,
  assignments: readonly {
    readonly id: string;
    readonly description: string;
    readonly displayName?: string;
    readonly profileName: string;
    readonly model?: string;
  }[],
  callbackTaskIds: readonly string[],
): string {
  return [
    '<agent_swarm_started>',
    `<batch_id>${batchId}</batch_id>`,
    `<accepted>${String(assignments.length)}</accepted>`,
    ...assignments.map((assignment, index) => {
      const name = assignment.displayName === undefined
        ? ''
        : ` display_name="${escapeXmlAttribute(assignment.displayName)}"`;
      const model = assignment.model === undefined
        ? ''
        : ` model="${escapeXmlAttribute(assignment.model)}"`;
      const callbackTaskId = callbackTaskIds[index];
      const callback = callbackTaskId === undefined
        ? ''
        : ` callback_task_id="${escapeXmlAttribute(callbackTaskId)}"`;
      return `<assignment id="${escapeXmlAttribute(assignment.id)}"${callback}${name} profile="${escapeXmlAttribute(assignment.profileName)}"${model}>${escapeXmlAttribute(assignment.description)}</assignment>`;
    }),
    '<automatic_notification>true</automatic_notification>',
    '<coordination>Finish this turn after launch. Each child task completion automatically wakes the direct delegator with its result. Use TeamStatus and TeamSend for active coordination; do not call TeamWait merely to wait for child completion.</coordination>',
    '</agent_swarm_started>',
  ].join('\n');
}

registerAgentToolService(IAgentSwarmTool, AgentSwarmTool, { name: 'AgentSwarm', domain: 'swarm' });

async function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => Promise<string | undefined>,
  allowSingleItem = false,
): Promise<AgentSwarmSpec[]> {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const defaultProfileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
  const items: NormalizedSwarmItem[] = (args.items ?? []).map((item): NormalizedSwarmItem => typeof item === 'string'
    ? {
        item: item.trim(),
        profileName: defaultProfileName,
        model: args.model,
        dependsOn: [] as readonly string[],
        workspaceMode: defaultProfileName === 'explore' ? 'shared_readonly' as const : 'isolated_write' as const,
        validationMode: defaultProfileName === 'explore' ? 'none' as const : 'required' as const,
      }
    : (() => {
        const profileName = normalizeOptionalString(item.subagent_type) ?? defaultProfileName;
        const workspaceMode = item.workspace_access === 'read' || (item.workspace_access === undefined && profileName === 'explore')
          ? 'shared_readonly' as const
          : 'isolated_write' as const;
        return {
        item: item.item.trim(),
        taskKey: normalizeOptionalString(item.task_key),
        dependsOn: item.depends_on ?? [],
        displayName: normalizeOptionalString(item.display_name),
        profileName,
        model: item.model ?? args.model,
        workspaceMode,
        validationMode: workspaceMode === 'isolated_write' ? 'required' as const : 'none' as const,
        resumeAgentId: normalizeOptionalString(item.resume_agent_id),
      };
      })());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount, allowSingleItem)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
      { details: { total: totalCount, max: MAX_AGENT_SWARM_SUBAGENTS } },
    );
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'prompt_template is required when items are provided.',
    );
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
      { details: { placeholder: PROMPT_TEMPLATE_PLACEHOLDER } },
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: await getResumeItem(entry.agentId),
      prompt: entry.prompt,
      dependsOn: [],
      workspaceMode: 'isolated_write',
      validationMode: 'required',
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((entry, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(entry.item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
          { details: { previousIndex, index: index + 1 } },
        );
      }
      seenPrompts.set(prompt, index + 1);
      if (entry.resumeAgentId !== undefined) {
        specs.push({
          kind: 'resume',
          index: specs.length + 1,
          agentId: entry.resumeAgentId,
          item: entry.item,
          prompt,
          taskKey: entry.taskKey,
          dependsOn: entry.dependsOn,
          workspaceMode: entry.workspaceMode,
          validationMode: entry.validationMode,
        });
      } else {
        specs.push({
          kind: 'spawn',
          index: specs.length + 1,
          item: entry.item,
          prompt,
          taskKey: entry.taskKey,
          dependsOn: entry.dependsOn,
          displayName: entry.displayName,
          profileName: entry.profileName,
          model: entry.model,
          workspaceMode: entry.workspaceMode,
          validationMode: entry.validationMode,
        });
      }
    });
  }
  return specs;
}

function hasMinimumAgentSwarmInputs(
  itemCount: number,
  resumeCount: number,
  allowSingleItem: boolean,
): boolean {
  return resumeCount > 0 || itemCount >= (allowSingleItem ? 1 : 2);
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
