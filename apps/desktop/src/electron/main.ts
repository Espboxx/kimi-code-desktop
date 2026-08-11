import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron';

import type { KimiDesktopNotification } from '../shared/desktop-api';
import { parseDesktopCommand } from '../shared/desktop-command-schema';
import { createElectronUpdateAdapter } from './electron-update-adapter';
import { assertExternalUrl, KimiDesktopRuntime, serializeError } from './runtime';
import {
  createGitHubReleaseClient,
  selectDesktopUpdateMode,
  UpdateController,
} from './update-controller';
import {
  isWorkspaceDirectory,
  readWorkspacePreferences,
  selectInitialWorkspace,
  workspacePreferencesPath,
  writeWorkspacePreferences,
} from './workspace-preferences';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMAND_CHANNEL = 'kimi-desktop:command';
const NOTIFICATION_CHANNEL = 'kimi-desktop:notification';
const SMOKE_TIMEOUT_MS = 10_000;

let mainWindow: BrowserWindow | undefined;
let runtime: KimiDesktopRuntime | undefined;
let updateController: UpdateController | undefined;
let startupUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let startupUpdateCheckScheduled = false;
let exiting = false;
let allowWindowClose = false;
let dirtyPaths: readonly string[] = [];
let closeRequestId: string | undefined;
let closeRequestReason: 'quit' | 'install-update' = 'quit';
let closeRequestRunAfter = false;

app.setName('Kimi Code Desktop');
if (process.platform === 'win32') app.setAppUserModelId('ai.moonshot.kimi-code-desktop');

async function smokeNativePty(): Promise<void> {
  const { spawn } = await import('node-pty');
  const shell = process.platform === 'win32'
    ? process.env['ComSpec'] ?? 'cmd.exe'
    : process.env['SHELL'] ?? '/bin/sh';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'exit 0']
    : ['-c', 'exit 0'];

  await new Promise<void>((resolve, reject) => {
    const terminal = spawn(shell, args, {
      cols: 80,
      cwd: app.getPath('temp'),
      env: process.env,
      name: 'xterm-color',
      rows: 24,
    });
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error(`Packaged PTY smoke timed out after ${SMOKE_TIMEOUT_MS} ms`));
    }, SMOKE_TIMEOUT_MS);
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve();
      else reject(new Error(`Packaged PTY smoke exited with code ${exitCode}`));
    });
  });
}

function notify(notification: KimiDesktopNotification): void {
  if (mainWindow?.isDestroyed() === false) {
    mainWindow.webContents.send(NOTIFICATION_CHANNEL, notification);
  }
}

function requestRendererClose(reason: 'quit' | 'install-update' = 'quit', runAfter = false): void {
  if (closeRequestId !== undefined || mainWindow?.isDestroyed() !== false) return;
  closeRequestId = randomUUID();
  closeRequestReason = reason;
  closeRequestRunAfter = runAfter;
  notify({ type: 'host.closeRequested', requestId: closeRequestId, dirtyPaths, reason });
}

function scheduleStartupUpdateCheck(): void {
  if (
    startupUpdateCheckScheduled ||
    updateController?.startupCheck !== true ||
    process.env['KIMI_DESKTOP_E2E'] === '1' ||
    process.env['KIMI_DESKTOP_SMOKE'] === '1'
  ) return;
  startupUpdateCheckScheduled = true;
  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = undefined;
    void updateController?.check();
  }, 5_000);
}

function requestUpdateInstall(): void {
  const controller = requireUpdateController();
  controller.assertInstallReady();
  if (dirtyPaths.length > 0 && mainWindow?.isDestroyed() === false) {
    requestRendererClose('install-update', true);
    return;
  }
  void shutdownApplication(true, true);
}

