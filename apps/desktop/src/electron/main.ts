import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';

import type { KimiDesktopNotification } from '../shared/desktop-api';
import { parseDesktopCommand } from '../shared/desktop-command-schema';
import { assertExternalUrl, KimiDesktopRuntime, serializeError } from './runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMAND_CHANNEL = 'kimi-desktop:command';
const NOTIFICATION_CHANNEL = 'kimi-desktop:notification';

let mainWindow: BrowserWindow | undefined;
let runtime: KimiDesktopRuntime | undefined;
let exiting = false;
let allowWindowClose = false;
let dirtyPaths: readonly string[] = [];
let closeRequestId: string | undefined;

app.setName('Kimi Code Desktop');
if (process.platform === 'win32') app.setAppUserModelId('ai.moonshot.kimi-code-desktop');

function notify(notification: KimiDesktopNotification): void {
  if (mainWindow?.isDestroyed() === false) {
    mainWindow.webContents.send(NOTIFICATION_CHANNEL, notification);
  }
}

function requestRendererClose(): void {
  if (closeRequestId !== undefined || mainWindow?.isDestroyed() !== false) return;
  closeRequestId = randomUUID();
  notify({ type: 'host.closeRequested', requestId: closeRequestId, dirtyPaths });
}

function createWindow(): BrowserWindow {
  let loadingInitialDocument = true;
  const window = new BrowserWindow({
    width: 1_620,
    height: 1_040,
    minWidth: 1_180,
    minHeight: 760,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Kimi Code Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(assertExternalUrl(url));
    } catch (error) {
      notify({ type: 'error', error: serializeError(error), command: 'host.openExternal' });
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => {
    if (!loadingInitialDocument) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (allowWindowClose || dirtyPaths.length === 0) return;
    event.preventDefault();
    requestRendererClose();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  const rendererUrl = process.env['KIMI_DESKTOP_RENDERER_URL'];
  const loaded = rendererUrl === undefined
    ? window.loadFile(join(__dirname, '..', 'dist-renderer', 'index.html'))
    : window.loadURL(rendererUrl);
  void loaded
    .then(async () => {
      loadingInitialDocument = false;
      await runtime?.initialize();
      if (process.env['KIMI_DESKTOP_SMOKE'] === '1') setTimeout(() => app.quit(), 500);
    })
    .catch((error) => {
      loadingInitialDocument = false;
      notify({ type: 'error', error: serializeError(error), command: 'renderer.load' });
      if (process.env['KIMI_DESKTOP_SMOKE'] === '1') app.quit();
    });
  return window;
}

function registerIpc(): void {
  ipcMain.handle(COMMAND_CHANNEL, async (_event, input: unknown) => {
    const command = parseDesktopCommand(input);
    if (runtime === undefined) throw new Error('Kimi Code Desktop runtime is not ready');
    return runtime.execute(command);
  });
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  runtime = new KimiDesktopRuntime({
    workspaceRoot: process.env['KIMI_DESKTOP_WORKSPACE'] ?? process.cwd(),
    homeDir: process.env['KIMI_CODE_HOME'],
    host: {
      chooseDirectory: async () => {
        const options: Electron.OpenDialogOptions = {
          title: '选择 Kimi Code 工作区',
          properties: ['openDirectory', 'createDirectory'],
        };
        const result = mainWindow === undefined
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(mainWindow, options);
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
      openExternal: async (url) => {
        const target = assertExternalUrl(url);
        if (process.env['KIMI_DESKTOP_E2E'] !== '1') await shell.openExternal(target);
      },
      openPath: async (path) => {
        const message = await shell.openPath(path);
        if (message.length > 0) throw new Error(message);
      },
      setDirtyFiles: (paths) => {
        dirtyPaths = [...new Set(paths)].sort();
      },
      resolveClose: (requestId, action) => {
        if (requestId !== closeRequestId) return;
        closeRequestId = undefined;
        if (action === 'cancel') return;
        dirtyPaths = [];
        allowWindowClose = true;
        mainWindow?.close();
      },
      notify,
    },
  });
  registerIpc();
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('before-quit', (event) => {
  if (exiting) return;
  if (!allowWindowClose && dirtyPaths.length > 0 && mainWindow?.isDestroyed() === false) {
    event.preventDefault();
    requestRendererClose();
    return;
  }
  event.preventDefault();
  exiting = true;
  void (runtime?.close() ?? Promise.resolve()).finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
