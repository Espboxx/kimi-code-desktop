import { useState } from 'react';
import {
  Activity,
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileDiff,
  GitBranch,
  Play,
  Square,
  TerminalSquare,
} from 'lucide-react';

import type { DesktopSnapshot } from '../shared/desktop-api';
import type { GitChangeEntry, GitTreeNode } from './git-tree';
import { buildGitTree, gitStatusLabel, gitStatusLetter, groupGitChanges } from './git-tree';
import { classNames, formatJson, text } from './ui-utils';

export type BottomTab = 'changes' | 'diff' | 'shell' | 'events';

interface DiffState {
  readonly path: string;
  readonly patch: string;
  readonly truncated: boolean;
}

interface BottomPanelProps {
  readonly snapshot: DesktopSnapshot;
  readonly tab: BottomTab;
  readonly collapsed: boolean;
  readonly diff?: DiffState;
  readonly onTab: (tab: BottomTab) => void;
  readonly onToggleCollapsed: () => void;
  readonly onOpenDiff: (path: string, area: GitChangeEntry['area']) => void;
  readonly onOpenRawDiff: (path?: string) => void;
}

export function BottomPanel(props: BottomPanelProps) {
  const [command, setCommand] = useState('');
  const tabs: Array<{ id: BottomTab; label: string; icon: React.ReactNode; count?: number }> = [
    { id: 'changes', label: 'Changes', icon: <GitBranch size={13} />, count: props.snapshot.gitFiles.length },
    { id: 'diff', label: 'Diff', icon: <FileDiff size={13} /> },
    { id: 'shell', label: 'Session Shell', icon: <TerminalSquare size={13} /> },
    { id: 'events', label: 'Events', icon: <Activity size={13} />, count: props.snapshot.rawEvents.length },
  ];
  const run = async () => {
    const value = command.trim();
    if (value.length === 0 || props.snapshot.activeSessionId === undefined) return;
    setCommand('');
    await window.kimiDesktop.shell.run(value, props.snapshot.activeSessionId);
  };
  return (
    <section className={classNames('bottom-panel', props.collapsed && 'collapsed')}>
      <div className="bottom-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            role="tab"
            aria-selected={props.tab === item.id}
            className={props.tab === item.id ? 'active' : ''}
            onClick={() => props.onTab(item.id)}
            key={item.id}
          >{item.icon}<span>{item.label}</span>{item.count !== undefined && <em>{item.count}</em>}</button>
        ))}
        <span className="bottom-spacer" />
        <button className="icon-button" onClick={props.onToggleCollapsed} title={props.collapsed ? '展开' : '收起'}>
          {props.collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {!props.collapsed && (
        <div className="bottom-content">
          {props.tab === 'changes' && (
            <div className="changes-view">
              {props.snapshot.gitFiles.length === 0
                ? <div className="panel-empty">工作区没有 Git 变更</div>
                : groupGitChanges(props.snapshot.gitFiles).map((group) => (
                    <ChangeGroup
                      label={group.label}
                      entries={group.entries}
                      onOpenDiff={props.onOpenDiff}
                      onOpenRawDiff={props.onOpenRawDiff}
                      key={group.id}
                    />
                  ))}
            </div>
          )}
          {props.tab === 'diff' && (
            <div className="diff-view">
              <div className="diff-title"><FileDiff size={13} /><span>{props.diff?.path ?? '选择一个变更文件'}</span>{props.diff?.truncated === true && <em>truncated</em>}</div>
              <pre>{props.diff?.patch || '从 Changes 中选择文件查看 diff。'}</pre>
            </div>
          )}
          {props.tab === 'shell' && (
            <div className="shell-view">
              <div className="shell-output">
                {props.snapshot.shell.command !== undefined && <div className="shell-command">$ {props.snapshot.shell.command}</div>}
                {props.snapshot.shell.stdout.length > 0 && <pre>{props.snapshot.shell.stdout}</pre>}
                {props.snapshot.shell.stderr.length > 0 && <pre className="stderr">{props.snapshot.shell.stderr}</pre>}
                {props.snapshot.shell.status === 'idle' && <div className="panel-empty">Session shell 输出会显示在这里</div>}
              </div>
              <div className="shell-input">
                <span>$</span>
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void run(); }}
                  placeholder="在 Kimi session shell 中运行命令"
                  disabled={props.snapshot.activeSessionId === undefined || props.snapshot.shell.status === 'running'}
                />
                {props.snapshot.shell.status === 'running' && props.snapshot.shell.commandId !== undefined
                  ? <button className="icon-button" title="取消" onClick={() => void window.kimiDesktop.shell.cancel(props.snapshot.shell.commandId ?? '', props.snapshot.activeSessionId)}><Square size={13} /></button>
                  : <button className="icon-button" title="运行" onClick={() => void run()}><Play size={13} /></button>}
              </div>
            </div>
          )}
          {props.tab === 'events' && (
            <div className="events-view">
              {props.snapshot.rawEvents.length === 0 ? <div className="panel-empty">尚无原始事件</div> : props.snapshot.rawEvents.toReversed().map((event, index) => (
                <details key={`${text(event['type'], 'event')}-${index}`}>
                  <summary><Braces size={12} /><strong>{text(event['type'], 'event')}</strong><span>{text(event['agentId'])}</span></summary>
                  <pre>{formatJson(event)}</pre>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ChangeGroup({ label, entries, onOpenDiff, onOpenRawDiff }: {
  readonly label: string;
  readonly entries: readonly GitChangeEntry[];
  readonly onOpenDiff: (path: string, area: GitChangeEntry['area']) => void;
  readonly onOpenRawDiff: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="change-group">
      <button className="change-group-heading" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <strong>{label}</strong>
        <em>{entries.length}</em>
      </button>
      {open && <GitChangeTree nodes={buildGitTree(entries)} depth={0} onOpenDiff={onOpenDiff} onOpenRawDiff={onOpenRawDiff} />}
    </section>
  );
}

function GitChangeTree({ nodes, depth, onOpenDiff, onOpenRawDiff }: {
  readonly nodes: readonly GitTreeNode[];
  readonly depth: number;
  readonly onOpenDiff: (path: string, area: GitChangeEntry['area']) => void;
  readonly onOpenRawDiff: (path: string) => void;
}) {
  return <>{nodes.map((node) => node.kind === 'directory'
    ? <GitChangeDirectory node={node} depth={depth} onOpenDiff={onOpenDiff} onOpenRawDiff={onOpenRawDiff} key={node.path} />
    : (
      <div className="change-tree-row" style={{ paddingLeft: 8 + depth * 14 }} key={node.entry.key}>
        <button className="change-tree-main" onClick={() => onOpenDiff(node.path, node.entry.area)} title={`${node.path} · ${gitStatusLabel(node.entry.status)}`}>
          <span className="tree-spacer" />
          <span className={`git-status git-${node.entry.status}`}>{gitStatusLetter(node.entry.status)}</span>
          <span>{node.name}</span>
          <small><b>+{node.entry.stats.additions}</b><i>-{node.entry.stats.deletions}</i></small>
        </button>
        <button className="icon-button raw-diff-button" onClick={() => onOpenRawDiff(node.path)} title="在底部查看原始 patch"><FileDiff size={12} /></button>
      </div>
    ))}</>;
}

function GitChangeDirectory({ node, depth, onOpenDiff, onOpenRawDiff }: {
  readonly node: Extract<GitTreeNode, { kind: 'directory' }>;
  readonly depth: number;
  readonly onOpenDiff: (path: string, area: GitChangeEntry['area']) => void;
  readonly onOpenRawDiff: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="change-tree-directory">
      <button className="change-tree-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{node.name}</span>
      </button>
      {open && <GitChangeTree nodes={node.children} depth={depth + 1} onOpenDiff={onOpenDiff} onOpenRawDiff={onOpenRawDiff} />}
    </div>
  );
}
