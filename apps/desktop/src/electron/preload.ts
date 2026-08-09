import { contextBridge, ipcRenderer } from 'electron';

import {
  createKimiDesktopApi,
  type DesktopDomain,
  type KimiDesktopNotification,
} from '../shared/desktop-api';

const api = createKimiDesktopApi(
  <T>(domain: DesktopDomain, action: string, payload?: unknown) =>
    ipcRenderer.invoke('kimi-desktop:command', { domain, action, payload }) as Promise<T>,
  (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      notification: KimiDesktopNotification,
    ): void => listener(notification);
    ipcRenderer.on('kimi-desktop:notification', handler);
    return () => ipcRenderer.removeListener('kimi-desktop:notification', handler);
  },
);

contextBridge.exposeInMainWorld('kimiDesktop', api);
