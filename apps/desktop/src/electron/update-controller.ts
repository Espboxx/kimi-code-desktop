import { gt, valid } from 'semver';

import type {
  DesktopUpdateManualReason,
  DesktopUpdateProgress,
  DesktopUpdateSnapshot,
  KimiDesktopError,
} from '../shared/desktop-api';

export const DESKTOP_RELEASES_URL = 'https://github.com/Espboxx/kimi-code-desktop/releases';
export const DESKTOP_LATEST_RELEASE_API = 'https://api.github.com/repos/Espboxx/kimi-code-desktop/releases/latest';

const RELEASE_NOTES_LIMIT = 32 * 1024;
const UPDATE_REQUEST_TIMEOUT_MS = 15_000;

export interface DesktopRelease {
  readonly version: string;
  readonly name: string;
  readonly notes: string;
  readonly url: string;
}

export interface DesktopReleaseClient {
  latest(): Promise<DesktopRelease>;
}

export interface AutomaticUpdateAdapter {
  prepare(): Promise<string | undefined>;
  download(onProgress: (progress: DesktopUpdateProgress) => void): Promise<void>;
  quitAndInstall(runAfter: boolean): void;
}

interface UpdateModeSelection {
  readonly mode: DesktopUpdateSnapshot['mode'];
  readonly manualReason?: DesktopUpdateManualReason;
  readonly startupCheck: boolean;
}

interface UpdateControllerOptions extends UpdateModeSelection {
  readonly currentVersion: string;
  readonly releaseClient: DesktopReleaseClient;
  readonly automaticAdapter?: AutomaticUpdateAdapter;
  readonly notify: (snapshot: DesktopUpdateSnapshot) => void;
  readonly now?: () => Date;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

type FetchRelease = (
  input: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<FetchResponse>;

export function selectDesktopUpdateMode(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
}): UpdateModeSelection {
  if (!input.isPackaged) {
    return { mode: 'manual', manualReason: 'development', startupCheck: false };
  }
  if (input.platform === 'win32') {
    return input.environment['PORTABLE_EXECUTABLE_FILE'] === undefined
      ? { mode: 'automatic', startupCheck: true }
      : { mode: 'manual', manualReason: 'windows-portable', startupCheck: true };
  }
  if (input.platform === 'linux') {
    return input.environment['APPIMAGE'] === undefined
      ? { mode: 'manual', manualReason: 'linux-package', startupCheck: true }
      : { mode: 'automatic', startupCheck: true };
  }
  if (input.platform === 'darwin') {
    return { mode: 'manual', manualReason: 'macos-unsigned', startupCheck: true };
  }
  return { mode: 'manual', manualReason: 'unsupported-platform', startupCheck: true };
}

export function createGitHubReleaseClient(fetchRelease: FetchRelease): DesktopReleaseClient {
  return {
    async latest() {
      const response = await fetchRelease(DESKTOP_LATEST_RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'kimi-code-desktop',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw updateError(
          'update.release_request_failed',
          `GitHub Release 请求返回 HTTP ${response.status}`,
          true,
        );
      }
      return parseDesktopRelease(await response.json());
    },
  };
}

export function parseDesktopRelease(input: unknown): DesktopRelease {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw updateError('update.invalid_release', 'GitHub Release 响应格式无效');
  }
  const value = input as Record<string, unknown>;
  if (value['draft'] === true || value['prerelease'] === true) {
    throw updateError('update.invalid_release', 'GitHub latest Release 不是稳定公开版本');
  }
  const tag = typeof value['tag_name'] === 'string' ? value['tag_name'] : '';
  const match = /^desktop-v([0-9]+[.][0-9]+[.][0-9]+)$/u.exec(tag);
  const version = match?.[1];
  const url = typeof value['html_url'] === 'string' ? value['html_url'] : '';
  if (version === undefined || valid(version) === null || !url.startsWith(`${DESKTOP_RELEASES_URL}/tag/`)) {
    throw updateError('update.invalid_release', 'GitHub latest Release 不符合 Desktop 稳定版本格式');
  }
  const rawNotes = typeof value['body'] === 'string' ? value['body'] : '';
  return {
    version,
    name: typeof value['name'] === 'string' && value['name'].trim().length > 0
      ? value['name'].trim()
      : `Kimi Code Desktop ${version}`,
    notes: rawNotes.slice(0, RELEASE_NOTES_LIMIT),
    url,
  };
}

