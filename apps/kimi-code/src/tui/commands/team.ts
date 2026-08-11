import { randomUUID } from 'node:crypto';

import type {
  Session,
  TeamArtifactContent,
  TeamPolicyInput,
  TeamSnapshot,
  TeamSnapshotV2,
  TeamTask,
} from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export type TeamCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'start'; readonly policy: TeamPolicyInput }
  | { readonly kind: 'policy'; readonly policy: TeamPolicyInput }
  | { readonly kind: 'pause'; readonly reason?: string }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel'; readonly task: string }
  | { readonly kind: 'retry'; readonly task: string }
  | {
      readonly kind: 'reassign';
      readonly task: string;
      readonly profileName?: string;
      readonly model?: string;
    }
  | { readonly kind: 'message'; readonly recipient: string; readonly body: string }
  | { readonly kind: 'artifact'; readonly artifactId: string }
  | { readonly kind: 'preview' }
  | { readonly kind: 'apply' }
  | { readonly kind: 'discard' };

export function parseTeamCommand(input: string): TeamCommand {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'status') return { kind: 'status' };
  const [rawCommand = '', ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  switch (command) {
    case 'start':
      return { kind: 'start', policy: parseTeamPolicy(rest) };
    case 'policy':
      return { kind: 'policy', policy: parseTeamPolicy(rest, true) };
    case 'pause': {
      const reason = rest.join(' ').trim();
      return { kind: 'pause', reason: reason.length === 0 ? undefined : reason };
    }
    case 'resume':
      requireNoExtraArgs(command, rest);
      return { kind: 'resume' };
    case 'cancel':
    case 'retry':
      return { kind: command, task: requireSingleArg(command, rest) };
    case 'reassign': {
      const task = rest.shift();
      if (task === undefined) {
        throw new Error('Usage: /team reassign <task-id|task-key> [profile=<name>] [model=<id>]');
      }
      let profileName: string | undefined;
      let model: string | undefined;
      for (const option of rest) {
        const [key, ...valueParts] = option.split('=');
        const value = valueParts.join('=').trim();
        if (value.length === 0) throw new Error(`Team reassign option is empty: ${option}`);
        if (key === 'profile') profileName = value;
        else if (key === 'model') model = value;
        else throw new Error(`Unknown Team reassign option: ${key ?? option}`);
      }
      if (profileName === undefined && model === undefined) {
        throw new Error('Team reassign needs profile=<name> or model=<id>.');
      }
      return { kind: 'reassign', task, profileName, model };
    }
    case 'message': {
      const recipient = rest.shift();
      const body = rest.join(' ').trim();
      if (recipient === undefined || body.length === 0) {
        throw new Error('Usage: /team message <agent-id|display-name|all> <message>');
      }
      return { kind: 'message', recipient, body };
    }
    case 'artifact':
      return { kind: 'artifact', artifactId: requireSingleArg(command, rest) };
    case 'preview':
    case 'apply':
    case 'discard':
      requireNoExtraArgs(command, rest);
      return { kind: command };
    default:
      throw new Error(
        `Unknown Team command: ${rawCommand}. Use status, start, policy, pause, resume, ` +
          'cancel, retry, reassign, message, artifact, preview, apply, or discard.',
      );
  }
}

export async function handleTeamCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.requireSession();
  try {
    const command = parseTeamCommand(args);
    switch (command.kind) {
      case 'status':
        renderTeamSnapshot(host, await session.getTeamSnapshot());
        return;
      case 'start':
        renderTeamSnapshot(host, await session.ensureTeam(command.policy));
        return;
      case 'policy': {
        const snapshot = requireTeamV2(await session.getTeamSnapshot());
        renderTeamSnapshot(host, await session.updateTeamPolicy({
          policy: command.policy,
          expectedSeq: snapshot.latestSeq,
        }));
        return;
      }
      case 'pause': {
        const snapshot = requireTeamV2(await session.getTeamSnapshot());
        renderTeamSnapshot(host, await session.pauseTeam({
          expectedSeq: snapshot.latestSeq,
          reason: command.reason,
        }));
        return;
      }
      case 'resume': {
        const snapshot = requireTeamV2(await session.getTeamSnapshot());
        renderTeamSnapshot(host, await session.resumeTeam({ expectedSeq: snapshot.latestSeq }));
        return;
      }
      case 'cancel':
      case 'retry': {
        const snapshot = requireTeamV2(await session.getTeamSnapshot());
        const task = resolveTask(snapshot, command.task);
        const next = command.kind === 'cancel'
          ? await session.cancelTeamTask({ taskId: task.id, expectedSeq: snapshot.latestSeq })
          : await session.retryTeamTask({ taskId: task.id, expectedSeq: snapshot.latestSeq });
        renderTeamSnapshot(host, next);
        return;
      }
      case 'reassign': {
        const snapshot = requireTeamV2(await session.getTeamSnapshot());
        const task = resolveTask(snapshot, command.task);
        renderTeamSnapshot(host, await session.reassignTeamTask({
          taskId: task.id,
          expectedSeq: snapshot.latestSeq,
          profileName: command.profileName,
          model: command.model,
        }));
        return;
      }
      case 'message':
        await sendTeamMessage(host, session, command);
        return;
      case 'artifact':
        renderArtifact(host, await session.getTeamArtifact(command.artifactId), ' Team artifact ');
        return;
      case 'preview': {
        const artifact = await session.previewTeamIntegration();
        if (artifact === undefined) throw new Error('No Team integration diff is ready.');
        renderArtifact(host, artifact, ' Team integration preview ');
        host.showStatus('Review the diff, then run /team apply to confirm it.');
        return;
      }
      case 'apply':
        await applyTeamIntegration(host, session);
        return;
      case 'discard': {
        const snapshot = requireTeamV2(await session.getTeamSnapshot());
        renderTeamSnapshot(host, await session.discardTeamIntegration({
          expectedSeq: snapshot.latestSeq,
        }));
        return;
      }
    }
  } catch (error) {
    host.showError(`Team command failed: ${formatErrorMessage(error)}`);
  }
}

