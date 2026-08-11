// Scenario: Desktop update discovery and download orchestration.
// Responsibilities: select the package mode, validate GitHub releases, publish state, and gate downloads.
// Wiring: real controller and parsers with only the GitHub request and native updater boundaries stubbed.
// Run: pnpm --filter @moonshot-ai/kimi-code-desktop test

import { describe, expect, it } from 'vitest';

import type { DesktopUpdateProgress, DesktopUpdateSnapshot } from '../shared/desktop-api';
import {
  createGitHubReleaseClient,
  parseDesktopRelease,
  selectDesktopUpdateMode,
  UpdateController,
  type AutomaticUpdateAdapter,
  type DesktopRelease,
} from './update-controller';

const RELEASE_050: DesktopRelease = {
  version: '0.5.0',
  name: 'Kimi Code Desktop 0.5.0',
  notes: 'Automatic updates.',
  url: 'https://github.com/Espboxx/kimi-code-desktop/releases/tag/desktop-v0.5.0',
};

describe('Desktop update mode selection (package capabilities)', () => {
  it('selects automatic mode when an installed Windows package starts', () => {
    expect(selectDesktopUpdateMode({ isPackaged: true, platform: 'win32', environment: {} })).toEqual({
      mode: 'automatic',
      startupCheck: true,
    });
  });

  it('selects manual mode when a Windows portable package starts', () => {
    expect(selectDesktopUpdateMode({
      isPackaged: true,
      platform: 'win32',
      environment: { PORTABLE_EXECUTABLE_FILE: 'Kimi-Code-Desktop.exe' },
    })).toEqual({
      mode: 'manual',
      manualReason: 'windows-portable',
      startupCheck: true,
    });
  });

  it('selects automatic mode when a Linux AppImage starts', () => {
    expect(selectDesktopUpdateMode({
      isPackaged: true,
      platform: 'linux',
      environment: { APPIMAGE: '/opt/Kimi-Code-Desktop.AppImage' },
    })).toEqual({
      mode: 'automatic',
      startupCheck: true,
    });
  });

  it('selects manual mode when a Linux package starts outside AppImage', () => {
    expect(selectDesktopUpdateMode({ isPackaged: true, platform: 'linux', environment: {} })).toEqual({
      mode: 'manual',
      manualReason: 'linux-package',
      startupCheck: true,
    });
  });

  it('selects manual mode for an unsigned macOS package', () => {
    expect(selectDesktopUpdateMode({ isPackaged: true, platform: 'darwin', environment: {} })).toEqual({
      mode: 'manual',
      manualReason: 'macos-unsigned',
      startupCheck: true,
    });
  });

  it('disables startup checks when the application is not packaged', () => {
    expect(selectDesktopUpdateMode({ isPackaged: false, platform: 'darwin', environment: {} })).toEqual({
      mode: 'manual',
      manualReason: 'development',
      startupCheck: false,
    });
  });
});

