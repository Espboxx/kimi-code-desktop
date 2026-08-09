import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  runStatusLineCommand,
  STATUS_LINE_MAX_CAPTURE_BYTES,
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import type { AppState } from '#/tui/types';

const baseState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

const payload: StatusLinePayload = {
  model: 'kimi-k2',
  cwd: '/tmp/project',
  gitBranch: 'main',
  permissionMode: 'manual',
  planMode: false,
  contextUsage: 12,
  contextTokens: 1024,
  maxContextTokens: 8192,
  sessionId: 'ses-1',
  version: '1.2.3',
};

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const commandDirs: string[] = [];

afterEach(() => {
  for (const dir of commandDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function nodeCommand(source: string, ...args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-status-line-'));
  commandDirs.push(dir);
  const script = join(dir, 'command.cjs');
  writeFileSync(script, source);
  const quote = (value: string): string => `"${value.replaceAll('\\', '/')}"`;
  return ['node', quote(script), ...args.map(quote)].join(' ');
}

function shellCommand(posix: string, win32: string): string {
  return process.platform === 'win32' ? win32 : posix;
}

describe('FooterComponent status_line items', () => {
  it('renders only the chosen slots in the given order', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['cwd', 'model'], command: null },
    };
    const footer = new FooterComponent(state);

    const line1 = plain(footer.render(120)[0]!);
    const cwdAt = line1.indexOf('/tmp/project');
    const modelAt = line1.indexOf('kimi-k2');
    expect(cwdAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeGreaterThan(cwdAt);
    expect(line1).not.toContain('goal');
  });

  it('keeps the default layout when statusLine is unset', () => {
    const footer = new FooterComponent({ ...baseState });

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('kimi-k2');
    expect(line1).toContain('/tmp/project');
  });

  it('drops the rotating tips when tips is not in items', () => {
    const withTips = plain(new FooterComponent(baseState).render(200)[0]!);
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['model', 'cwd'], command: null },
    };
    const withoutTips = plain(new FooterComponent(state).render(200)[0]!);

    expect(withoutTips.length).toBeLessThan(withTips.length);
    expect(withoutTips.trimEnd()).toMatch(/kimi-k2 {2}\/tmp\/project$/);
  });

  it('honors the configured position of the tips slot', () => {
    // The tip content itself rotates; locate it via a tips-only render.
    const tipsOnly = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips'], command: null },
      }).render(200)[0]!,
    ).trim();

    const tipsFirst = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips', 'model'], command: null },
      }).render(200)[0]!,
    );
    const tipsLast = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['model', 'tips'], command: null },
      }).render(200)[0]!,
    );

    expect(tipsOnly.length).toBeGreaterThan(0);
    expect(tipsFirst.indexOf(tipsOnly)).toBeLessThan(tipsFirst.indexOf('kimi-k2'));
    expect(tipsLast.indexOf('kimi-k2')).toBeLessThan(tipsLast.indexOf(tipsOnly));
  });

  it('renders nothing on line 1 for an empty items list', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: [], command: null },
    };
    const footer = new FooterComponent(state);

    expect(plain(footer.render(120)[0]!).trim()).toBe('');
  });
});

describe('runStatusLineCommand', () => {
  it('passes the payload as JSON on stdin and returns the first stdout line', async () => {
    const line = await runStatusLineCommand(shellCommand('cat', 'more'), payload);

    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!);
    expect(parsed.model).toBe('kimi-k2');
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.cwd).toBe('/tmp/project');
  });

  it('returns null on a nonzero exit', async () => {
    expect(await runStatusLineCommand(shellCommand('exit 3', 'exit /b 3'), payload)).toBeNull();
  });

  it('returns null on empty output', async () => {
    expect(await runStatusLineCommand(shellCommand('true', 'ver >nul'), payload)).toBeNull();
  });

  it('returns null when the command overruns the timeout', async () => {
    expect(
      await runStatusLineCommand(nodeCommand('setTimeout(() => {}, 2_000);'), payload, 100),
    ).toBeNull();
  });

  it('trims the line and ignores later lines', async () => {
    const line = await runStatusLineCommand(
      shellCommand('printf "first\\nsecond\\n"', 'echo first&echo second'),
      payload,
    );

    expect(line).toBe('first');
  });

  it('caps the captured output instead of accumulating an unending stream', async () => {
    // 200 KB on a single line, then exit: only the capped prefix is kept.
    const line = await runStatusLineCommand(
      nodeCommand("process.stdout.write('a'.repeat(200_000));"),
      payload,
      2_000,
    );

    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(STATUS_LINE_MAX_CAPTURE_BYTES);
  });
});

describe('FooterComponent status_line command', () => {
  it('swaps line 1 to the command output once it lands', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: {
        items: null,
        command: shellCommand('printf "my-custom-status"', 'echo my-custom-status'),
      },
    };
    const footer = new FooterComponent(state);

    // Before the first run completes the built-in layout is still shown.
    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('my-custom-status');
  });

  it('keeps the built-in layout when the command fails', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: shellCommand('exit 1', 'exit /b 1') },
    };
    const footer = new FooterComponent(state);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');
  });
});

describe('StatusLineCommandRunner', () => {
  it('caches the last good line and coalesces refreshes in the same interval', async () => {
    const execute = vi.fn().mockResolvedValue('x');
    const runner = new StatusLineCommandRunner('command', () => {}, execute);

    runner.maybeRefresh(payload);
    runner.maybeRefresh(payload);
    await vi.waitFor(() => expect(runner.current()).toBe('x'));

    expect(runner.current()).toBe('x');
    expect(execute).toHaveBeenCalledTimes(1);
    runner.dispose();
  });

  it('runs a deferred refresh after the throttle interval instead of dropping it', async () => {
    vi.useFakeTimers();
    let runCount = 0;
    const execute = vi.fn(async () => `run-${runCount++}`);
    const runner = new StatusLineCommandRunner(
      'command',
      () => {},
      execute,
    );
    try {
      runner.maybeRefresh(payload);
      await Promise.resolve();
      runner.maybeRefresh(payload); // throttled: must defer, not drop
      expect(execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(runner.current()).toBe('run-1');
    } finally {
      runner.dispose();
      vi.useRealTimers();
    }
  });

  it('recreates the runner when the command changes', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: shellCommand('printf "aaa"', 'echo aaa') },
    };
    const footer = new FooterComponent(state);
    footer.render(120); // kicks the first run
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(plain(footer.render(120)[0]!)).toContain('aaa');

    footer.setState({
      ...state,
      statusLine: { items: null, command: shellCommand('printf "bbb"', 'echo bbb') },
    });
    footer.render(120); // kicks the replacement run
    await new Promise((resolve) => setTimeout(resolve, 450));

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('bbb');
    expect(line1).not.toContain('aaa');
  });
});
