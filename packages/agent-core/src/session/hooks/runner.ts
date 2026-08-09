import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

import { z } from 'zod';

import type { HookResult } from './types';

export interface RunHookOptions {
  readonly timeout: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export function buildHookSpawnOptions(options: {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}): SpawnOptionsWithoutStdio {
  return {
    shell: true,
    cwd: options.cwd,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    // Hide the console Windows would otherwise allocate for the shell child.
    // Without `windowsHide:true`, each hook flashes a visible console window —
    // the same regression the Bash tool path already guards against in KAOS
    // (see `buildLocalSpawnOptions`). Unconditional: it is a no-op on POSIX.
    windowsHide: true,
    env: options.env ? { ...process.env, ...options.env } : undefined,
  };
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const KILL_GRACE_MS = 100;
const OptionalStringSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    return undefined;
  },
  z.string().optional(),
);
const HookSpecificOutputSchema = z.preprocess(
  (value) => (isRecord(value) ? value : undefined),
  z
    .looseObject({
      message: OptionalStringSchema,
      permissionDecision: z.unknown().optional(),
      permissionDecisionReason: OptionalStringSchema,
    })
    .optional(),
);
const HookJsonOutputSchema = z.looseObject({
  message: OptionalStringSchema,
  hookSpecificOutput: HookSpecificOutputSchema,
});

export async function runHook(
  command: string,
  input: Record<string, unknown>,
  options: RunHookOptions,
): Promise<HookResult> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, buildHookSpawnOptions({ cwd: options.cwd, env: options.env }));
  } catch (error) {
    return allowResult({ stderr: errorMessage(error) });
  }

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminating = false;
    const timeoutMs = timeoutSeconds(options.timeout) * 1000;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const terminate = (result: HookResult): void => {
      if (terminating || settled) return;
      terminating = true;
      void killProcess(child).then(() => settle(result));
    };

    const timeout = setTimeout(() => {
      terminate(allowResult({ stdout, stderr, timedOut: true }));
    }, timeoutMs);

    const onAbort = (): void => {
      terminate(allowResult({ stdout, stderr }));
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      settle(allowResult({ stdout, stderr: stderr + errorMessage(error) }));
    });
    child.on('close', (code) => {
      if (terminating) return;
      settle(resultFromExitCode(code ?? 0, stdout, stderr));
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function timeoutSeconds(timeout: number): number {
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS;
}

function resultFromExitCode(exitCode: number, stdout: string, stderr: string): HookResult {
  if (exitCode === 2) {
    const message = stderr.trim();
    return {
      action: 'block',
      message,
      reason: message,
      stdout,
      stderr,
      exitCode,
    };
  }

  const structured = exitCode === 0 ? structuredOutput(stdout) : undefined;
  if (structured?.action === 'block') {
    return {
      action: 'block',
      message: structured.message ?? structured.reason,
      reason: structured.reason,
      stdout,
      stderr,
      exitCode,
      structuredOutput: structured.structuredOutput,
    };
  }

  return allowResult({
    message: structured?.message,
    stdout,
    stderr,
    exitCode,
    structuredOutput: structured?.structuredOutput,
  });
}

function structuredOutput(
  stdout: string,
): { action?: 'block'; reason?: string; message?: string; structuredOutput: true } | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;

  try {
    const parsed = JSON.parse(text) as unknown;
    const output = HookJsonOutputSchema.safeParse(parsed);
    if (!output.success) return undefined;

    const { message, hookSpecificOutput } = output.data;
    const result = {
      message: message ?? hookSpecificOutput?.message,
      structuredOutput: true as const,
    };
    if (hookSpecificOutput?.permissionDecision !== 'deny') {
      return result;
    }
    return {
      action: 'block',
      message: result.message,
      reason: hookSpecificOutput.permissionDecisionReason,
      structuredOutput: true,
    };
  } catch {
    return undefined;
  }
}

function allowResult(input: {
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly structuredOutput?: boolean;
}): HookResult {
  return {
    action: 'allow',
    message: input.message,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    structuredOutput: input.structuredOutput,
  };
}

function killProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32') {
    // A non-forced taskkill can terminate the shell before its descendants,
    // leaving the actual hook orphaned. Windows has no graceful signal for
    // console process trees, so terminate the complete tree in one operation.
    return killProcessTreeWindows(child, true);
  }
  tryKillProcess(child, 'SIGTERM');
  const killTimer = setTimeout(() => {
    tryKillProcess(child, 'SIGKILL');
  }, KILL_GRACE_MS);
  killTimer.unref();
  return Promise.resolve();
}

function tryKillProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function killProcessTreeWindows(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
  if (child.pid === undefined) return Promise.resolve();
  const args = force
    ? ['/T', '/F', '/PID', String(child.pid)]
    : ['/T', '/PID', String(child.pid)];
  return new Promise((resolve) => {
    try {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      const done = (): void => resolve();
      killer.once('error', () => {
        try {
          child.kill('SIGTERM');
        } catch {}
        done();
      });
      killer.once('close', done);
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {}
      resolve();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
