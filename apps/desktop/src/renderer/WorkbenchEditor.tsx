import { Editor } from '@monaco-editor/react';
import { AlertTriangle, FileWarning, GitCompare, RefreshCw, RotateCcw, Save } from 'lucide-react';
import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';

import type { DiffWorkbenchTab, FileWorkbenchTab, OperationDiffWorkbenchTab } from './workbench-tabs';

interface FileEditorProps {
  readonly tab: FileWorkbenchTab;
  readonly theme: 'vs' | 'vs-dark';
  readonly onChange: (content: string) => void;
  readonly onSave: (force?: boolean) => void;
  readonly onReload: () => void;
  readonly onCompareConflict: () => void;
}

export function FileEditorView(props: FileEditorProps) {
  if (props.tab.loading) return <EditorLoading label={`正在读取 ${props.tab.path}`} />;
  if (props.tab.error !== undefined) {
    return <EditorMessage icon={<FileWarning size={18} />} title="无法打开文件" detail={props.tab.error} action={<button onClick={props.onReload}><RefreshCw size={13} />重试</button>} />;
  }
  if (props.tab.file === undefined) return <EditorLoading label={`正在读取 ${props.tab.path}`} />;
  if (props.tab.file.kind !== 'text') {
    return <EditorMessage icon={<FileWarning size={18} />} title="只读文件" detail={props.tab.file.readOnlyReason ?? '该文件无法在代码编辑器中显示。'} />;
  }

  return (
    <div className="editor-view">
      <div className="editor-toolbar">
        <span className="editor-breadcrumb" title={props.tab.path}>{props.tab.path}</span>
        {props.tab.conflict && <span className="editor-conflict"><AlertTriangle size={12} />磁盘内容已更改</span>}
        <span className="editor-toolbar-spacer" />
        {props.tab.conflict && (
          <>
            <button onClick={props.onCompareConflict} title="比较磁盘内容"><RotateCcw size={13} />比较</button>
            <button onClick={props.onReload} title="放弃编辑并重新加载"><RefreshCw size={13} />重新加载</button>
          </>
        )}
        {props.tab.conflict
          ? <button className="editor-overwrite" onClick={() => props.onSave(true)} disabled={!props.tab.dirty} title="确认使用当前编辑覆盖磁盘内容"><Save size={13} />覆盖</button>
          : <button className="icon-button" onClick={() => props.onSave(false)} disabled={!props.tab.dirty} title="保存 (Ctrl+S)"><Save size={14} /></button>}
      </div>
      <div className="monaco-host">
        <Editor
          path={`file:///${props.tab.path}`}
          language={props.tab.file.languageId}
          value={props.tab.content}
          theme={props.theme}
          onChange={(value) => props.onChange(value ?? '')}
          options={EDITOR_OPTIONS}
          saveViewState
        />
      </div>
    </div>
  );
}

export function GitDiffEditorView({ tab, theme, onReload }: {
  readonly tab: DiffWorkbenchTab;
  readonly theme: 'vs' | 'vs-dark';
  readonly onReload: () => void;
}) {
  const [wide, setWide] = useState(() => window.innerWidth >= 1_360);
  useEffect(() => {
    const listener = () => setWide(window.innerWidth >= 1_360);
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  }, []);

  if (tab.loading) return <EditorLoading label={`正在读取 ${tab.path} 的差异`} />;
  if (tab.error !== undefined) {
    return <EditorMessage icon={<FileWarning size={18} />} title="无法读取差异" detail={tab.error} action={<button onClick={onReload}><RefreshCw size={13} />重试</button>} />;
  }
  if (tab.diff === undefined) return <EditorLoading label={`正在读取 ${tab.path} 的差异`} />;
  if (tab.diff.binary || tab.diff.truncated || tab.diff.original === undefined || tab.diff.modified === undefined) {
    return <EditorMessage icon={<FileWarning size={18} />} title="无法显示文本差异" detail={tab.diff.binary ? '该变更包含二进制或非 UTF-8 内容。' : '该变更超过编辑器的 2 MiB 显示上限。'} />;
  }

  return (
    <div className="editor-view diff-editor-view">
      <div className="editor-toolbar">
        <span className="diff-side-label">{tab.diff.originalLabel}</span>
        <span className="diff-arrow">→</span>
        <span className="diff-side-label">{tab.diff.modifiedLabel}</span>
        <span className="editor-toolbar-spacer" />
        <button className="icon-button" onClick={onReload} title="刷新差异"><RefreshCw size={13} /></button>
      </div>
      <div className="monaco-host">
        <ManagedDiffEditor
          original={tab.diff.original}
          modified={tab.diff.modified}
          originalModelPath={`git-original:///${tab.area}/${tab.path}`}
          modifiedModelPath={`git-modified:///${tab.area}/${tab.path}`}
          language={tab.diff.languageId}
          theme={theme}
          renderSideBySide={wide}
        />
      </div>
    </div>
  );
}

