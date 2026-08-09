import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CirclePause,
  CircleStop,
  HelpCircle,
  RotateCw,
  Users,
} from 'lucide-react';
import type { AgentRef } from '@moonshot-ai/transcript';

import {
  agentActivityIsActive,
  agentActivityLabel,
  type AgentActivityCounts,
  type AgentActivityForest,
  type AgentActivityNode,
  type AgentActivityStatus,
} from './agent-activity';
import { classNames } from './ui-utils';

interface AgentActivityTreeProps {
  readonly nodes: readonly AgentActivityNode[];
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly compact?: boolean;
}

export function AgentActivityTree(props: AgentActivityTreeProps) {
  const active = props.nodes.some((node) => node.counts.running > 0 || node.counts.waiting > 0);
  const now = useActivityClock(active);
  return (
    <div className={classNames('agent-activity-tree', props.compact && 'compact')} role="tree">
      {props.nodes.map((node) => (
        <AgentActivityBranch
          node={node}
          depth={0}
          now={now}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
          compact={props.compact === true}
          key={node.agent.agentId}
        />
      ))}
    </div>
  );
}

export function InlineAgentActivity({
  refs,
  forest,
  selectedAgentId,
  onSelectAgent,
}: {
  readonly refs: readonly AgentRef[];
  readonly forest: AgentActivityForest;
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const nodes = useMemo(() => referencedRoots(refs, forest), [forest, refs]);
  const counts = useMemo(() => sumCounts(nodes), [nodes]);
  const active = counts.running > 0 || counts.waiting > 0;
  const wasActive = useRef(active);
  const [expanded, setExpanded] = useState(active);

  useEffect(() => {
    if (active) setExpanded(true);
    else if (wasActive.current) setExpanded(false);
    wasActive.current = active;
  }, [active]);

  if (nodes.length === 0) return null;
  return (
    <section className={classNames('inline-agent-activity', active && 'active')}>
      <button
        className="inline-agent-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => { setExpanded((value) => !value); }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Users size={14} />
        <strong>并行 Agent</strong>
        <span>{activityCountsLabel(counts)}</span>
      </button>
      {expanded && (
        <AgentActivityTree
          nodes={nodes}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
          compact
        />
      )}
    </section>
  );
}

function AgentActivityBranch({
  node,
  depth,
  now,
  selectedAgentId,
  onSelectAgent,
  compact,
}: {
  readonly node: AgentActivityNode;
  readonly depth: number;
  readonly now: number;
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly compact: boolean;
}) {
  const activeDescendants = node.counts.running > 0 || node.counts.waiting > 0;
  const isMain = node.agent.agentId === 'main';
  const wasActive = useRef(activeDescendants);
  const [expanded, setExpanded] = useState(isMain || activeDescendants);

  useEffect(() => {
    if (isMain || activeDescendants) setExpanded(true);
    else if (wasActive.current) setExpanded(false);
    wasActive.current = activeDescendants;
  }, [activeDescendants, isMain]);

  const hasChildren = node.children.length > 0;
  const duration = activityDuration(node, now);
  const descendantLabel = isMain ? descendantCountsLabel(node.counts, node.status) : undefined;
  const statusLabel = node.status === 'completed' && isMain ? '已完成' : agentActivityLabel(node.status);
  return (
    <div className="agent-activity-branch" role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={classNames(
          'agent-activity-row',
          selectedAgentId === node.agent.agentId && 'selected',
          agentActivityIsActive(node.status) && 'active',
          `status-${node.status}`,
        )}
        style={{ '--agent-depth': depth } as CSSProperties}
      >
        {hasChildren ? (
          <button
            className="agent-tree-toggle"
            type="button"
            onClick={() => { setExpanded((value) => !value); }}
            title={expanded ? '折叠' : '展开'}
          >{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
        ) : <span className="agent-tree-spacer" />}
        <span className="agent-activity-avatar"><Bot size={13} /></span>
        <button className="agent-activity-main" type="button" onClick={() => { onSelectAgent(node.agent.agentId); }}>
          <span className="agent-activity-title">
            <strong>{node.agent.label ?? node.agent.agentId}</strong>
            {!compact && <small>{node.agent.agentId}</small>}
          </span>
          <span className="agent-activity-detail">
            <span>{descendantLabel ?? node.action}</span>
            {duration !== undefined && <time>{duration}</time>}
          </span>
        </button>
        <span className="agent-activity-state" title={statusLabel}>
          <AgentStatusIcon status={node.status} />
          <span>{statusLabel}</span>
        </span>
      </div>
      {hasChildren && expanded && (
        <div
          className="agent-activity-children"
          role="group"
          style={{ '--agent-parent-depth': depth } as CSSProperties}
        >
          {node.children.map((child) => (
            <AgentActivityBranch
              node={child}
              depth={depth + 1}
              now={now}
              selectedAgentId={selectedAgentId}
              onSelectAgent={onSelectAgent}
              compact={compact}
              key={child.agent.agentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentStatusIcon({ status }: { readonly status: AgentActivityStatus }) {
  if (status === 'waiting') return <HelpCircle size={13} />;
  if (status === 'retrying') return <RotateCw className="spin" size={13} />;
  if (status === 'running') return <CircleDashed className="spin" size={13} />;
  if (status === 'failed') return <AlertCircle size={13} />;
  if (status === 'interrupted') return <CircleStop size={13} />;
  if (status === 'completed') return <CheckCircle2 size={13} />;
  return <CirclePause size={13} />;
}

function referencedRoots(
  refs: readonly AgentRef[],
  forest: AgentActivityForest,
): readonly AgentActivityNode[] {
  const ids = new Set(refs.map((ref) => ref.agentId));
  const nodes = refs
    .map((ref) => forest.byId.get(ref.agentId))
    .filter((node): node is AgentActivityNode => node !== undefined);
  return nodes.filter((node) => node.agent.parentAgentId === undefined || !ids.has(node.agent.parentAgentId));
}

function sumCounts(nodes: readonly AgentActivityNode[]): AgentActivityCounts {
  return nodes.reduce((total: AgentActivityCounts, node) => ({
    waiting: total.waiting + node.counts.waiting,
    running: total.running + node.counts.running,
    failed: total.failed + node.counts.failed,
    interrupted: total.interrupted + node.counts.interrupted,
    completed: total.completed + node.counts.completed,
    idle: total.idle + node.counts.idle,
    total: total.total + node.counts.total,
  }), { waiting: 0, running: 0, failed: 0, interrupted: 0, completed: 0, idle: 0, total: 0 });
}

function activityCountsLabel(counts: AgentActivityCounts): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`运行 ${String(counts.running)}`);
  if (counts.waiting > 0) parts.push(`等待 ${String(counts.waiting)}`);
  if (counts.failed > 0) parts.push(`失败 ${String(counts.failed)}`);
  if (counts.interrupted > 0) parts.push(`中断 ${String(counts.interrupted)}`);
  if (counts.completed > 0) parts.push(`完成 ${String(counts.completed)}`);
  if (parts.length === 0) parts.push(`${String(counts.total)} 空闲`);
  return parts.join(' · ');
}

function descendantCountsLabel(counts: AgentActivityCounts, own: AgentActivityStatus): string {
  const ownRunning = own === 'running' || own === 'retrying' ? 1 : 0;
  const ownWaiting = own === 'waiting' ? 1 : 0;
  const ownCompleted = own === 'completed' ? 1 : 0;
  const running = Math.max(0, counts.running - ownRunning);
  const waiting = Math.max(0, counts.waiting - ownWaiting);
  const completed = Math.max(0, counts.completed - ownCompleted);
  const parts = [`${String(counts.total - 1)} 个后代`];
  if (running > 0) parts.push(`运行 ${String(running)}`);
  if (waiting > 0) parts.push(`等待 ${String(waiting)}`);
  if (completed > 0) parts.push(`完成 ${String(completed)}`);
  return parts.join(' · ');
}

function activityDuration(node: AgentActivityNode, now: number): string | undefined {
  if (node.startedAt === undefined) return undefined;
  const end = node.endedAt ?? (agentActivityIsActive(node.status) ? now : undefined);
  if (end === undefined || end < node.startedAt) return undefined;
  const milliseconds = end - node.startedAt;
  if (milliseconds < 1_000) return `${String(Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${String(Math.floor(milliseconds / 60_000))}m ${String(Math.floor(milliseconds % 60_000 / 1_000))}s`;
}

function useActivityClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
