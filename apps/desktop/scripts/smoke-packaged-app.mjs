import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const releaseDirectory = resolve(desktopDirectory, 'release');
const target = process.argv[2];
const timeoutMs = 30_000;

const executables = {
  'linux-x64': [resolve(releaseDirectory, 'linux-unpacked', 'kimi-code-desktop')],
  'macos-arm64': [
    resolve(releaseDirectory, 'mac-arm64', 'Kimi Code Desktop.app', 'Contents', 'MacOS', 'Kimi Code Desktop'),
    resolve(releaseDirectory, 'mac', 'Kimi Code Desktop.app', 'Contents', 'MacOS', 'Kimi Code Desktop'),
  ],
  'windows-x64': [resolve(releaseDirectory, 'win-unpacked', 'Kimi Code Desktop.exe')],
};

const candidates = executables[target];
if (candidates === undefined) {
  throw new Error(`Usage: smoke-packaged-app.mjs <${Object.keys(executables).join('|')}>`);
}

const executable = await firstFile(candidates);
const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'kimi-desktop-packaged-smoke-'));
const home = resolve(fixtureRoot, 'home');
const profile = resolve(fixtureRoot, 'profile');
const workspace = resolve(fixtureRoot, 'workspace');
await Promise.all([home, profile, workspace].map((path) => mkdir(path)));

try {
  await run(executable, [`--user-data-dir=${profile}`], {
    ...process.env,
    KIMI_CODE_HOME: home,
    KIMI_DESKTOP_SMOKE: '1',
    KIMI_DESKTOP_WORKSPACE: workspace,
  });
  console.log(`Packaged ${target} application smoke passed: ${executable}`);
} finally {
  await rm(fixtureRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
}

async function firstFile(paths) {
  for (const path of paths) {
    const value = await stat(path).catch(() => undefined);
    if (value?.isFile() === true) return path;
  }
  throw new Error(`Packaged application executable is missing; checked: ${paths.join(', ')}`);
}

function run(file, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: desktopDirectory,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged application smoke timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Packaged application exited with code ${String(code)} and signal ${String(signal)}`));
    });
  });
}
