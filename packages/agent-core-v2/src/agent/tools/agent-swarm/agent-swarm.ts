/**
 * `tools` domain — `IAgentSwarmTool` contract (the `AgentSwarm` tool).
 *
 * Public contract of the `AgentSwarm` collaboration tool: the input zod
 * schema the model-facing parameters are derived from, the tool-owned
 * constants the schema is built around (prompt template placeholder, maximum
 * subagent count), and the `IAgentSwarmTool` DI decorator that the
 * implementation registers against via `registerAgentToolService`. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { teamDisplayNameSchema } from '#/features/collaboration/types';
import { type AgentTool } from '#/tool/toolContract';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;

export const AgentSwarmStructuredItemSchema = z.object({
  item: z.string().trim().min(1).describe('Task value used to fill the prompt template.'),
  display_name: teamDisplayNameSchema.describe(
    'Short unique persistent name for this Team member. Required for new agents in Team Mode.',
  ),
  subagent_type: z.string().trim().min(1).describe(
    'Agent profile selected for this specific task.',
  ),
  model: z.enum(['secondary', 'primary']).optional().describe(
    'Optional model choice for this specific task; overrides the batch-level model.',
  ),
}).strict();

export const AgentSwarmItemSchema = z.union([
  z.string().trim().min(1),
  AgentSwarmStructuredItemSchema,
]);

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(AgentSwarmItemSchema)
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent. Team Mode requires object items with display_name and subagent_type so every assignment has a persistent name and an explicitly selected profession.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of reusable existing subagent agent_id to its continuation prompt. Prefer this when new work is clearly related to that agent\'s previous assignment; resumed subagents keep their context and launch before new item-based subagents.',
      ),
    model: z
      .enum(['secondary', 'primary'])
      .optional()
      .describe(
        'Which model to run the item-spawned subagents on: "secondary" = the configured secondary model; "primary" = the main model you are running on (for hard, quality-sensitive tasks). This explicit choice overrides the selected agent type\'s model_preference; without either, secondary is the default when configured. Only effective when a secondary model is configured; otherwise subagents inherit your model. Resumed subagents always keep their own model.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;


export interface IAgentSwarmTool extends AgentTool<AgentSwarmToolInput> { readonly _serviceBrand: undefined }
export const IAgentSwarmTool = createDecorator<IAgentSwarmTool>('agentSwarmTool');
