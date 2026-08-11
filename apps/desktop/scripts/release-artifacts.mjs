import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const defaultReleaseDirectory = resolve(desktopDirectory, 'release');
const manifest = JSON.parse(await readFile(resolve(desktopDirectory, 'package.json'), 'utf8'));
const version = manifest.version;

if (typeof version !== 'string' || version.length === 0) {
  throw new Error('apps/desktop/package.json has no version.');
}

const targets = {
  'linux-x64': [
    `Kimi-Code-Desktop-${version}-x64.AppImage`,
    `Kimi-Code-Desktop-${version}-x64.deb`,
  ],
  'macos-arm64': [`Kimi-Code-Desktop-${version}-arm64.dmg`],
  'windows-x64': [`Kimi-Code-Desktop-${version}-x64-portable.exe`],
};

const command = process.argv[2];
const argument = process.argv[3];
const releaseDirectory = resolve(process.argv[4] ?? (command === 'verify' ? argument ?? '' : defaultReleaseDirectory));

switch (command) {
  case 'list':
    for (const name of allArtifactNames()) console.log(name);
    break;
  case 'prepare':
    await prepare(argument, releaseDirectory);
    break;
  case 'verify':
    await verify(resolve(argument ?? defaultReleaseDirectory));
    break;
  default:
    throw new Error('Usage: release-artifacts.mjs list | prepare <target> [directory] | verify [directory]');
}

function allArtifactNames() {
  return Object.values(targets).flat();
}

async function prepare(target, directory) {
  const names = targets[target];
  if (names === undefined) throw new Error(`Unknown release target: ${String(target)}`);

  for (const name of names) {
    const artifactPath = resolve(directory, name);
    await assertFile(artifactPath);
    const hash = await sha256(artifactPath);
    const checksumPath = `${artifactPath}.sha256`;
    await writeFile(checksumPath, `${hash}  ${name}\n`, 'ascii');
    console.log(`Prepared ${name} (${hash})`);
  }
}

async function verify(directory) {
  const expectedNames = allArtifactNames().flatMap((name) => [name, `${name}.sha256`]).sort();
  const actualNames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      missing.length === 0 ? undefined : `Missing release assets: ${missing.join(', ')}`,
      unexpected.length === 0 ? undefined : `Unexpected release assets: ${unexpected.join(', ')}`,
    ].filter(Boolean).join('\n'));
  }

  for (const name of allArtifactNames()) {
    const artifactPath = resolve(directory, name);
    const checksumPath = `${artifactPath}.sha256`;
    const declared = (await readFile(checksumPath, 'ascii')).trim().split(/\s+/u);
    if (declared.length !== 2 || declared[1] !== name) {
      throw new Error(`Invalid checksum file: ${checksumPath}`);
    }
    const actual = await sha256(artifactPath);
    if (declared[0].toLowerCase() !== actual) {
      throw new Error(`SHA256 mismatch for ${name}: expected ${declared[0]}, received ${actual}`);
    }
    console.log(`Verified ${name} (${actual})`);
  }
}

async function assertFile(path) {
  const value = await stat(path).catch(() => undefined);
  if (value?.isFile() !== true) throw new Error(`Release artifact is missing: ${path}`);
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}
