import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileOutput,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitFork,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';

import type {
  GitFile,
  SessionListItem,
  SessionStatusSnapshot,
  WorkspaceNode,
  WorkspaceSnapshot,
} from '../shared/desktop-api';
import { gitDecoration, gitStatusLabel, gitStatusLetter } from './git-tree';
import { basename, classNames, formatTime } from './ui-utils';

export type SessionAction = 'rename' | 'fork' | 'export' | 'close' | 'delete';

interface SidebarProps {
  readonly workspace: WorkspaceSnapshot;
  readonly tree: readonly WorkspaceNode[];
  readonly gitFiles: readonly GitFile[];
  readonly workspaceRevision: number;
  readonly sessions: readonly SessionListItem[];
  readonly activeSessionId?: string;
  readonly activeWorkbenchSessionId?: string;
  readonly activeFilePath?: string;
  readonly openSessionIds: ReadonlySet<string>;
  readonly sessionStatuses: Readonly<Record<string, SessionStatusSnapshot>>;
  readonly pendingInteractionCounts: Readonly<Record<string, number>>;
  readonly onChooseWorkspace: () => void;
  readonly onRefreshWorkspace: () => void;
  readonly onOpenFile: (path: string) => void;
  readonly onNewSession: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onReloadSession: (sessionId: string) => void;
  readonly onSessionAction: (session: SessionListItem, action: SessionAction) => void;
}

