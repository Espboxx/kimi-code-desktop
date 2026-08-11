import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const defaultReleaseDirectory = resolve(desktopDirectory, 'release');
const manifest = JSON.parse(await readFile(resolve(desktopDirectory, 'package.json'), 'utf8'));
const version = manifest.version;

if (typeof version !== 'string' || version.length === 0) {
  throw new Error('apps/desktop/package.json has no version.');
}

const windowsSetup = `Kimi-Code-Desktop-${version}-x64-setup.exe`;
const windowsPortable = `Kimi-Code-Desktop-${version}-x64-portable.exe`;
const linuxAppImage = `Kimi-Code-Desktop-${version}-x64.AppImage`;
const linuxDeb = `Kimi-Code-Desktop-${version}-x64.deb`;
const macDmg = `Kimi-Code-Desktop-${version}-arm64.dmg`;

const targets = {
  'linux-x64': {
    distributables: [linuxAppImage, linuxDeb],
    metadata: ['latest-linux.yml'],
  },
  'macos-arm64': {
    distributables: [macDmg],
    metadata: [],
  },
  'windows-x64': {
    distributables: [windowsSetup, windowsPortable],
    metadata: [`${windowsSetup}.blockmap`, 'latest.yml'],
  },
};

const command = process.argv[2];
const argument = process.argv[3];
const releaseDirectory = resolve(process.argv[4] ?? (command === 'verify' ? argument ?? '' : defaultReleaseDirectory));

switch (command) {
  case 'list':
    for (const name of allReleaseAssetNames()) console.log(name);
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

function allDistributableNames() {
  return Object.values(targets).flatMap((target) => target.distributables);
}

function allReleaseAssetNames() {
  return Object.values(targets)
    .flatMap((target) => [
      ...target.distributables.flatMap((name) => [name, `${name}.sha256`]),
      ...target.metadata,
    ])
    .sort();
}

async function prepare(targetName, directory) {
  const target = targets[targetName];
  if (target === undefined) throw new Error(`Unknown release target: ${String(targetName)}`);

  for (const name of [...target.distributables, ...target.metadata]) {
    await assertFile(resolve(directory, name));
  }
  for (const name of target.distributables) {
    const artifactPath = resolve(directory, name);
    const hash = await digest(artifactPath, 'sha256', 'hex');
    const checksumPath = `${artifactPath}.sha256`;
    await writeFile(checksumPath, `${hash}  ${name}\n`, 'ascii');
    console.log(`Prepared ${name} (${hash})`);
  }
  await verifyTargetMetadata(targetName, directory);
}

async function verify(directory) {
  const expectedNames = allReleaseAssetNames();
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

  for (const name of allDistributableNames()) {
    await verifyChecksum(directory, name);
  }
  await verifyTargetMetadata('windows-x64', directory);
  await verifyTargetMetadata('linux-x64', directory);
}

async function verifyChecksum(directory, name) {
  const artifactPath = resolve(directory, name);
  const checksumPath = `${artifactPath}.sha256`;
  const declared = (await readFile(checksumPath, 'ascii')).trim().split(/\s+/u);
  if (declared.length !== 2 || declared[1] !== name || !/^[a-f0-9]{64}$/u.test(declared[0])) {
    throw new Error(`Invalid checksum file: ${checksumPath}`);
  }
  const actual = await digest(artifactPath, 'sha256', 'hex');
  if (declared[0] !== actual) {
    throw new Error(`SHA256 mismatch for ${name}: expected ${declared[0]}, received ${actual}`);
  }
  console.log(`Verified ${name} (${actual})`);
}

async function verifyTargetMetadata(targetName, directory) {
  if (targetName === 'windows-x64') {
    const blockmapName = `${windowsSetup}.blockmap`;
    const blockmapSize = (await stat(resolve(directory, blockmapName))).size;
    await verifyUpdateMetadata(resolve(directory, 'latest.yml'), {
      primary: windowsSetup,
      files: new Map([[windowsSetup, { blockmapSize }]]),
      directory,
    });
    return;
  }
  if (targetName === 'linux-x64') {
    await verifyUpdateMetadata(resolve(directory, 'latest-linux.yml'), {
      files: new Map([[linuxAppImage, {}], [linuxDeb, {}]]),
      directory,
    });
  }
}

async function verifyUpdateMetadata(path, options) {
  const parsed = parseYaml(await readFile(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Update metadata is not an object: ${path}`);
  }
  if (parsed.version !== version) {
    throw new Error(`Update metadata ${path} has version ${String(parsed.version)} instead of ${version}`);
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error(`Update metadata has no files array: ${path}`);
  }

  const entries = new Map();
  for (const rawEntry of parsed.files) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`Update metadata has an invalid file entry: ${path}`);
    }
    const name = rawEntry.url;
    if (typeof name !== 'string' || !options.files.has(name) || entries.has(name)) {
      throw new Error(`Update metadata references an unexpected or duplicate file: ${String(name)}`);
    }
    entries.set(name, rawEntry);
  }

  const missing = [...options.files.keys()].filter((name) => !entries.has(name));
  if (missing.length > 0) {
    throw new Error(`Update metadata ${path} is missing files: ${missing.join(', ')}`);
  }

  for (const [name, expectations] of options.files) {
    const entry = entries.get(name);
    const artifactPath = resolve(options.directory, name);
    const expectedSha512 = await digest(artifactPath, 'sha512', 'base64');
    const expectedSize = (await stat(artifactPath)).size;
    if (entry.sha512 !== expectedSha512) {
      throw new Error(`SHA512 mismatch in ${path} for ${name}`);
    }
    if (entry.size !== undefined && entry.size !== expectedSize) {
      throw new Error(`Size mismatch in ${path} for ${name}: expected ${expectedSize}, received ${entry.size}`);
    }
    if (
      expectations.blockmapSize !== undefined &&
      entry.blockMapSize !== undefined &&
      entry.blockMapSize !== expectations.blockmapSize
    ) {
      throw new Error(
        `Blockmap size mismatch in ${path} for ${name}: expected ${expectations.blockmapSize}, received ${String(entry.blockMapSize)}`,
      );
    }
  }

  const primary = typeof parsed.path === 'string' ? entries.get(parsed.path) : undefined;
  if (primary === undefined || parsed.sha512 !== primary.sha512) {
    throw new Error(`Update metadata ${path} has an invalid primary file`);
  }
  if (options.primary !== undefined && parsed.path !== options.primary) {
    throw new Error(`Update metadata ${path} does not select ${options.primary} as its primary file`);
  }
  if (typeof parsed.releaseDate !== 'string' || !Number.isFinite(Date.parse(parsed.releaseDate))) {
    throw new Error(`Update metadata has an invalid releaseDate: ${path}`);
  }
  console.log(`Verified update metadata ${path}`);
}

async function assertFile(path) {
  const value = await stat(path).catch(() => undefined);
  if (value?.isFile() !== true) throw new Error(`Release artifact is missing: ${path}`);
}

async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  hash.update(await readFile(path));
  return hash.digest(encoding);
}
