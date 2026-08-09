import type {
  AgentDescriptor,
  AgentPhaseMeta,
  TranscriptFrame,
  TranscriptItem,
  TranscriptStore,
  TranscriptTask,
  TranscriptTurn,
} from '@moonshot-ai/transcript';

import { record, text } from './ui-utils';

export type AgentActivityStatus =
  | 'waiting'
  | 'retrying'
  | 'running'
  | 'failed'
  | 'interrupted'
  | 'completed'
  | 'idle';

export interface AgentActivityCounts {
  readonly waiting: number;
  readonly running: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly completed: number;
  readonly idle: number;
  readonly total: number;
}

export interface AgentActivityNode {
  readonly agent: AgentDescriptor;
  readonly status: AgentActivityStatus;
  readonly action: string;
  readonly phase?: AgentPhaseMeta;
  readonly task?: TranscriptTask;
  readonly pendingInteractions: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly children: readonly AgentActivityNode[];
  readonly counts: AgentActivityCounts;
}

export interface AgentActivityForest {
  readonly roots: readonly AgentActivityNode[];
  readonly unattached: readonly AgentActivityNode[];
  readonly byId: ReadonlyMap<string, AgentActivityNode>;
  readonly linkedTaskIds: ReadonlySet<string>;
  readonly counts: AgentActivityCounts;
}

interface MutableNode extends Omit<AgentActivityNode, 'children' | 'counts'> {
  children: MutableNode[];
  counts: AgentActivityCounts;
}

interface TaskIndexEntry {
  readonly task: TranscriptTask;
  readonly order: number;
}

export function buildAgentActivityForest(store?: TranscriptStore): AgentActivityForest {
  if (store === undefined) return emptyForest();
  const descriptors = store.agents();
  const descriptorById = new Map(descriptors.map((agent) => [agent.agentId, agent]));
  const tasksByAgent = indexTasks(store);
  const nodes = new Map<string, MutableNode>();

  for (const agent of descriptors) {
    const transcript = store.getAgent(agent.agentId);
    const phase = transcript?.getMeta().agent?.phase;
    const task = latestTask(tasksByAgent.get(agent.agentId) ?? [], phase);
    const pending = transcript === undefined
      ? []
      : [...transcript.getInteractions().values()].filter((interaction) => interaction.state === 'pending');
    const latestTurn = latestTranscriptTurn(transcript?.getItems() ?? []);
    const status = activityStatus(phase, task, pending.length, latestTurn);
    nodes.set(agent.agentId, {
      agent,
      status,
      action: activityAction(status, phase, task, pending, latestTurn),
      phase,
      task,
      pendingInteractions: pending.length,
      startedAt: activityStartedAt(phase, task, latestTurn),
      endedAt: activityEndedAt(phase, task, latestTurn),
      children: [],
      counts: emptyCounts(),
    });
  }

  const roots: MutableNode[] = [];
  const unattached: MutableNode[] = [];
  for (const agent of descriptors) {
    const node = nodes.get(agent.agentId);
    if (node === undefined) continue;
    const relation = relationship(agent, descriptorById);
    if (relation.kind === 'unattached') {
      unattached.push(node);
    } else if (relation.parentId === undefined) {
      roots.push(node);
    } else {
      nodes.get(relation.parentId)?.children.push(node);
    }
  }

  const compare = agentNodeCompare(descriptors);
  sortNodes(roots, compare);
  sortNodes(unattached, compare);
  for (const node of [...roots, ...unattached]) calculateCounts(node);
  const linkedTaskIds = collectLinkedTaskIds(store, tasksByAgent);
  const allCounts = [...roots, ...unattached].reduce(
    (counts, node) => addCounts(counts, node.counts),
    emptyCounts(),
  );
  return {
    roots,
    unattached,
    byId: nodes,
    linkedTaskIds,
    counts: allCounts,
  };
}

export function agentActivityIsActive(status: AgentActivityStatus): boolean {
  return status === 'waiting' || status === 'retrying' || status === 'running';
}

export function agentActivityIsTerminal(status: AgentActivityStatus): boolean {
  return status === 'failed' || status === 'interrupted' || status === 'completed';
}

export function agentActivityLabel(status: AgentActivityStatus): string {
  switch (status) {
    case 'waiting': return '等待交互';
    case 'retrying': return '正在重试';
    case 'running': return '运行中';
    case 'failed': return '失败';
    case 'interrupted': return '已中断';
    case 'completed': return '已完成（保留）';
    case 'idle': return '空闲';
  }
}