export function OperationDiffEditorView({ tab, theme, onOpenGitDiff }: {
  readonly tab: OperationDiffWorkbenchTab;
  readonly theme: 'vs' | 'vs-dark';
  readonly onOpenGitDiff: () => void;
}) {
  const [wide, setWide] = useState(() => window.innerWidth >= 1_360);
  useEffect(() => {
    const listener = () => setWide(window.innerWidth >= 1_360);
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  }, []);

  return (
    <div className="editor-view diff-editor-view operation-diff-editor-view">
      <div className="editor-toolbar">
        <span className="diff-side-label">操作前片段</span>
        <span className="diff-arrow">→</span>
        <span className="diff-side-label">操作后片段</span>
        <span className="editor-breadcrumb" title={tab.path}>{tab.path}</span>
        <span className="editor-toolbar-spacer" />
        <button onClick={onOpenGitDiff} title="查看当前工作区相对 Git Index 的差异"><GitCompare size={13} />当前 Git 差异</button>
      </div>
      <div className="monaco-host">
        <ManagedDiffEditor
          original={tab.before}
          modified={tab.after}
          originalModelPath={`operation-before:///${encodeURIComponent(tab.toolCallId)}/${tab.path}`}
          modifiedModelPath={`operation-after:///${encodeURIComponent(tab.toolCallId)}/${tab.path}`}
          language="plaintext"
          theme={theme}
          renderSideBySide={wide}
        />
      </div>
    </div>
  );
}

export function MemoryDiffDialog({ path, disk, editor, languageId, theme, onClose }: {
  readonly path: string;
  readonly disk: string;
  readonly editor: string;
  readonly languageId: string;
  readonly theme: 'vs' | 'vs-dark';
  readonly onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="memory-diff-dialog" role="dialog" aria-modal="true" aria-label={`${path} 磁盘冲突比较`}>
        <header><strong>{path}</strong><span>磁盘内容 → 当前编辑</span><button onClick={onClose}>关闭</button></header>
        <ManagedDiffEditor
          original={disk}
          modified={editor}
          originalModelPath={`disk-conflict:///${path}`}
          modifiedModelPath={`editor-conflict:///${path}`}
          language={languageId}
          theme={theme}
          renderSideBySide
        />
      </div>
    </div>
  );
}

function ManagedDiffEditor({
  original,
  modified,
  originalModelPath,
  modifiedModelPath,
  language,
  theme,
  renderSideBySide,
}: {
  readonly original: string;
  readonly modified: string;
  readonly originalModelPath: string;
  readonly modifiedModelPath: string;
  readonly language: string;
  readonly theme: 'vs' | 'vs-dark';
  readonly renderSideBySide?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
  const originalRef = useRef<monaco.editor.ITextModel | undefined>(undefined);
  const modifiedRef = useRef<monaco.editor.ITextModel | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const originalUri = monaco.Uri.parse(originalModelPath);
    const modifiedUri = monaco.Uri.parse(modifiedModelPath);
    const originalModel = monaco.editor.getModel(originalUri) ?? monaco.editor.createModel(original, language, originalUri);
    const modifiedModel = monaco.editor.getModel(modifiedUri) ?? monaco.editor.createModel(modified, language, modifiedUri);
    const diffEditor = monaco.editor.createDiffEditor(host, {
      ...DIFF_OPTIONS,
      renderSideBySide,
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    editorRef.current = diffEditor;
    originalRef.current = originalModel;
    modifiedRef.current = modifiedModel;

    return () => {
      diffEditor.setModel(null);
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
      editorRef.current = undefined;
      originalRef.current = undefined;
      modifiedRef.current = undefined;
    };
  }, [originalModelPath, modifiedModelPath]);

  useEffect(() => {
    const originalModel = originalRef.current;
    const modifiedModel = modifiedRef.current;
    if (originalModel !== undefined && originalModel.getValue() !== original) originalModel.setValue(original);
    if (modifiedModel !== undefined && modifiedModel.getValue() !== modified) modifiedModel.setValue(modified);
    if (originalModel !== undefined) monaco.editor.setModelLanguage(originalModel, language);
    if (modifiedModel !== undefined) monaco.editor.setModelLanguage(modifiedModel, language);
    editorRef.current?.updateOptions({ ...DIFF_OPTIONS, renderSideBySide });
    monaco.editor.setTheme(theme);
  }, [language, modified, original, renderSideBySide, theme]);

  return <div className="managed-monaco-diff" ref={hostRef} />;
}

function EditorLoading({ label }: { readonly label: string }) {
  return <div className="editor-state"><RefreshCw className="spin" size={17} /><span>{label}</span></div>;
}

function EditorMessage({ icon, title, detail, action }: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly action?: React.ReactNode;
}) {
  return <div className="editor-state editor-message">{icon}<strong>{title}</strong><span>{detail}</span>{action}</div>;
}

const EDITOR_OPTIONS = {
  automaticLayout: true,
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
  minimap: { enabled: false },
  padding: { top: 8, bottom: 8 },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  tabSize: 2,
  wordWrap: 'off' as const,
};

const DIFF_OPTIONS = {
  automaticLayout: true,
  fontSize: 12,
  lineHeight: 19,
  minimap: { enabled: false },
  readOnly: true,
  renderOverviewRuler: true,
  scrollBeyondLastLine: false,
  splitViewDefaultRatio: 0.5,
};
