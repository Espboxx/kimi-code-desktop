import { useEffect, useState } from 'react';
import { CircleDashed, ShieldAlert, Users, X } from 'lucide-react';

import { classNames } from './ui-utils';
import { ModelSelect, type SessionModelOption } from './SessionControls';

type TeamPermissionChoice = 'current' | 'yolo';
type SessionPermission = 'manual' | 'auto' | 'yolo';

export function CreateTeamDialog({ currentPermission, models, defaultModel, onCreate, onCancel }: {
  readonly currentPermission: SessionPermission;
  readonly models: readonly SessionModelOption[];
  readonly defaultModel?: string;
  readonly onCreate: (
    objective: string,
    permission: TeamPermissionChoice,
    model?: string,
  ) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [objective, setObjective] = useState('');
  const [permission, setPermission] = useState<TeamPermissionChoice>('current');
  const [model, setModel] = useState(defaultModel ?? models[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [busy, onCancel]);

  const create = async () => {
    const value = objective.trim();
    if (value.length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate(value, permission, model || undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div className="action-dialog create-team-dialog" role="dialog" aria-modal="true" aria-labelledby="create-team-title">
        <header className="dialog-header">
          <div><Users size={16} /><strong id="create-team-title">新建团队任务</strong></div>
          <button className="icon-button" onClick={onCancel} disabled={busy} title="取消"><X size={15} /></button>
        </header>
        <div className="dialog-body">
          <label className="team-objective-field">
            <span>任务目标</span>
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="描述交付目标、约束和验收标准。组长会拆分独立工作流并协调子 Agent。"
              rows={6}
              autoFocus
            />
          </label>
          <div className="team-create-model">
            <span>主代理模型</span>
            <ModelSelect
              value={model || undefined}
              models={models}
              disabled={busy || models.length === 0}
              title="主代理模型"
              onChange={setModel}
            />
            <small>子 Agent 会由主代理按每项任务从全部可用模型中单独选择。</small>
          </div>
          <fieldset className="team-permission-options">
            <legend>工具权限</legend>
            <label className={classNames('team-permission-option', permission === 'current' && 'selected')}>
              <input type="radio" name="team-permission" checked={permission === 'current'} onChange={() => setPermission('current')} />
              <span><strong>使用当前默认权限</strong><small>{permissionLabel(currentPermission)}；需要时会请求确认。</small></span>
            </label>
            <label className={classNames('team-permission-option', permission === 'yolo' && 'selected')}>
              <input type="radio" name="team-permission" checked={permission === 'yolo'} onChange={() => setPermission('yolo')} />
              <ShieldAlert size={15} />
              <span><strong>YOLO</strong><small>自动允许工具操作，减少并行 Agent 等待。</small></span>
            </label>
          </fieldset>
          {error !== undefined && <div className="form-error" role="alert">{error}</div>}
        </div>
        <footer className="dialog-footer">
          <button onClick={onCancel} disabled={busy}>取消</button>
          <button className="button-primary" onClick={() => void create()} disabled={busy || objective.trim().length === 0}>
            {busy ? <CircleDashed className="spin" size={13} /> : <Users size={13} />}
            {busy ? '正在创建…' : '创建并开始'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function permissionLabel(permission: SessionPermission): string {
  if (permission === 'manual') return 'Manual';
  if (permission === 'auto') return 'Auto';
  return 'YOLO';
}