function indexTasks(store: TranscriptStore): Map<string, TaskIndexEntry[]> {
  const output = new Map<string, TaskIndexEntry[]>();
  let order = 0;
  for (const descriptor of store.agents()) {
    for (const task of store.getAgent(descriptor.agentId)?.getTasks().values() ?? []) {
      order += 1;
      if (task.agentId === undefined) continue;
      const entries = output.get(task.agentId) ?? [];
      entries.push({ task, order });
      output.set(task.agentId, entries);
    }
  }
  return output;
}

function latestTask(entries: readonly TaskIndexEntry[], phase?: AgentPhaseMeta): TranscriptTask | undefined {
  if (entries.length === 0) return undefined;
  const active = entries.filter((entry) => entry.task.state === 'running');
  const source = active.length > 0 && phase !== undefined && phase.kind !== 'idle' && phase.kind !== 'ended'
    ? active
    : entries;
  return source.toSorted((left, right) => taskSortValue(right) - taskSortValue(left))[0]?.task;
}

function taskSortValue(entry: TaskIndexEntry): number {
  return timestamp(entry.task.endedAt) ?? timestamp(entry.task.startedAt) ?? entry.order;
}

function latestTranscriptTurn(items: readonly TranscriptItem[]): TranscriptTurn | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'turn') return item;
  }
  return undefined;
}

function activityStatus(
  phase: AgentPhaseMeta | undefined,
  task: TranscriptTask | undefined,
  pendingInteractions: number,
  latestTurn: TranscriptTurn | undefined,
): AgentActivityStatus {
  if (pendingInteractions > 0 || phase?.kind === 'awaiting_approval') return 'waiting';
  if (phase?.kind === 'retrying') return 'retrying';
  if (
    phase?.kind === 'running' ||
    phase?.kind === 'streaming' ||
    phase?.kind === 'tool_call' ||
    task?.state === 'running' ||
    latestTurn?.state === 'running'
  ) return 'running';
  if (task !== undefined && ['failed', 'timed_out', 'killed', 'lost'].includes(task.state)) return 'failed';
  if (phase?.kind === 'ended' && (phase.reason === 'failed' || phase.reason === 'blocked')) return 'failed';
  if (latestTurn?.state === 'failed') return 'failed';
  if (phase?.kind === 'interrupted' || (phase?.kind === 'ended' && phase.reason === 'cancelled')) return 'interrupted';
  if (latestTurn?.state === 'cancelled') return 'interrupted';
  if (task?.state === 'completed' || phase?.kind === 'ended' || latestTurn?.state === 'completed') return 'completed';
  return 'idle';
}

function activityAction(
  status: AgentActivityStatus,
  phase: AgentPhaseMeta | undefined,
  task: TranscriptTask | undefined,
  pending: readonly { readonly interactionKind: 'approval' | 'question' }[],
  latestTurn: TranscriptTurn | undefined,
): string {
  if (status === 'waiting') {
    return pending.some((interaction) => interaction.interactionKind === 'approval') ? '等待权限确认' : '等待回答';
  }
  if (status === 'retrying' && phase?.kind === 'retrying') {
    return `重试 ${String(phase.nextAttempt)}/${String(phase.maxAttempts)}`;
  }
  if (status === 'running') {
    const frame = latestRunningFrame(latestTurn);
    if (phase?.kind === 'tool_call') {
      const name = phase.name.length > 0 ? phase.name : '调用工具';
      const summary = frame === undefined ? '' : agentToolSummary(frame);
      return summary.length > 0 ? `${name} · ${summary}` : name;
    }
    if (phase?.kind === 'streaming') {
      if (phase.stream === 'thinking') return 'Thinking';
      if (phase.stream === 'assistant') return '生成回复';
      return phase.toolName ?? '调用工具';
    }
    if (frame?.kind === 'tool') return frame.name || '调用工具';
    if (frame?.kind === 'thinking') return 'Thinking';
    return task?.description ?? '执行任务';
  }
  if (status === 'failed') return task?.error ?? latestTurn?.error ?? '执行失败';
  if (status === 'interrupted') return '执行已中断';
  if (status === 'completed') return '已完成（上下文保留）';
  return '等待任务';
}

function latestRunningFrame(turn?: TranscriptTurn): TranscriptFrame | undefined {
  if (turn === undefined) return undefined;
  for (let stepIndex = turn.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const frames = turn.steps[stepIndex]?.frames ?? [];
    for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const frame = frames[frameIndex];
      if (frame?.kind === 'tool' && frame.state === 'running') return frame;
      if (frame?.kind === 'thinking' || frame?.kind === 'text') return frame;
    }
  }
  return undefined;
}

function activityStartedAt(
  phase: AgentPhaseMeta | undefined,
  task: TranscriptTask | undefined,
  turn: TranscriptTurn | undefined,
): number | undefined {
  if (phase !== undefined && 'since' in phase) return phase.since;
  return timestamp(task?.startedAt) ?? timestamp(turn?.startedAt);
}

