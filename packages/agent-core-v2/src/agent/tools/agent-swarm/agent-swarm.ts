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
  task_key: z.string().trim().min(1).max(80).optional().describe(
    'Stable unique task key. Required for every item in Team Mode and referenced by depends_on.',
  ),
  depends_on: z.array(z.string().trim().min(1).max(80)).max(32).optional().describe(
    'Task keys that must complete and integrate before this task may start.',
  ),
  display_name: teamDisplayNameSchema.optional().describe(
    'Short unique persistent name for this Team member. Required for new agents in Team Mode. Use 1-24 letters or numbers, with underscores and hyphens allowed after the first character. Do not use main or agent-N.',
  ),
  subagent_type: z.string().trim().min(1).optional().describe(
    'Agent profession selected for this task. Compare the listed Introduction and Best for guidance before choosing.',
  ),
  model: z.string().trim().min(1).optional().describe(
    'Exact configured model alias for this task. Required per new item in Team Mode when more than one model is available; overrides the batch-level model.',
  ),
  workspace_access: z.enum(['read', 'write']).optional().describe(
    'Maximum workspace access for this task. Team Mode defaults known read-only profiles to read and all other profiles to write.',
  ),
  validation: z.enum(['none', 'required']).optional().describe(
    'Independent validation policy. Write tasks always require validation in Team Mode.',
  ),
  resume_agent_id: z.string().trim().min(1).optional().describe(
    'Reusable Team member agent id for this logical task. Team Mode uses this item-level field instead of resume_agent_ids.',
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
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent. Team Mode requires object items with display_name and subagent_type so every assignment has a persistent name and a profession selected from its Introduction and Best for guidance.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of reusable existing subagent agent_id to its continuation prompt. Prefer this when new work is clearly related to that agent\'s previous assignment; resumed subagents keep their context and launch before new item-based subagents.',
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Model for item-spawned subagents. Outside Team Mode, pass "secondary" for the configured secondary model, "primary", or an exact configured model alias. In Team Mode, each structured item must carry its own exact alias when multiple models are available; this batch-level value is not a substitute. Resumed subagents always keep their own model.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;


export interface IAgentSwarmTool extends AgentTool<AgentSwarmToolInput> { readonly _serviceBrand: undefined }
export const IAgentSwarmTool = createDecorator<IAgentSwarmTool>('agentSwarmTool');