async function shutdownApplication(installUpdate: boolean, runAfter: boolean): Promise<void> {
  if (exiting) return;
  exiting = true;
  allowWindowClose = true;
  if (startupUpdateTimer !== undefined) {
    clearTimeout(startupUpdateTimer);
    startupUpdateTimer = undefined;
  }
  try {
    await (runtime?.close() ?? Promise.resolve());
  } catch (error) {
    console.error(error);
  }
  if (!installUpdate) {
    app.exit(0);
    return;
  }
  try {
    requireUpdateController().quitAndInstall(runAfter);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

function requireUpdateController(): UpdateController {
  if (updateController === undefined) throw new Error('Desktop update controller is not ready');
  return updateController;
}

function createDesktopUpdateController(): UpdateController {
  const e2eVersion = process.env['KIMI_DESKTOP_E2E_UPDATE_VERSION'];
  if (process.env['KIMI_DESKTOP_E2E'] === '1' && e2eVersion !== undefined) {
    const releaseUrl = `https://github.com/Espboxx/kimi-code-desktop/releases/tag/desktop-v${e2eVersion}`;
    return new UpdateController({
      currentVersion: app.getVersion(),
      mode: 'automatic',
      startupCheck: false,
      releaseClient: {
        latest: async () => ({
          version: e2eVersion,
          name: `Kimi Code Desktop ${e2eVersion}`,
          notes: 'Deterministic Desktop E2E update fixture.',
          url: releaseUrl,
        }),
      },
      automaticAdapter: {
        prepare: async () => e2eVersion,
        download: async (onProgress) => {
          onProgress({ percent: 50, transferred: 512, total: 1_024, bytesPerSecond: 1_024 });
          await new Promise((resolve) => setTimeout(resolve, 25));
          onProgress({ percent: 100, transferred: 1_024, total: 1_024, bytesPerSecond: 1_024 });
        },
        quitAndInstall: () => app.exit(0),
      },
      notify: (update) => notify({ type: 'update.changed', update }),
    });
  }

  const updateMode = selectDesktopUpdateMode({
    isPackaged: app.isPackaged,
    platform: process.platform,
    environment: process.env,
  });
  return new UpdateController({
    currentVersion: app.getVersion(),
    ...updateMode,
    releaseClient: createGitHubReleaseClient((input, init) => net.fetch(input, init)),
    automaticAdapter: updateMode.mode === 'automatic' ? createElectronUpdateAdapter() : undefined,
    notify: (update) => notify({ type: 'update.changed', update }),
  });
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
      scheduleStartupUpdateCheck();
      if (process.env['KIMI_DESKTOP_SMOKE'] === '1') {
        await smokeNativePty();
        setTimeout(() => app.quit(), 500);
      }
    })
    .catch((error) => {
      loadingInitialDocument = false;
      if (process.env['KIMI_DESKTOP_SMOKE'] === '1') {
        console.error(error);
        exiting = true;
        void (runtime?.close() ?? Promise.resolve()).finally(() => app.exit(1));
        return;
      }
      notify({ type: 'error', error: serializeError(error), command: 'renderer.load' });
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

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const preferencesPath = workspacePreferencesPath(app.getPath('userData'));
  const environmentWorkspace = process.env['KIMI_DESKTOP_WORKSPACE'];
  const preferences = await readWorkspacePreferences(preferencesPath);
  let initialWorkspace = selectInitialWorkspace(environmentWorkspace, preferences);
  if (
    environmentWorkspace === undefined &&
    initialWorkspace !== undefined &&
    !await isWorkspaceDirectory(initialWorkspace)
  ) {
    initialWorkspace = undefined;
    await writeWorkspacePreferences(preferencesPath, undefined).catch(() => undefined);
  }
  updateController = createDesktopUpdateController();
  runtime = new KimiDesktopRuntime({
    workspaceRoot: initialWorkspace,
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
      getUpdateState: () => requireUpdateController().state(),
      checkForUpdates: () => requireUpdateController().check(),
      downloadUpdate: () => requireUpdateController().download(),
      installUpdate: requestUpdateInstall,
      openUpdateRelease: async () => {
        if (process.env['KIMI_DESKTOP_E2E'] !== '1') {
          await shell.openExternal(requireUpdateController().releaseUrl());
        }
      },
      setDirtyFiles: (paths) => {
        dirtyPaths = [...new Set(paths)].sort();
      },
      resolveClose: (requestId, action) => {
        if (requestId !== closeRequestId) return;
        const reason = closeRequestReason;
        const runAfter = closeRequestRunAfter;
        closeRequestId = undefined;
        closeRequestReason = 'quit';
        closeRequestRunAfter = false;
        if (action === 'cancel') return;
        dirtyPaths = [];
        if (reason === 'install-update') {
          void shutdownApplication(true, runAfter);
          return;
        }
        allowWindowClose = true;
        mainWindow?.close();
      },
      rememberWorkspace: (path) => writeWorkspacePreferences(preferencesPath, path),
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
  const installUpdate = updateController?.hasDownloadedUpdate() === true;
  if (!allowWindowClose && dirtyPaths.length > 0 && mainWindow?.isDestroyed() === false) {
    event.preventDefault();
    requestRendererClose(installUpdate ? 'install-update' : 'quit', false);
    return;
  }
  event.preventDefault();
  void shutdownApplication(installUpdate, false);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
