import { AlertTriangle, CircleDashed, Save, Trash2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function DirtyFilesDialog({ title, paths, busy, error, onSave, onDiscard, onCancel }: {
  readonly title: string;
  readonly paths: readonly string[];
  readonly busy: boolean;
  readonly error?: string;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [busy, onCancel]);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dirty-files-dialog" role="dialog" aria-modal="true" aria-labelledby="dirty-files-title">
        <header className="dialog-header">
          <div><AlertTriangle size={16} /><strong id="dirty-files-title">{title}</strong></div>
          <button className="icon-button" onClick={onCancel} disabled={busy} title="取消"><X size={14} /></button>
        </header>
        <div className="dialog-body">
          <p>以下文件包含尚未保存的修改：</p>
          <ul>{paths.map((path) => <li title={path} key={path}>{path}</li>)}</ul>
          {error !== undefined && <div className="dialog-danger" role="alert">{error}</div>}
        </div>
        <footer className="dialog-footer">
          <button ref={cancelRef} onClick={onCancel} disabled={busy}>取消</button>
          <button onClick={onDiscard} disabled={busy}><Trash2 size={13} />放弃{paths.length > 1 ? '全部' : ''}</button>
          <button className="button-primary" onClick={onSave} disabled={busy}>
            {busy ? <CircleDashed className="spin" size={13} /> : <Save size={13} />}保存{paths.length > 1 ? '全部' : ''}
          </button>
        </footer>
      </div>
    </div>
  );
}