export function buildTeamSnapshotLines(snapshot: TeamSnapshot): string[] {
  if (snapshot.protocolVersion === 1) {
    return [
      'Protocol  v1 legacy read-only',
      `State     ${snapshot.state}`,
      `Members   ${String(snapshot.members.length)}`,
      `Tasks     ${String(snapshot.assignments.length)}`,
      snapshot.degradedReason === undefined ? '' : `Reason    ${snapshot.degradedReason}`,
    ].filter((line) => line.length > 0);
  }

  const counts = new Map<string, number>();
  for (const task of snapshot.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const lines = [
    `Protocol   v2 · ${snapshot.state}`,
    `Scheduler  ${snapshot.scheduler.status} · active ${String(snapshot.scheduler.activeCount)} · queued ${String(snapshot.scheduler.queuedCount)}`,
    `Policy     concurrency ${String(snapshot.policy.maxConcurrency)} · members ${String(snapshot.policy.maxMembers)} · depth ${String(snapshot.policy.maxDelegationDepth)} · retries ${String(snapshot.policy.executionRetries)}/${String(snapshot.policy.validationRetries)}`,
    `Budget     ${snapshot.budget.totalTokens.toLocaleString()} tokens · ${formatDuration(snapshot.budget.elapsedMs)}`,
    `Integration ${snapshot.integration.status}${snapshot.integration.error === undefined ? '' : ` · ${snapshot.integration.error}`}`,
    `Tasks      ${[...counts.entries()].map(([status, count]) => `${status} ${String(count)}`).join(' · ') || 'none'}`,
  ];
  for (const task of snapshot.tasks.slice(0, 30)) {
    const agent = task.displayName ?? task.agentId ?? 'unassigned';
    const deps = task.dependsOn.length === 0 ? '' : ` · waits ${task.dependsOn.join(',')}`;
    lines.push(`  [${task.status}] ${task.taskKey} · ${agent} · ${task.profileName}${deps}`);
  }
  if (snapshot.tasks.length > 30) lines.push(`  … ${String(snapshot.tasks.length - 30)} more tasks`);
  if (snapshot.scheduler.pauseReason !== undefined) lines.push(`Pause reason ${snapshot.scheduler.pauseReason}`);
  if (snapshot.budget.exhaustedReason !== undefined) {
    lines.push(`Budget stopped by ${snapshot.budget.exhaustedReason}`);
  }
  return lines;
}

function renderTeamSnapshot(host: SlashCommandHost, snapshot: TeamSnapshot): void {
  const panel = new UsagePanelComponent(() => buildTeamSnapshotLines(snapshot), 'primary', ' Team ');
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

function renderArtifact(host: SlashCommandHost, artifact: TeamArtifactContent, title: string): void {
  const text = Buffer.from(artifact.dataBase64, 'base64').toString('utf8');
  const sourceLines = text.split(/\r?\n/);
  const body = sourceLines.slice(0, 400);
  const lines = [
    `${artifact.artifact.kind} · ${artifact.artifact.mediaType} · ${artifact.artifact.byteLength.toLocaleString()} bytes`,
    '',
    ...body,
  ];
  if (sourceLines.length > body.length) {
    lines.push('', `… ${String(sourceLines.length - body.length)} more lines in artifact ${artifact.artifact.id}`);
  }
  const panel = new UsagePanelComponent(() => lines, 'primary', title);
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function sendTeamMessage(
  host: SlashCommandHost,
  session: Session,
  command: Extract<TeamCommand, { kind: 'message' }>,
): Promise<void> {
  const snapshot = await session.getTeamSnapshot();
  if (snapshot.team === undefined) throw new Error('Team is not active. Run /team start first.');
  let recipients: readonly string[] | undefined;
  if (command.recipient.toLowerCase() !== 'all') {
    const member = snapshot.members.find(
      (candidate) => candidate.agentId === command.recipient || candidate.displayName === command.recipient,
    );
    if (member === undefined) throw new Error(`Unknown Team member: ${command.recipient}`);
    recipients = [member.agentId];
  }
  const message = await session.sendTeamMessage({
    body: command.body,
    clientMessageId: randomUUID(),
    recipientAgentIds: recipients,
  });
  host.showStatus(
    `Team message #${String(message.channelSeq)} sent ${recipients === undefined ? 'to everyone' : `to ${recipients[0] ?? command.recipient}`}.`,
  );
}

async function applyTeamIntegration(host: SlashCommandHost, session: Session): Promise<void> {
  const snapshot = requireTeamV2(await session.getTeamSnapshot());
  const artifact = await session.previewTeamIntegration();
  if (artifact === undefined) throw new Error('No Team integration diff is ready.');
  renderArtifact(host, artifact, ' Team integration preview ');
  if (!(await confirmTeamApply(host, artifact))) {
    host.showStatus('Team integration was not applied.');
    return;
  }
  renderTeamSnapshot(host, await session.applyTeamIntegration({ expectedSeq: snapshot.latestSeq }));
  host.showStatus('Team integration applied to the workspace.');
}

function confirmTeamApply(host: SlashCommandHost, artifact: TeamArtifactContent): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (confirmed: boolean): void => {
      host.restoreEditor();
      resolve(confirmed);
    };
    host.mountEditorReplacement(new ChoicePickerComponent({
      title: 'Apply Team integration to the workspace?',
      notice: `${artifact.artifact.byteLength.toLocaleString()} bytes from ${artifact.artifact.id}. This changes the main working tree.`,
      noticeTone: 'warning',
      options: [
        { value: 'cancel', label: 'Cancel', description: 'Leave the main working tree unchanged.' },
        {
          value: 'apply',
          label: 'Apply integration',
          description: 'Apply the reviewed aggregate diff once.',
          tone: 'danger',
        },
      ],
      onSelect: (value) => { finish(value === 'apply'); },
      onCancel: () => { finish(false); },
    }));
  });
}

