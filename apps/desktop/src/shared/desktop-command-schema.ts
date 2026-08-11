import { z } from 'zod';

import {
  DESKTOP_DOMAINS,
  type DesktopCommand,
} from './desktop-api';

const empty = z.object({}).strict().optional();
const nonEmptyString = z.string().trim().min(1);
const optionalSessionId = z.object({ sessionId: nonEmptyString.optional() }).strict();
const unknownRecord = z.record(z.string(), z.unknown());
const todoItem = z.object({
  title: z.string().min(1).max(10_000).refine((value) => value.trim().length > 0),
  status: z.enum(['pending', 'in_progress', 'done']),
}).strict();
const todoItems = z.array(todoItem).max(1_000);
const teamImageInput = z.object({
  type: z.literal('image_url'),
  url: nonEmptyString,
  name: z.string().trim().min(1).max(255),
}).strict();
const teamPolicyInput = z.object({
  maxConcurrency: z.number().int().min(1).max(16).optional(),
  maxMembers: z.number().int().min(2).max(64).optional(),
  maxDelegationDepth: z.number().int().min(1).max(8).optional(),
  executionRetries: z.number().int().min(0).max(5).optional(),
  validationRetries: z.number().int().min(0).max(5).optional(),
  maxTokens: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
}).strict();
const teamRecipients = z.array(nonEmptyString).min(1).max(16).optional();
const teamQuestionAnswers = z.record(z.string().min(1), z.union([z.string(), z.literal(true)]));
const expectedTeamSeq = z.number().int().nonnegative();
const profileName = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const profileStringList = z.array(z.string().trim().min(1).max(256)).max(128);
const profileDraft = z.object({
  name: profileName,
  description: z.string().trim().min(1).max(240),
  whenToUse: z.string().trim().min(1).max(500).optional(),
  prompt: z.string().trim().min(1).max(64 * 1024),
  scope: z.enum(['workspace', 'user']),
  override: z.boolean().optional(),
  tools: profileStringList.optional(),
  disallowedTools: profileStringList.optional(),
  subagents: profileStringList.optional(),
  modelPreference: z.enum(['auto', 'primary', 'secondary']).optional(),
}).strict();
const profileRevision = z.string().regex(/^[a-f0-9]{64}$/);