export class UpdateController {
  readonly startupCheck: boolean;

  private readonly currentVersion: string;
  private readonly mode: DesktopUpdateSnapshot['mode'];
  private readonly manualReason?: DesktopUpdateManualReason;
  private readonly releaseClient: DesktopReleaseClient;
  private readonly automaticAdapter?: AutomaticUpdateAdapter;
  private readonly notify: (snapshot: DesktopUpdateSnapshot) => void;
  private readonly now: () => Date;
  private snapshotValue: DesktopUpdateSnapshot;
  private release?: DesktopRelease;
  private checkPromise?: Promise<DesktopUpdateSnapshot>;
  private downloadPromise?: Promise<DesktopUpdateSnapshot>;

  constructor(options: UpdateControllerOptions) {
    if (valid(options.currentVersion) === null) {
      throw new Error(`Invalid Desktop version: ${options.currentVersion}`);
    }
    if (options.mode === 'automatic' && options.automaticAdapter === undefined) {
      throw new Error('Automatic Desktop update mode requires an update adapter');
    }
    this.currentVersion = options.currentVersion;
    this.mode = options.mode;
    this.manualReason = options.manualReason;
    this.startupCheck = options.startupCheck;
    this.releaseClient = options.releaseClient;
    this.automaticAdapter = options.automaticAdapter;
    this.notify = options.notify;
    this.now = options.now ?? (() => new Date());
    this.snapshotValue = this.baseSnapshot('idle');
  }

  state(): DesktopUpdateSnapshot {
    return this.snapshotValue;
  }