describe('Desktop GitHub release parsing (stable Desktop channel)', () => {
  it('returns normalized release details when the latest tag is stable', () => {
    expect(parseDesktopRelease({
      tag_name: 'desktop-v0.5.0',
      name: ' Kimi Code Desktop 0.5.0 ',
      body: 'Automatic updates.',
      html_url: RELEASE_050.url,
      draft: false,
      prerelease: false,
    })).toEqual(RELEASE_050);
  });

  it('rejects the response when the latest tag is not a Desktop release', () => {
    expect(() => parseDesktopRelease({
      tag_name: '@moonshot-ai/kimi-code@0.40.0',
      html_url: 'https://github.com/Espboxx/kimi-code-desktop/releases/tag/cli-v0.40.0',
      draft: false,
      prerelease: false,
    })).toThrow('GitHub latest Release 不符合 Desktop 稳定版本格式');
  });

  it('returns a retryable error when GitHub responds with an HTTP failure', async () => {
    const client = createGitHubReleaseClient(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    await expect(client.latest()).rejects.toMatchObject({
      code: 'update.release_request_failed',
      retryable: true,
    });
  });
});

describe('Desktop update controller (observable update lifecycle)', () => {
  it('publishes an available update when GitHub reports a newer stable version', async () => {
    const rig = createRig();

    const state = await rig.controller.check();

    expect(state).toMatchObject({
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      status: 'available',
      checkedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(rig.notifications.at(-1)).toEqual(state);
  });

  it('publishes up-to-date when GitHub reports the running version', async () => {
    const rig = createRig({ currentVersion: '0.5.0' });

    await expect(rig.controller.check()).resolves.toMatchObject({
      currentVersion: '0.5.0',
      latestVersion: '0.5.0',
      status: 'up-to-date',
    });
  });

  it('publishes a retryable error when release discovery fails', async () => {
    const rig = createRig({
      releases: [Promise.reject(Object.assign(new Error('offline'), { code: 'update.offline', retryable: true }))],
    });

    await expect(rig.controller.check()).resolves.toMatchObject({
      status: 'error',
      error: { code: 'update.offline', message: 'offline', retryable: true },
    });
  });

  it('downloads only after an available automatic update is requested', async () => {
    const progress: DesktopUpdateProgress = {
      percent: 48.5,
      transferred: 485,
      total: 1_000,
      bytesPerSecond: 100,
    };
    const rig = createRig({ progress });
    await rig.controller.check();

    const state = await rig.controller.download();

    expect(rig.adapter.prepared).toBe(1);
    expect(rig.adapter.downloaded).toBe(1);
    expect(rig.notifications).toContainEqual(expect.objectContaining({ status: 'downloading', progress }));
    expect(state).toMatchObject({ status: 'downloaded', latestVersion: '0.5.0' });
  });

  it('rejects a download request before update availability is confirmed', async () => {
    const rig = createRig();

    await expect(rig.controller.download()).rejects.toMatchObject({ code: 'update.not_available' });
    expect(rig.adapter.downloaded).toBe(0);
  });

  it('requires another confirmation when updater metadata reports a newer release', async () => {
    const release060: DesktopRelease = {
      version: '0.6.0',
      name: 'Kimi Code Desktop 0.6.0',
      notes: 'A newer release.',
      url: 'https://github.com/Espboxx/kimi-code-desktop/releases/tag/desktop-v0.6.0',
    };
    const rig = createRig({ releases: [RELEASE_050, release060], preparedVersion: '0.6.0' });
    await rig.controller.check();

    await expect(rig.controller.download()).resolves.toMatchObject({
      status: 'available',
      latestVersion: '0.6.0',
    });
    expect(rig.adapter.downloaded).toBe(0);
  });

  it('rejects an in-app download when the package uses manual updates', async () => {
    const rig = createRig({ mode: 'manual' });
    await rig.controller.check();

    await expect(rig.controller.download()).rejects.toMatchObject({ code: 'update.manual_install' });
  });

  it('delegates installation only after the update has downloaded', async () => {
    const rig = createRig();

    expect(() => rig.controller.assertInstallReady()).toThrow('更新尚未下载完成');

    await rig.controller.check();
    await rig.controller.download();

    rig.controller.quitAndInstall(true);

    expect(rig.adapter.installRunAfter).toEqual([true]);
  });
});

function createRig(options: {
  readonly currentVersion?: string;
  readonly mode?: 'automatic' | 'manual';
  readonly releases?: readonly (DesktopRelease | Promise<DesktopRelease>)[];
  readonly preparedVersion?: string;
  readonly progress?: DesktopUpdateProgress;
} = {}) {
  const notifications: DesktopUpdateSnapshot[] = [];
  const releases = [...(options.releases ?? [RELEASE_050])];
  const adapter = new FakeUpdateAdapter(options.preparedVersion ?? '0.5.0', options.progress);
  const controller = new UpdateController({
    currentVersion: options.currentVersion ?? '0.4.1',
    mode: options.mode ?? 'automatic',
    manualReason: options.mode === 'manual' ? 'windows-portable' : undefined,
    startupCheck: true,
    releaseClient: {
      async latest() {
        const release = releases.shift();
        if (release === undefined) throw new Error('No release fixture remains');
        return release;
      },
    },
    automaticAdapter: options.mode === 'manual' ? undefined : adapter,
    notify: (snapshot) => notifications.push(snapshot),
    now: () => new Date('2026-08-12T00:00:00.000Z'),
  });
  return { adapter, controller, notifications };
}

class FakeUpdateAdapter implements AutomaticUpdateAdapter {
  prepared = 0;
  downloaded = 0;
  readonly installRunAfter: boolean[] = [];

  constructor(
    private readonly preparedVersion: string,
    private readonly progress: DesktopUpdateProgress = {
      percent: 100,
      transferred: 1_000,
      total: 1_000,
      bytesPerSecond: 100,
    },
  ) {}

  async prepare(): Promise<string> {
    this.prepared += 1;
    return this.preparedVersion;
  }

  async download(onProgress: (progress: DesktopUpdateProgress) => void): Promise<void> {
    this.downloaded += 1;
    onProgress(this.progress);
  }

  quitAndInstall(runAfter: boolean): void {
    this.installRunAfter.push(runAfter);
  }
}