export const desktopCommandSchemas = {
  'workspace.choose': empty,
  'workspace.open': z.object({ path: nonEmptyString }).strict(),
  'workspace.refresh': empty,
  'workspace.listDirectory': z.object({ path: z.string().optional() }).strict().optional(),
  'workspace.readFile': z.object({ path: nonEmptyString }).strict(),
  'workspace.writeFile': z.object({
    path: nonEmptyString,
    content: z.string(),
    expectedVersion: nonEmptyString,
    force: z.boolean().default(false),
    bom: z.boolean().default(false),
  }).strict(),
  'workspace.readDiff': z.object({ path: nonEmptyString, area: z.enum(['staged', 'working', 'conflict']) }).strict(),
  'workspace.diff': z.object({ path: z.string().optional() }).strict().optional(),
  'workspace.trust': empty,

  'auth.status': z.object({ providerName: nonEmptyString.optional() }).strict().optional(),
  'auth.login': z
    .object({ providerName: nonEmptyString.optional(), baseUrl: nonEmptyString.optional(), oauthHost: nonEmptyString.optional() })
    .strict()
    .optional(),
  'auth.logout': z.object({ providerName: nonEmptyString.optional() }).strict().optional(),
  'auth.usage': z.object({ providerName: nonEmptyString.optional() }).strict().optional(),
  'auth.feedback': z.object({ content: nonEmptyString, contact: z.string().optional() }).strict(),

  'config.get': empty,
  'config.set': z.object({ patch: unknownRecord }).strict(),
  'config.removeProvider': z.object({ providerId: nonEmptyString }).strict(),
  'config.diagnostics': empty,
  'config.features': empty,

  'profile.list': empty,
  'profile.create': profileDraft,
  'profile.update': profileDraft.extend({ revision: profileRevision }).strict(),
  'profile.delete': z.object({
    name: profileName,
    scope: z.enum(['workspace', 'user']),
    revision: profileRevision,
  }).strict(),

  'session.list': empty,
  'session.create': z
    .object({ model: nonEmptyString.optional(), thinking: nonEmptyString.optional(), permission: z.enum(['manual', 'auto', 'yolo']).optional(), planMode: z.boolean().optional(), additionalDirs: z.array(nonEmptyString).optional(), surface: z.enum(['chat', 'team']).optional() })
    .strict()
    .optional(),
  'session.select': z.object({ sessionId: nonEmptyString }).strict(),
  'session.resume': z.object({ sessionId: nonEmptyString }).strict(),
  'session.reload': z.object({ sessionId: nonEmptyString }).strict(),
  'session.rename': z.object({ sessionId: nonEmptyString, title: nonEmptyString }).strict(),
  'session.fork': z.object({ sessionId: nonEmptyString, title: nonEmptyString.optional(), turnIndex: z.number().int().nonnegative().safe().optional() }).strict(),
  'session.export': z.object({ sessionId: nonEmptyString, outputPath: nonEmptyString.optional() }).strict(),
  'session.close': z.object({ sessionId: nonEmptyString }).strict(),
  'session.delete': z.object({ sessionId: nonEmptyString }).strict(),

  'turn.submit': z
    .object({ sessionId: nonEmptyString.optional(), mode: z.enum(['prompt', 'steer', 'swarm']).default('prompt'), text: z.string(), media: z.array(z.object({ type: z.enum(['image_url', 'video_url']), url: nonEmptyString }).strict()).default([]) })
    .strict(),
  'turn.cancel': optionalSessionId,
  'turn.model': z.object({ sessionId: nonEmptyString.optional(), model: nonEmptyString }).strict(),
  'turn.thinking': z.object({ sessionId: nonEmptyString.optional(), effort: nonEmptyString }).strict(),
  'turn.permission': z.object({ sessionId: nonEmptyString.optional(), mode: z.enum(['manual', 'auto', 'yolo']) }).strict(),
  'turn.planMode': z.object({ sessionId: nonEmptyString.optional(), enabled: z.boolean() }).strict(),
  'turn.swarmMode': z.object({ sessionId: nonEmptyString.optional(), enabled: z.boolean(), trigger: z.enum(['manual', 'task', 'tool']).default('manual') }).strict(),
  'turn.compact': z.object({ sessionId: nonEmptyString.optional(), instruction: z.string().optional() }).strict(),
  'turn.cancelCompact': optionalSessionId,
  'turn.undo': z.object({ sessionId: nonEmptyString.optional(), count: z.number().int().min(1).max(100).default(1) }).strict(),

  'interaction.resolve': z.object({ sessionId: nonEmptyString, interactionId: nonEmptyString, response: z.unknown() }).strict(),

  'context.get': optionalSessionId,
  'context.clear': optionalSessionId,
  'context.import': z.object({ sessionId: nonEmptyString.optional(), content: nonEmptyString, source: nonEmptyString.default('Kimi Code Desktop') }).strict(),
  'context.addDirectory': z.object({ sessionId: nonEmptyString.optional(), path: nonEmptyString, persist: z.boolean().default(true) }).strict(),
  'context.initAgents': optionalSessionId,
  'context.secondaryModel': optionalSessionId,
  'context.clearPlan': optionalSessionId,

  'extension.list': empty,
  'extension.installPlugin': z.object({ source: nonEmptyString }).strict(),
  'extension.togglePlugin': z.object({ id: nonEmptyString, enabled: z.boolean() }).strict(),
  'extension.togglePluginMcp': z.object({ id: nonEmptyString, server: nonEmptyString, enabled: z.boolean() }).strict(),
  'extension.removePlugin': z.object({ id: nonEmptyString }).strict(),
  'extension.reloadPlugins': empty,
  'extension.installCapability': z.object({ id: nonEmptyString }).strict(),
  'extension.activateSkill': z.object({ sessionId: nonEmptyString.optional(), name: nonEmptyString, args: z.string().optional() }).strict(),
  'extension.activatePlugin': z.object({ sessionId: nonEmptyString.optional(), pluginId: nonEmptyString, commandName: nonEmptyString, args: z.string().optional() }).strict(),
  'extension.runCommand': z.object({ sessionId: nonEmptyString.optional(), name: nonEmptyString, args: z.string().optional() }).strict(),

  'mcp.list': empty,
  'mcp.add': z.object({ server: unknownRecord }).strict(),
  'mcp.update': z.object({ server: unknownRecord }).strict(),
  'mcp.remove': z.object({ name: nonEmptyString }).strict(),
  'mcp.authenticate': z.object({ name: nonEmptyString }).strict(),
  'mcp.resetAuth': z.object({ name: nonEmptyString }).strict(),
  'mcp.test': z.object({ name: nonEmptyString }).strict(),
  'mcp.reconnect': z.object({ sessionId: nonEmptyString.optional(), name: nonEmptyString }).strict(),

  'task.list': optionalSessionId,
  'task.output': z.object({ sessionId: nonEmptyString.optional(), taskId: nonEmptyString, tail: z.number().int().min(1).max(1_000_000).optional() }).strict(),
  'task.stop': z.object({ sessionId: nonEmptyString.optional(), taskId: nonEmptyString, reason: z.string().optional() }).strict(),
  'task.detach': z.object({ sessionId: nonEmptyString.optional(), taskId: nonEmptyString }).strict(),
  'task.startBtw': optionalSessionId,
  'task.replaceTodos': z.object({
    sessionId: nonEmptyString.optional(),
    expected: todoItems,
    todos: todoItems,
  }).strict(),

  'team.ensure': z.object({ sessionId: nonEmptyString, policy: teamPolicyInput.optional() }).strict(),
  'team.snapshot': z.object({ sessionId: nonEmptyString }).strict(),
  'team.operations': z.object({
    sessionId: nonEmptyString,
    afterSeq: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1_000).optional(),
  }).strict(),
  'team.history': z.object({
    sessionId: nonEmptyString,
    beforeChannelSeq: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }).strict(),
  'team.send': z.object({
    sessionId: nonEmptyString,
    body: z.string().min(1).max(8_192),
    clientMessageId: nonEmptyString,
    recipientAgentIds: teamRecipients,
  }).strict(),
  'team.submit': z.object({
    sessionId: nonEmptyString,
    body: z.string().min(1).max(8_192),
    clientMessageId: nonEmptyString,
    media: z.array(teamImageInput).max(8).default([]),
    recipientAgentIds: teamRecipients,
  }).strict(),
  'team.answerQuestion': z.object({
    sessionId: nonEmptyString,
    questionId: nonEmptyString,
    answers: z.union([teamQuestionAnswers, z.null()]),
  }).strict(),
  'team.updatePolicy': z.object({
    sessionId: nonEmptyString,
    policy: teamPolicyInput,
    expectedSeq: expectedTeamSeq,
  }).strict(),
  'team.pause': z.object({
    sessionId: nonEmptyString,
    expectedSeq: expectedTeamSeq,
    reason: z.string().optional(),
  }).strict(),
  'team.resume': z.object({ sessionId: nonEmptyString, expectedSeq: expectedTeamSeq }).strict(),
  'team.cancelTask': z.object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
    expectedSeq: expectedTeamSeq,
  }).strict(),
  'team.retryTask': z.object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
    expectedSeq: expectedTeamSeq,
  }).strict(),
  'team.reassignTask': z.object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
    expectedSeq: expectedTeamSeq,
    profileName: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
  }).strict(),
  'team.artifact': z.object({ sessionId: nonEmptyString, artifactId: nonEmptyString }).strict(),
  'team.previewIntegration': z.object({ sessionId: nonEmptyString }).strict(),
  'team.applyIntegration': z.object({
    sessionId: nonEmptyString,
    expectedSeq: expectedTeamSeq,
  }).strict(),
  'team.discardIntegration': z.object({
    sessionId: nonEmptyString,
    expectedSeq: expectedTeamSeq,
  }).strict(),

  'goal.get': optionalSessionId,
  'goal.create': z.object({ sessionId: nonEmptyString.optional(), objective: nonEmptyString, replace: z.boolean().optional() }).strict(),
  'goal.pause': optionalSessionId,
  'goal.resume': optionalSessionId,
  'goal.cancel': optionalSessionId,
  'goal.cron': optionalSessionId,

  'shell.run': z.object({ sessionId: nonEmptyString.optional(), command: nonEmptyString }).strict(),
  'shell.cancel': z.object({ sessionId: nonEmptyString.optional(), commandId: nonEmptyString }).strict(),

  'host.snapshot': empty,
  'host.openExternal': z.object({ url: nonEmptyString }).strict(),
  'host.openPath': z.object({ path: nonEmptyString }).strict(),
  'host.setDirtyFiles': z.object({ paths: z.array(nonEmptyString).max(2_000) }).strict(),
  'host.resolveClose': z.object({ requestId: nonEmptyString, action: z.enum(['proceed', 'cancel']) }).strict(),
} as const satisfies Record<string, z.ZodType>;

export type DesktopCommandName = keyof typeof desktopCommandSchemas;

export function parseDesktopCommand(input: unknown): DesktopCommand & { readonly name: DesktopCommandName } {
  const envelope = z
    .object({ domain: z.enum(DESKTOP_DOMAINS), action: nonEmptyString, payload: z.unknown().optional() })
    .strict()
    .parse(input);
  const name = `${envelope.domain}.${envelope.action}` as DesktopCommandName;
  const schema = desktopCommandSchemas[name];
  if (schema === undefined) throw new Error(`Unknown desktop command: ${name}`);
  return { ...envelope, name, payload: schema.parse(envelope.payload) };
}
