/**
 * `collaboration` domain — Team leader tool for creating reusable agent profiles.
 */

import { z } from 'zod';

import { createDecorator, ref, type LiveRef } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { Error2, ErrorCodes } from '#/errors';
import { ISessionCollaborationService } from '#/features/collaboration/collaboration';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';
import { IAgentProfileWriter } from '#/workspace/workspaceAgentProfileLoader/agentProfileWriter';

const profileNameSchema = z.string().trim().min(1).max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Profile names must use kebab-case');
const profileStringListSchema = z.array(z.string().trim().min(1)).max(128);

export const AgentProfileCreateInputSchema = z.object({
  name: profileNameSchema.describe('Reusable kebab-case profile name.'),
  description: z.string().trim().min(1).max(240).describe(
    'Short introduction describing the strengths of this profession. The Team leader reads it before assigning work.',
  ),
  when_to_use: z.string().trim().min(1).max(500).describe(
    'Tasks and situations this profession is best suited for. The Team leader uses it together with the introduction.',
  ),
  prompt: z.string().trim().min(1).max(64 * 1024),
  scope: z.enum(['workspace', 'user']).optional().default('workspace'),
  tools: profileStringListSchema.optional(),
  disallowed_tools: profileStringListSchema.optional(),
  subagents: profileStringListSchema.optional(),
  model_preference: z.enum(['primary', 'secondary']).optional(),
}).strict();
export type AgentProfileCreateInput = z.infer<typeof AgentProfileCreateInputSchema>;

export interface IAgentProfileCreateTool extends AgentTool<AgentProfileCreateInput> {
  readonly _serviceBrand: undefined;
}
export const IAgentProfileCreateTool = createDecorator<IAgentProfileCreateTool>(
  'agentProfileCreateTool',
);

export class AgentProfileCreateTool implements IAgentProfileCreateTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentProfileCreate' as const;
  readonly description = [
    'Create and immediately load a reusable Agent profession when no existing profile fits a Team task.',
    'Default to workspace scope. Use user scope only when the profession should be available in every workspace.',
    'Never recreate or overwrite an existing profile with different content; select an existing profile or choose a new name instead.',
  ].join('\n');
  readonly parameters = toInputJsonSchema(AgentProfileCreateInputSchema);
  private readonly agentId: string;

  constructor(
    @IAgentScopeContext scope: IAgentScopeContext,
    @ref(IAgentProfileWriter) private readonly writer: LiveRef<IAgentProfileWriter>,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionCollaborationService private readonly collaboration: ISessionCollaborationService,
  ) {
    this.agentId = scope.agentId;
  }

  resolveExecution(input: AgentProfileCreateInput): ToolExecution {
    return {
      accesses: ToolAccesses.all(),
      description: `Creating Agent profile ${input.name}`,
      approvalRule: this.name,
      execute: async () => {
        const team = (await this.collaboration.snapshot()).team;
        if (this.agentId !== 'main' || team?.leaderAgentId !== this.agentId) {
          return {
            isError: true,
            output: new Error2(
              ErrorCodes.PROFILE_CREATE_FORBIDDEN,
              'Only the Team leader can create reusable Agent profiles',
            ).message,
          };
        }
        const writer = this.writer.current;
        if (writer === undefined) {
          return {
            isError: true,
            output: new Error2(
              ErrorCodes.PROFILE_CREATE_FAILED,
              'Agent profile storage is unavailable in this workspace',
            ).message,
          };
        }
        await this.catalog.ready;
        const expectedSource = input.scope === 'user' ? 'user' : 'workspace';
        const existing = this.catalog.inspect(input.name);
        if (existing !== undefined && existing.sourceId !== expectedSource) {
          return {
            isError: true,
            output: `Agent profile "${input.name}" already exists in ${existing.sourceId}`,
          };
        }
        try {
          const result = await writer.create({
            name: input.name,
            description: input.description,
            whenToUse: input.when_to_use,
            prompt: input.prompt,
            scope: input.scope,
            tools: input.tools,
            disallowedTools: input.disallowed_tools,
            subagents: input.subagents,
            modelPreference: input.model_preference,
          });
          const loaded = this.catalog.inspect(input.name);
          if (loaded?.sourceId !== expectedSource) {
            throw new Error2(
              ErrorCodes.PROFILE_CREATE_FAILED,
              `Agent profile "${input.name}" was written but did not become available`,
              { details: { name: input.name, scope: input.scope, path: result.path } },
            );
          }
          return {
            output: JSON.stringify({
              ready: true,
              name: result.name,
              scope: result.scope,
              path: result.path,
              created: result.created,
            }, null, 2),
          };
        } catch (error) {
          return { isError: true, output: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }
}