export function Sidebar(props: SidebarProps) {
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  return (
    <aside className="sidebar">
      <div className="workspace-header">
        <button className="workspace-title" onClick={props.onChooseWorkspace} title="切换工作区">
          <FolderGit2 size={17} />
          <span><strong>{props.workspace.name || '工作区'}</strong><small>{props.workspace.root}</small></span>
        </button>
        <button className="icon-button" onClick={props.onRefreshWorkspace} title="刷新工作区"><RefreshCw size={15} /></button>
      </div>
      <div className="workspace-meta">
        <span><GitBranch size={13} />{props.workspace.branch}</span>
        <span>{props.workspace.changedFiles} changes</span>
      </div>

      <SidebarSection
        title="文件"
        open={workspaceOpen}
        onToggle={() => setWorkspaceOpen((value) => !value)}
        action={<button className="icon-button subtle" onClick={props.onChooseWorkspace} title="打开工作区"><FolderOpen size={14} /></button>}
      >
        <div className="tree-scroll" role="tree" aria-label="工作区文件">
          {props.tree.length === 0 ? <div className="sidebar-empty">没有可显示的文件</div> : (
            <WorkspaceTree
              root={props.workspace.root}
              nodes={props.tree}
              revision={props.workspaceRevision}
              gitFiles={props.gitFiles}
              activeFilePath={props.activeFilePath}
              onOpenFile={props.onOpenFile}
            />
          )}
        </div>
      </SidebarSection>

      <SidebarSection
        title="Kimi 会话"
        count={props.sessions.length}
        open={sessionsOpen}
        onToggle={() => setSessionsOpen((value) => !value)}
        action={<button className="icon-button subtle" onClick={props.onNewSession} title="新建会话"><Plus size={15} /></button>}
      >
        <div className="session-list">
          {props.sessions.length === 0 ? <div className="sidebar-empty">当前工作区暂无会话</div> : props.sessions.map((session) => {
            const status = props.sessionStatuses[session.id];
            const pending = props.pendingInteractionCounts[session.id] ?? 0;
            return (
              <div className={classNames(
                'session-row',
                session.id === props.activeWorkbenchSessionId && 'selected',
                props.openSessionIds.has(session.id) && 'open-tab',
              )} key={session.id}>
                <button className="session-main" onClick={() => props.onSelectSession(session.id)}>
                  <span className={classNames('session-presence', (session.active || status?.busy === true) && 'active', status?.busy === true && 'busy')} />
                  <span className="session-copy">
                    <strong>{session.title || session.lastPrompt || '未命名会话'}</strong>
                    <small>{formatTime(session.updatedAt)} · {basename(session.id)}</small>
                  </span>
                  {status?.busy === true && <span className="session-state-label">Working</span>}
                  {pending > 0 && <span className="session-pending" title={`${pending} 个待处理交互`}>{pending}</span>}
                </button>
                {session.id === props.activeSessionId && (
                  <div className="session-actions">
                    <button onClick={() => props.onReloadSession(session.id)} title="重载会话"><RotateCcw size={13} /></button>
                    <button onClick={() => props.onSessionAction(session, 'rename')} title="重命名"><Pencil size={13} /></button>
                    <button onClick={() => props.onSessionAction(session, 'fork')} title="分叉"><GitFork size={13} /></button>
                    <button onClick={() => props.onSessionAction(session, 'export')} title="导出"><FileOutput size={13} /></button>
                    <button onClick={() => props.onSessionAction(session, 'close')} title="关闭"><X size={13} /></button>
                    <button className="danger" onClick={() => props.onSessionAction(session, 'delete')} title="永久删除"><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SidebarSection>
    </aside>
  );
}

function SidebarSection({ title, count, open, onToggle, action, children }: {
  readonly title: string;
  readonly count?: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={classNames('sidebar-section', !open && 'collapsed')}>
      <div className="section-heading">
        <button onClick={onToggle}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{title}</span>{count !== undefined && <em>{count}</em>}</button>
        {action}
      </div>
      {open && children}
    </section>
  );
}

function WorkspaceTree({ root, nodes, revision, gitFiles, activeFilePath, onOpenFile }: {
  readonly root: string;
  readonly nodes: readonly WorkspaceNode[];
  readonly revision: number;
  readonly gitFiles: readonly GitFile[];
  readonly activeFilePath?: string;
  readonly onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [children, setChildren] = useState<Readonly<Record<string, readonly WorkspaceNode[]>>>({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setExpanded(new Set());
    setChildren({});
    setLoading(new Set());
  }, [root]);

  useEffect(() => {
    if (revision === 0 || expanded.size === 0) return;
    let alive = true;
    void Promise.all([...expanded].map(async (path) => [path, await window.kimiDesktop.workspace.listDirectory(path)] as const))
      .then((entries) => {
        if (alive) setChildren(Object.fromEntries(entries));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [expanded, revision]);

  const toggle = async (node: WorkspaceNode, force?: boolean) => {
    const shouldOpen = force ?? !expanded.has(node.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (shouldOpen) next.add(node.path);
      else next.delete(node.path);
      return next;
    });
    if (!shouldOpen || children[node.path] !== undefined || loading.has(node.path)) return;
    setLoading((current) => new Set(current).add(node.path));
    try {
      const next = await window.kimiDesktop.workspace.listDirectory(node.path);
      setChildren((current) => ({ ...current, [node.path]: next }));
    } finally {
      setLoading((current) => {
        const next = new Set(current);
        next.delete(node.path);
        return next;
      });
    }
  };

  return (
    <TreeNodes
      nodes={nodes}
      depth={0}
      expanded={expanded}
      childrenByPath={children}
      loading={loading}
      gitFiles={gitFiles}
      activeFilePath={activeFilePath}
      onToggle={(node, force) => {
        void toggle(node, force);
      }}
      onOpenFile={onOpenFile}
    />
  );
}

function TreeNodes(props: {
  readonly nodes: readonly WorkspaceNode[];
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly childrenByPath: Readonly<Record<string, readonly WorkspaceNode[]>>;
  readonly loading: ReadonlySet<string>;
  readonly gitFiles: readonly GitFile[];
  readonly activeFilePath?: string;
  readonly onToggle: (node: WorkspaceNode, force?: boolean) => void;
  readonly onOpenFile: (path: string) => void;
}) {
  return <>{props.nodes.map((node) => <TreeNode {...props} node={node} key={node.path} />)}</>;
}

function TreeNode(props: Omit<Parameters<typeof TreeNodes>[0], 'nodes'> & { readonly node: WorkspaceNode }) {
  const { node, depth } = props;
  const status = gitDecoration(node.path, props.gitFiles, node.kind === 'directory');
  const open = props.expanded.has(node.path);
  const keyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (node.kind === 'directory' && event.key === 'ArrowRight') {
      event.preventDefault();
      props.onToggle(node, true);
    } else if (node.kind === 'directory' && event.key === 'ArrowLeft') {
      event.preventDefault();
      props.onToggle(node, false);
    } else if (node.kind === 'file' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      props.onOpenFile(node.path);
    }
  };

  if (node.kind === 'file') {
    return (
      <button
        className={classNames('tree-node', props.activeFilePath === node.path && 'selected')}
        style={{ paddingLeft: 9 + depth * 14 }}
        onClick={() => props.onOpenFile(node.path)}
        onKeyDown={keyDown}
        title={status === undefined ? node.path : `${node.path} · ${gitStatusLabel(status)}`}
        role="treeitem"
        aria-selected={props.activeFilePath === node.path}
      >
        <span className="tree-spacer" />
        {codeExtension(node.extension) ? <FileCode2 size={14} /> : <File size={14} />}
        <span>{node.name}</span>
        {status !== undefined && <span className={`tree-git-status git-${status}`}>{gitStatusLetter(status)}</span>}
      </button>
    );
  }

  const childNodes = props.childrenByPath[node.path];
  return (
    <div role="treeitem" aria-expanded={open}>
      <button
        className="tree-node folder-node"
        style={{ paddingLeft: 9 + depth * 14 }}
        onClick={() => props.onToggle(node)}
        onKeyDown={keyDown}
        title={status === undefined ? node.path : `${node.path} · 包含 Git 变更`}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Folder size={14} />
        <span>{node.name}</span>
        {props.loading.has(node.path) && <RefreshCw className="spin tree-loading" size={11} />}
        {status !== undefined && <span className={`tree-git-status git-${status}`}>{gitStatusLetter(status)}</span>}
      </button>
      {open && childNodes !== undefined && (
        <TreeNodes
          {...props}
          nodes={childNodes}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

function codeExtension(extension?: string): boolean {
  return extension !== undefined && /^(?:ts|tsx|js|jsx|py|rs|go|java|c|cc|cpp|h|css|html|json|toml|yaml|yml|md)$/.test(extension);
}