  check(): Promise<DesktopUpdateSnapshot> {
    if (this.checkPromise !== undefined) return this.checkPromise;
    if (this.downloadPromise !== undefined || this.snapshotValue.status === 'downloaded') {
      return Promise.resolve(this.snapshotValue);
    }
    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = undefined;
    });
    return this.checkPromise;
  }

  download(): Promise<DesktopUpdateSnapshot> {
    if (this.downloadPromise !== undefined) return this.downloadPromise;
    if (this.mode !== 'automatic' || this.automaticAdapter === undefined) {
      return Promise.reject(updateError('update.manual_install', '当前安装格式需要从 GitHub Release 下载更新'));
    }
    if (this.snapshotValue.status !== 'available' || this.release === undefined) {
      return Promise.reject(updateError('update.not_available', '当前没有可下载的更新'));
    }
    this.downloadPromise = this.runDownload(this.release).finally(() => {
      this.downloadPromise = undefined;
    });
    return this.downloadPromise;
  }

  hasDownloadedUpdate(): boolean {
    return this.snapshotValue.status === 'downloaded';
  }

  assertInstallReady(): void {
    if (!this.hasDownloadedUpdate() || this.automaticAdapter === undefined) {
      throw updateError('update.not_downloaded', '更新尚未下载完成');
    }
  }

  quitAndInstall(runAfter: boolean): void {
    this.assertInstallReady();
    this.automaticAdapter!.quitAndInstall(runAfter);
  }

  releaseUrl(): string {
    return this.snapshotValue.releaseUrl ?? DESKTOP_RELEASES_URL;
  }

  private async runCheck(): Promise<DesktopUpdateSnapshot> {
    this.publish({ ...this.baseSnapshot('checking'), checkedAt: this.snapshotValue.checkedAt });
    try {
      const release = await this.releaseClient.latest();
      this.release = release;
      const checkedAt = this.now().toISOString();
      this.publish(gt(release.version, this.currentVersion)
        ? this.releaseSnapshot('available', release, checkedAt)
        : this.releaseSnapshot('up-to-date', release, checkedAt));
    } catch (error) {
      this.publish({
        ...this.baseSnapshot('error'),
        checkedAt: this.now().toISOString(),
        error: toUpdateError(error, 'update.check_failed'),
      });
    }
    return this.snapshotValue;
  }

  private async runDownload(expectedRelease: DesktopRelease): Promise<DesktopUpdateSnapshot> {
    this.publish({
      ...this.releaseSnapshot('downloading', expectedRelease, this.snapshotValue.checkedAt),
      progress: emptyProgress(),
    });
    try {
      const preparedVersion = await this.automaticAdapter!.prepare();
      if (preparedVersion !== expectedRelease.version) {
        return await this.refreshAfterMetadataChange(expectedRelease.version, preparedVersion);
      }
      await this.automaticAdapter!.download((progress) => {
        this.publish({
          ...this.releaseSnapshot('downloading', expectedRelease, this.snapshotValue.checkedAt),
          progress: normalizeProgress(progress),
        });
      });
      this.publish(this.releaseSnapshot('downloaded', expectedRelease, this.snapshotValue.checkedAt));
    } catch (error) {
      this.publish({
        ...this.releaseSnapshot('error', expectedRelease, this.snapshotValue.checkedAt),
        error: toUpdateError(error, 'update.download_failed'),
      });
    }
    return this.snapshotValue;
  }

  private async refreshAfterMetadataChange(
    expectedVersion: string,
    preparedVersion: string | undefined,
  ): Promise<DesktopUpdateSnapshot> {
    const release = await this.releaseClient.latest();
    this.release = release;
    const checkedAt = this.now().toISOString();
    if (preparedVersion !== undefined && release.version === preparedVersion && gt(release.version, this.currentVersion)) {
      this.publish(this.releaseSnapshot('available', release, checkedAt));
      return this.snapshotValue;
    }
    throw updateError(
      'update.metadata_mismatch',
      `Release ${expectedVersion} 与更新元数据 ${preparedVersion ?? 'missing'} 不一致`,
      true,
    );
  }

  private baseSnapshot(status: DesktopUpdateSnapshot['status']): DesktopUpdateSnapshot {
    return {
      currentVersion: this.currentVersion,
      mode: this.mode,
      manualReason: this.manualReason,
      status,
    };
  }

  private releaseSnapshot(
    status: DesktopUpdateSnapshot['status'],
    release: DesktopRelease,
    checkedAt: string | undefined,
  ): DesktopUpdateSnapshot {
    return {
      ...this.baseSnapshot(status),
      latestVersion: release.version,
      releaseName: release.name,
      releaseNotes: release.notes,
      releaseUrl: release.url,
      checkedAt,
    };
  }

  private publish(snapshot: DesktopUpdateSnapshot): void {
    this.snapshotValue = snapshot;
    this.notify(snapshot);
  }
}

function emptyProgress(): DesktopUpdateProgress {
  return { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
}

function normalizeProgress(progress: DesktopUpdateProgress): DesktopUpdateProgress {
  return {
    percent: clamp(progress.percent, 0, 100),
    transferred: Math.max(0, progress.transferred),
    total: Math.max(0, progress.total),
    bytesPerSecond: Math.max(0, progress.bytesPerSecond),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function updateError(code: string, message: string, retryable = false): Error & KimiDesktopError {
  return Object.assign(new Error(message), { code, retryable });
}

function toUpdateError(error: unknown, fallbackCode: string): KimiDesktopError {
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value['code'] === 'string' && typeof value['message'] === 'string') {
      return {
        code: value['code'],
        message: value['message'],
        retryable: typeof value['retryable'] === 'boolean' ? value['retryable'] : undefined,
      };
    }
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
