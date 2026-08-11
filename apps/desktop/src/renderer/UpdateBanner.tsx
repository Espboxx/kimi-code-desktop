import { Download, ExternalLink, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DesktopUpdateSnapshot } from '../shared/desktop-api';

export function UpdateBanner({
  update,
  onOpenSettings,
}: {
  readonly update: DesktopUpdateSnapshot;
  readonly onOpenSettings: () => void;
}) {
  const stateKey = `${update.status}:${update.latestVersion ?? ''}`;
  const [dismissedKey, setDismissedKey] = useState<string>();
  useEffect(() => {
    if (dismissedKey !== undefined && dismissedKey !== stateKey) setDismissedKey(undefined);
  }, [dismissedKey, stateKey]);

  if (
    dismissedKey === stateKey ||
    (update.status !== 'available' && update.status !== 'downloading' && update.status !== 'downloaded')
  ) return null;

  const downloading = update.status === 'downloading';
  const downloaded = update.status === 'downloaded';
  const percent = Math.round(update.progress?.percent ?? 0);
  return (
    <aside className="update-banner" aria-live="polite">
      <span className="update-banner-icon">{downloaded ? <RefreshCw size={15} /> : <Download size={15} />}</span>
      <div className="update-banner-copy">
        <strong>{downloaded
          ? `Kimi Code Desktop ${update.latestVersion ?? ''} 已下载`
          : downloading
            ? `正在下载 Kimi Code Desktop ${update.latestVersion ?? ''}`
            : `Kimi Code Desktop ${update.latestVersion ?? ''} 可用`}</strong>
        <small>{downloaded
          ? '立即重启完成安装，或稍后在正常退出时安装。'
          : downloading
            ? `下载进度 ${percent}%`
            : update.mode === 'automatic'
              ? '查看发布说明，确认后开始下载。'
              : '当前安装格式通过 GitHub Release 更新。'}</small>
      </div>
      {downloading && <div className="update-banner-progress"><span style={{ width: `${update.progress?.percent ?? 0}%` }} /></div>}
      <div className="update-banner-actions">
        {!downloading && <button onClick={onOpenSettings}>查看详情</button>}
        {update.status === 'available' && update.mode === 'automatic' && (
          <button className="button-primary" onClick={() => void window.kimiDesktop.update.download()}><Download size={13} />下载更新</button>
        )}
        {update.status === 'available' && update.mode === 'manual' && (
          <button className="button-primary" onClick={() => void window.kimiDesktop.update.openRelease()}><ExternalLink size={13} />前往 Release</button>
        )}
        {downloaded && (
          <button className="button-primary" onClick={() => void window.kimiDesktop.update.install()}><RefreshCw size={13} />立即重启</button>
        )}
        {!downloading && (
          <button className="icon-button" onClick={() => setDismissedKey(stateKey)} title={downloaded ? '稍后' : '关闭'}><X size={13} /></button>
        )}
      </div>
    </aside>
  );
}