function activityEndedAt(
  phase: AgentPhaseMeta | undefined,
  task: TranscriptTask | undefined,
  turn: TranscriptTurn | undefined,
): number | undefined {
  if (phase?.kind === 'ended' || phase?.kind === 'interrupted') return phase.at;
  return timestamp(task?.endedAt) ?? timestamp(turn?.endedAt);
}

function relationship(
  agent: AgentDescriptor,
  descriptors: ReadonlyMap<string, AgentDescriptor>,
): { readonly kind: 'root' | 'child'; readonly parentId?: string } | { readonly kind: 'unattached' } {
  if (agent.agentId === 'main') return { kind: 'root' };
  if (agent.parentAgentId === undefined) {
    return agent.type === 'independent' ? { kind: 'root' } : { kind: 'unattached' };
  }
  const seen = new Set([agent.agentId]);
  let parentId: string | undefined = agent.parentAgentId;
  while (parentId !== undefined) {
    if (seen.has(parentId)) return { kind: 'unattached' };
    seen.add(parentId);
    const parent = descriptors.get(parentId);
    if (parent === undefined) return { kind: 'unattached' };
    if (parent.agentId === 'main' || parent.type === 'independent') break;
    parentId = parent.parentAgentId;
    if (parentId === undefined) return { kind: 'unattached' };
  }
  return { kind: 'child', parentId: agent.parentAgentId };
}

function agentNodeCompare(descriptors: readonly AgentDescriptor[]): (left: MutableNode, right: MutableNode) => number {
  const order = new Map(descriptors.map((descriptor, index) => [descriptor.agentId, index]));
  return (left, right) => {
    const created = (left.agent.createdAt ?? '').localeCompare(right.agent.createdAt ?? '');
    if (created !== 0 && left.agent.createdAt !== undefined && right.agent.createdAt !== undefined) return created;
    const natural = left.agent.agentId.localeCompare(right.agent.agentId, undefined, { numeric: true });
    return natural !== 0 ? natural : (order.get(left.agent.agentId) ?? 0) - (order.get(right.agent.agentId) ?? 0);
  };
}

function sortNodes(nodes: MutableNode[], compare: (left: MutableNode, right: MutableNode) => number): void {
  nodes.sort(compare);
  for (const node of nodes) sortNodes(node.children, compare);
}

function calculateCounts(node: MutableNode): AgentActivityCounts {
  let counts = countStatus(node.status);
  for (const child of node.children) counts = addCounts(counts, calculateCounts(child));
  node.counts = counts;
  return counts;
}

function collectLinkedTaskIds(
  store: TranscriptStore,
  tasksByAgent: ReadonlyMap<string, readonly TaskIndexEntry[]>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const descriptor of store.agents()) {
    for (const item of store.getAgent(descriptor.agentId)?.getItems() ?? []) {
      if (item.kind !== 'turn') continue;
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind !== 'tool' || frame.agentRefs === undefined) continue;
          if (frame.taskId !== undefined) ids.add(frame.taskId);
          for (const ref of frame.agentRefs) {
            for (const entry of tasksByAgent.get(ref.agentId) ?? []) ids.add(entry.task.taskId);
          }
        }
      }
    }
  }
  return ids;
}

function countStatus(status: AgentActivityStatus): AgentActivityCounts {
  const counts = { ...emptyCounts(), total: 1 };
  if (status === 'waiting') counts.waiting = 1;
  else if (status === 'running' || status === 'retrying') counts.running = 1;
  else counts[status] = 1;
  return counts;
}

function addCounts(left: AgentActivityCounts, right: AgentActivityCounts): AgentActivityCounts {
  return {
    waiting: left.waiting + right.waiting,
    running: left.running + right.running,
    failed: left.failed + right.failed,
    interrupted: left.interrupted + right.interrupted,
    completed: left.completed + right.completed,
    idle: left.idle + right.idle,
    total: left.total + right.total,
  };
}

function emptyCounts(): AgentActivityCounts {
  return { waiting: 0, running: 0, failed: 0, interrupted: 0, completed: 0, idle: 0, total: 0 };
}

function emptyForest(): AgentActivityForest {
  return { roots: [], unattached: [], byId: new Map(), linkedTaskIds: new Set(), counts: emptyCounts() };
}

function timestamp(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function agentToolSummary(frame: TranscriptFrame): string {
  if (frame.kind !== 'tool') return '';
  const display = record(frame.display);
  const input = record(frame.input);
  return text(display['summary'], text(display['description'], text(input['path'], text(input['command']))));
}
