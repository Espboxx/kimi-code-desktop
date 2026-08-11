import * as electronUpdater from 'electron-updater';

import type { DesktopUpdateProgress } from '../shared/desktop-api';
import type { AutomaticUpdateAdapter } from './update-controller';

type ProgressListener = (progress: {
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}) => void;

interface ElectronUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{ readonly updateInfo: { readonly version: string } } | null>;
  downloadUpdate(): Promise<readonly string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: ProgressListener): unknown;
  removeListener(event: 'download-progress', listener: ProgressListener): unknown;
}

export function createElectronUpdateAdapter(
  updater: ElectronUpdaterLike = electronUpdater.autoUpdater,
): AutomaticUpdateAdapter {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.logger = console;

  return {
    async prepare() {
      const result = await updater.checkForUpdates();
      return result?.updateInfo.version;
    },
    async download(onProgress) {
      const listener: ProgressListener = (progress) => onProgress(toProgress(progress));
      updater.on('download-progress', listener);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.removeListener('download-progress', listener);
      }
    },
    quitAndInstall(runAfter) {
      updater.quitAndInstall(false, runAfter);
    },
  };
}

function toProgress(progress: DesktopUpdateProgress): DesktopUpdateProgress {
  return {
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
  };
}