function requireTeamV2(snapshot: TeamSnapshot): TeamSnapshotV2 {
  if (snapshot.protocolVersion !== 2) {
    throw new Error('This session has a legacy v1 Team and is read-only.');
  }
  if (snapshot.team === undefined) throw new Error('Team is not active. Run /team start first.');
  if (snapshot.state === 'degraded') {
    throw new Error(snapshot.degradedReason ?? 'Team is in read-only degraded mode.');
  }
  return snapshot;
}

function resolveTask(snapshot: TeamSnapshotV2, value: string): TeamTask {
  const matches = snapshot.tasks.filter((task) => task.id === value || task.taskKey === value);
  if (matches.length === 0) throw new Error(`Unknown Team task: ${value}`);
  if (matches.length > 1) throw new Error(`Ambiguous Team task key: ${value}; use the task id.`);
  return matches[0]!;
}

function parseTeamPolicy(parts: readonly string[], requireValue = false): TeamPolicyInput {
  if (requireValue && parts.length === 0) {
    throw new Error('Usage: /team policy concurrency=<n> [members=<n>] [tokens=<n>] [duration=<time>]');
  }
  const policy: TeamPolicyInput = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0 || separator === part.length - 1) throw new Error(`Invalid Team policy option: ${part}`);
    const key = part.slice(0, separator);
    const rawValue = part.slice(separator + 1);
    switch (key) {
      case 'concurrency':
      case 'maxConcurrency': policy.maxConcurrency = parseInteger(rawValue, key); break;
      case 'members':
      case 'maxMembers': policy.maxMembers = parseInteger(rawValue, key); break;
      case 'depth':
      case 'maxDelegationDepth': policy.maxDelegationDepth = parseInteger(rawValue, key); break;
      case 'executionRetries': policy.executionRetries = parseNonnegativeInteger(rawValue, key); break;
      case 'validationRetries': policy.validationRetries = parseNonnegativeInteger(rawValue, key); break;
      case 'tokens':
      case 'maxTokens': policy.maxTokens = parseInteger(rawValue, key); break;
      case 'duration':
      case 'maxDurationMs': policy.maxDurationMs = parseDuration(rawValue); break;
      default: throw new Error(`Unknown Team policy option: ${key}`);
    }
  }
  return policy;
}

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function parseNonnegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a nonnegative integer.`);
  return parsed;
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/i.exec(value);
  if (match === null) throw new Error('duration must look like 30000, 30s, 10m, or 1h.');
  const amount = parseInteger(match[1]!, 'duration');
  const factor = match[2]?.toLowerCase() === 'h'
    ? 3_600_000
    : match[2]?.toLowerCase() === 'm'
      ? 60_000
      : match[2]?.toLowerCase() === 's' ? 1_000 : 1;
  return amount * factor;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(milliseconds)}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${String(minutes)}m ${String(seconds % 60)}s` : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

function requireSingleArg(command: string, values: readonly string[]): string {
  if (values.length !== 1) throw new Error(`Usage: /team ${command} <id>`);
  return values[0]!;
}

function requireNoExtraArgs(command: string, values: readonly string[]): void {
  if (values.length > 0) throw new Error(`/team ${command} does not accept extra arguments.`);
}
