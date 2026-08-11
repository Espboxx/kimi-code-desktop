import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const releaseDirectory = resolve(scriptDirectory, '..', 'release');
const target = process.argv[2];

const layouts = {
  'linux-x64': {
    applicationDirectories: [resolve(releaseDirectory, 'linux-unpacked')],
    resourceDirectory: 'resources',
    nativeFiles: [
      'app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
    ],
  },
  'macos-arm64': {
    applicationDirectories: [
      resolve(releaseDirectory, 'mac-arm64', 'Kimi Code Desktop.app', 'Contents'),
      resolve(releaseDirectory, 'mac', 'Kimi Code Desktop.app', 'Contents'),
    ],
    resourceDirectory: 'Resources',
    nativeFiles: [
      'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
      'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    ],
    executableNativeFile: 'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  },
  'windows-x64': {
    applicationDirectories: [resolve(releaseDirectory, 'win-unpacked')],
    resourceDirectory: 'resources',
    nativeFiles: [
      'app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node',
    ],
  },
};

const layout = layouts[target];
if (layout === undefined) {
  throw new Error(`Usage: inspect-packaged-app.mjs <${Object.keys(layouts).join('|')}>`);
}

const applicationDirectory = await firstDirectory(layout.applicationDirectories);
const resources = resolve(applicationDirectory, layout.resourceDirectory);
const requiredFiles = [
  resolve(resources, 'app.asar'),
  resolve(resources, 'LICENSE'),
  resolve(resources, 'NOTICE.md'),
  resolve(resources, 'THIRD_PARTY_NOTICES.md'),
  ...layout.nativeFiles.map((path) => resolve(resources, path)),
];

for (const path of requiredFiles) await assertFile(path);
await assertOneFile([
  resolve(applicationDirectory, 'LICENSE.electron.txt'),
  resolve(resources, 'LICENSE.electron.txt'),
]);
await assertOneFile([
  resolve(applicationDirectory, 'LICENSES.chromium.html'),
  resolve(resources, 'LICENSES.chromium.html'),
]);

if (layout.executableNativeFile !== undefined) {
  const path = resolve(resources, layout.executableNativeFile);
  await access(path, constants.X_OK).catch(() => {
    throw new Error(`Packaged native helper is not executable: ${path}`);
  });
}

console.log(`Packaged ${target} resources verified at ${applicationDirectory}`);

async function firstDirectory(paths) {
  for (const path of paths) {
    const value = await stat(path).catch(() => undefined);
    if (value?.isDirectory() === true) return path;
  }
  throw new Error(`Packaged application directory is missing; checked: ${paths.join(', ')}`);
}

async function assertOneFile(paths) {
  for (const path of paths) {
    const value = await stat(path).catch(() => undefined);
    if (value?.isFile() === true) return;
  }
  throw new Error(`Packaged file is missing; checked: ${paths.join(', ')}`);
}

async function assertFile(path) {
  const value = await stat(path).catch(() => undefined);
  if (value?.isFile() !== true) throw new Error(`Packaged file is missing: ${path}`);
}
