import { useEffect, useState } from 'react';
import { CircleDashed, ShieldAlert, X } from 'lucide-react';

import type { SessionPermission } from './swarm-ui';
import { record, text } from './ui-utils';

interface SwarmPermissionDialogProps {
  readonly permission: SessionPermission;
  readonly onChoose: (choice: 'yolo' | 'current') => Promise<void>;
  readonly onCancel: () => void;
}

export function SwarmPermissionDialog({ permission, onChoose, onCancel }: SwarmPermissionDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  const choose = async (choice: 'yolo' | 'current') => {
    setBusy(true);
    setError(undefined);
    try {
      await onChoose(choice);
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  };
  const currentLabel = permission === 'manual' ? 'Manual' : permission === 'auto' ? 'Auto' : 'YOLO';

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div className="action-dialog swarm-permission-dialog" role="dialog" aria-modal="true" aria-labelledby="swarm-permission-title">
        <header className="dialog-header">
          <div><ShieldAlert size={16} /><strong id="swarm-permission-title">Swarm 权限模式</strong></div>
          <button className="icon-button" onClick={onCancel} disabled={busy} title="取消"><X size={15} /></button>
        </header>
        <div className="dialog-body">
          <p>子 Agent 会继承当前会话的权限模式。</p>
          <div className="dialog-notice">
            {permission === 'yolo'
              ? 'YOLO 已应用，但进入 Swarm 失败。可以重试，或取消后保持当前权限。'
              : `保持 ${currentLabel} 时，子 Agent 的审批和提问会显示在输入框上方。`}
          </div>
          <div className="swarm-yolo-warning"><strong>YOLO</strong><span>自动允许工具操作，减少并行 Agent 等待，但不会自动回答 Agent 提问。</span></div>
          {error !== undefined && <div className="form-error" role="alert">{error}</div>}
        </div>
        <footer className="dialog-footer">
          <button onClick={onCancel} disabled={busy}>取消</button>
          {permission !== 'yolo' && <button onClick={() => void choose('current')} disabled={busy}>保持 {currentLabel}</button>}
          <button className="button-primary" autoFocus onClick={() => void choose(permission === 'yolo' ? 'current' : 'yolo')} disabled={busy}>
            {busy ? <CircleDashed className="spin" size={13} /> : <ShieldAlert size={13} />}
            {permission === 'yolo' ? '重试进入 Swarm' : '使用 YOLO'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const value = record(error);
  const code = text(value['code']);
  const message = text(value['message'], '无法进入 Swarm 模式');
  return code.length === 0 ? message : `${code}: ${message}`;
}
