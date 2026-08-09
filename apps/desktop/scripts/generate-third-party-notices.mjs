#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import parseSpdxExpression from 'spdx-expression-parse';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const repoRoot = resolve(desktopDir, '..', '..');
const outputPath = join(desktopDir, 'THIRD_PARTY_NOTICES.md');
const licenseOverridesDir = join(desktopDir, 'third-party-license-overrides');
const licenseOverridesPath = join(licenseOverridesDir, 'overrides.json');
const desktopPackageName = '@moonshot-ai/kimi-code-desktop';

// The SDK publishes a bundle, so the workspace packages imported by its source
// are intentionally devDependencies there. Desktop bundles that source directly;
// treating those workspace-only devDependencies as runtime roots keeps the
// generated inventory aligned with the code that actually ships.
const sourceBundledDevDependencyOwners = new Set([
  '@moonshot-ai/kimi-code-sdk',
]);

// Electron is declared as a devDependency because it is the build host, but
// its binary is part of every packaged application. Include the Electron
// package itself without pulling in downloader-only installation dependencies.
const packagedRuntimeDevDependencies = new Set([
  'electron',
]);

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: generate-third-party-notices.mjs --write|--check');
}

const workspacePackages = await loadWorkspacePackages();
const workspaceClosure = resolveWorkspaceClosure(workspacePackages);
const licenseOverrides = await loadLicenseOverrides();
const licenseReport = runPnpmJson([
  'licenses',
  'list',
  '--prod',
  '--json',
  ...[...workspaceClosure.keys()].sort(compareText).flatMap((name) => ['--filter', name]),
]);
const packages = deduplicateLicensedPackages([
  ...await collectLicensedPackages(licenseReport, licenseOverrides),
  ...await collectPackagedRuntimeDevDependencies(workspacePackages),
]);
const fingerprint = dependencyFingerprint(workspaceClosure);
const generated = renderNotices(packages, workspaceClosure.size, fingerprint);

assertPortableOutput(generated);

if (mode === '--write') {
  await writeFile(outputPath, generated, 'utf8');
  console.log(`Wrote ${relative(repoRoot, outputPath)} with ${packages.length} packages.`);
} else {
  const current = await readFile(outputPath, 'utf8').catch(() => undefined);
  if (current !== generated) {
    const currentHash = current === undefined ? 'missing' : sha256(current);
    throw new Error([
      `${relative(repoRoot, outputPath)} is stale (${currentHash} != ${sha256(generated)}).`,
      'Run: pnpm --filter @moonshot-ai/kimi-code-desktop licenses:generate',
    ].join('\n'));
  }
  console.log(`${relative(repoRoot, outputPath)} is up to date (${packages.length} packages).`);
}

async function loadWorkspacePackages() {
  const listed = runPnpmJson(['list', '--recursive', '--depth', '-1', '--json']);
  if (!Array.isArray(listed)) throw new Error('pnpm returned an invalid workspace package list.');

  const packagesByName = new Map();
  for (const item of listed) {
    if (typeof item?.name !== 'string' || typeof item?.path !== 'string') continue;
    const packageDir = resolve(item.path);
    assertInsideRepo(packageDir);
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    if (manifest.name !== item.name) {
      throw new Error(`Workspace package name mismatch for ${item.name}.`);
    }
    if (packagesByName.has(item.name)) throw new Error(`Duplicate workspace package: ${item.name}`);
    packagesByName.set(item.name, { manifest, packageDir });
  }
  if (!packagesByName.has(desktopPackageName)) {
    throw new Error(`Workspace package not found: ${desktopPackageName}`);
  }
  return packagesByName;
}

function resolveWorkspaceClosure(workspacePackages) {
  const closure = new Map();
  const pending = [desktopPackageName];
  while (pending.length > 0) {
    const name = pending.shift();
    if (closure.has(name)) continue;
    const workspacePackage = workspacePackages.get(name);
    if (workspacePackage === undefined) throw new Error(`Workspace dependency not found: ${name}`);
    closure.set(name, workspacePackage);

    const manifest = workspacePackage.manifest;
    const dependencySections = [manifest.dependencies, manifest.optionalDependencies];
    if (sourceBundledDevDependencyOwners.has(name)) dependencySections.push(manifest.devDependencies);
    for (const dependencies of dependencySections) {
      for (const [dependencyName, specifier] of Object.entries(dependencies ?? {})) {
        if (workspacePackages.has(dependencyName)) {
          pending.push(dependencyName);
        } else if (typeof specifier === 'string' && specifier.startsWith('workspace:')) {
          throw new Error(`${name} references missing workspace dependency ${dependencyName}.`);
        }
      }
    }
  }
  return closure;
}

async function collectLicensedPackages(report, licenseOverrides) {
  if (report === null || Array.isArray(report) || typeof report !== 'object') {
    throw new Error('pnpm returned an invalid license report.');
  }

  const packagesByKey = new Map();
  for (const [reportedLicense, items] of Object.entries(report)) {
    validateSpdx(reportedLicense);
    if (!Array.isArray(items)) throw new Error(`Invalid package list for ${reportedLicense}.`);

    for (const item of items) {
      if (typeof item?.name !== 'string' || !Array.isArray(item.versions) || !Array.isArray(item.paths)) {
        throw new Error(`Invalid package metadata under ${reportedLicense}.`);
      }
      if (item.versions.length !== item.paths.length) {
        throw new Error(`Version/path mismatch for ${item.name}.`);
      }
      const spdx = item.license ?? reportedLicense;
      if (spdx !== reportedLicense) {
        throw new Error(`Conflicting license metadata for ${item.name}: ${reportedLicense} != ${spdx}.`);
      }
      validateSpdx(spdx);
      if (typeof item.homepage !== 'string' || item.homepage.trim() === '') {
        throw new Error(`Missing homepage for ${item.name}.`);
      }

      for (let index = 0; index < item.versions.length; index += 1) {
        const version = item.versions[index];
        const packagePath = item.paths[index];
        if (typeof version !== 'string' || version === '' || typeof packagePath !== 'string') {
          throw new Error(`Invalid version/path metadata for ${item.name}.`);
        }
        const { licenseTexts, licenseTextSource } = await readLicenseTexts(
          packagePath,
          item.name,
          version,
          licenseOverrides,
        );
        const record = {
          name: item.name,
          version,
          spdx,
          homepage: item.homepage.trim(),
          licenseTexts,
          licenseTextSource,
        };
        const key = `${record.name}\0${record.version}`;
        const previous = packagesByKey.get(key);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(record)) {
          throw new Error(`Conflicting installed copies of ${record.name}@${record.version}.`);
        }
        packagesByKey.set(key, record);
      }
    }
  }

  const unusedOverrides = [...licenseOverrides.entries()]
    .filter(([, override]) => override.used !== true)
    .map(([key]) => key)
    .sort(compareText);
  if (unusedOverrides.length > 0) {
    throw new Error(`Unused license overrides: ${unusedOverrides.join(', ')}`);
  }

  return [...packagesByKey.values()].sort((left, right) => (
    compareText(left.name, right.name) || compareText(left.version, right.version)
  ));
}

async function readLicenseTexts(packagePath, name, version, licenseOverrides) {
  const packageDir = resolve(packagePath);
  const installedTexts = await readLicenseFiles(packageDir, name, version);
  if (installedTexts.length > 0) {
    return { licenseTexts: installedTexts, licenseTextSource: undefined };
  }

  const key = `${name}@${version}`;
  const override = licenseOverrides.get(key);
  if (override === undefined) throw new Error(`Missing license file for ${key}.`);
  override.used = true;
  const overrideDir = resolve(licenseOverridesDir, override.directory);
  assertInsideDirectory(licenseOverridesDir, overrideDir, `License override for ${key}`);
  const overrideTexts = await readLicenseFiles(overrideDir, name, version);
  if (overrideTexts.length === 0) throw new Error(`License override is empty for ${key}.`);
  return { licenseTexts: overrideTexts, licenseTextSource: override.source };
}

async function readLicenseFiles(directory, name, version) {
  const entries = (await readdir(directory))
    .filter((entry) => /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry))
    .sort(compareText);
  const texts = [];
  for (const filename of entries) {
    const path = join(directory, filename);
    if (!(await stat(path)).isFile()) continue;
    const bytes = await readFile(path);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`License file is not UTF-8: ${name}@${version}/${filename}`);
    }
    text = text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd();
    if (text === '') throw new Error(`License file is empty: ${name}@${version}/${filename}`);
    texts.push({ filename, text });
  }
  return texts;
}

async function loadLicenseOverrides() {
  const value = JSON.parse(await readFile(licenseOverridesPath, 'utf8'));
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Invalid third-party license override map.');
  }
  const overrides = new Map();
  for (const [key, override] of Object.entries(value)) {
    if (
      override === null
      || Array.isArray(override)
      || typeof override !== 'object'
      || typeof override.directory !== 'string'
      || override.directory === ''
      || typeof override.source !== 'string'
      || !override.source.startsWith('https://')
    ) {
      throw new Error(`Invalid license override for ${key}.`);
    }
    overrides.set(key, { ...override, used: false });
  }
  return overrides;
}

async function collectPackagedRuntimeDevDependencies(workspacePackages) {
  const desktopManifest = workspacePackages.get(desktopPackageName)?.manifest;
  if (desktopManifest === undefined) throw new Error(`Workspace package not found: ${desktopPackageName}`);

  const records = [];
  for (const name of [...packagedRuntimeDevDependencies].sort(compareText)) {
    if (desktopManifest.devDependencies?.[name] === undefined) {
      throw new Error(`Packaged runtime dependency is not declared by Desktop: ${name}`);
    }
    const packageDir = join(desktopDir, 'node_modules', ...name.split('/'));
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    if (manifest.name !== name || typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error(`Invalid installed package metadata for ${name}.`);
    }
    validateSpdx(manifest.license);
    const homepage = normalizeHomepage(manifest);
    const { licenseTexts, licenseTextSource } = await readLicenseTexts(
      packageDir,
      name,
      manifest.version,
      new Map(),
    );
    records.push({
      name,
      version: manifest.version,
      spdx: manifest.license,
      homepage,
      licenseTexts,
      licenseTextSource,
    });
  }
  return records;
}

function deduplicateLicensedPackages(packages) {
  const packagesByKey = new Map();
  for (const record of packages) {
    const key = `${record.name}\0${record.version}`;
    const previous = packagesByKey.get(key);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(record)) {
      throw new Error(`Conflicting installed copies of ${record.name}@${record.version}.`);
    }
    packagesByKey.set(key, record);
  }
  return [...packagesByKey.values()].sort((left, right) => (
    compareText(left.name, right.name) || compareText(left.version, right.version)
  ));
}

function normalizeHomepage(manifest) {
  const repository = typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url;
  const homepage = manifest.homepage ?? repository;
  if (typeof homepage !== 'string' || homepage.trim() === '') {
    throw new Error(`Missing homepage for ${manifest.name}.`);
  }
  return homepage.trim().replace(/^git\+/, '').replace(/\.git$/, '');
}

function dependencyFingerprint(workspaceClosure) {
  const input = [...workspaceClosure.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, { manifest }]) => ({
      name,
      version: manifest.version,
      dependencies: sortedRecord(manifest.dependencies),
      optionalDependencies: sortedRecord(manifest.optionalDependencies),
      sourceBundledWorkspaceDevDependencies: sourceBundledDevDependencyOwners.has(name)
        ? sortedRecord(Object.fromEntries(Object.entries(manifest.devDependencies ?? {})
          .filter(([dependencyName]) => workspaceClosure.has(dependencyName))))
        : {},
      packagedRuntimeDevDependencies: name === desktopPackageName
        ? sortedRecord(Object.fromEntries(Object.entries(manifest.devDependencies ?? {})
          .filter(([dependencyName]) => packagedRuntimeDevDependencies.has(dependencyName))))
        : {},
    }));
  return sha256(`${JSON.stringify(input)}\n`);
}

function renderNotices(packages, workspacePackageCount, fingerprint) {
  const lines = [
    '<!-- Generated by scripts/generate-third-party-notices.mjs. Do not edit manually. -->',
    '',
    '# Third-Party Notices',
    '',
    'This file lists the external production dependencies shipped with Kimi Code Desktop.',
    'Workspace packages maintained in this repository are covered by the repository-level',
    '[MIT License](../../LICENSE) and are not duplicated here. Electron also ships its own',
    '`LICENSE.electron.txt` and `LICENSES.chromium.html` files in Windows distributions.',
    '',
    `- External packages: ${packages.length}`,
    `- Workspace source roots: ${workspacePackageCount}`,
    `- Dependency graph SHA-256: \`${fingerprint}\``,
    '',
    'Packages are sorted by name and version. SPDX expressions and license texts come from',
    'the installed package metadata selected by the pinned pnpm lockfile. If a published',
    'package omits its license file, generation requires a reviewed, commit-pinned override',
    'and records that source next to the affected package.',
    '',
    '## Package Index',
    '',
    '| Package | Version | SPDX | Homepage |',
    '| --- | --- | --- | --- |',
    ...packages.map((item) => (
      `| \`${escapeTable(item.name)}\` | \`${escapeTable(item.version)}\` | \`${escapeTable(item.spdx)}\` | <${escapeTable(item.homepage)}> |`
    )),
    '',
    '## License Texts',
    '',
  ];

  for (const item of packages) {
    const metadata = [
      `### \`${item.name}@${item.version}\``,
      '',
      `- SPDX: \`${item.spdx}\``,
      `- Homepage: <${item.homepage}>`,
    ];
    if (item.licenseTextSource !== undefined) {
      metadata.push(`- License text source: <${item.licenseTextSource}>`);
    }
    lines.push(...metadata, '');
    for (const licenseText of item.licenseTexts) {
      const fence = backtickFence(licenseText.text);
      lines.push(
        `#### \`${licenseText.filename}\``,
        '',
        `${fence}text`,
        licenseText.text,
        fence,
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function validateSpdx(expression) {
  if (typeof expression !== 'string' || expression.trim() === '' || expression.toUpperCase() === 'UNKNOWN') {
    throw new Error(`Unknown license expression: ${String(expression)}`);
  }
  try {
    parseSpdxExpression(expression);
  } catch (error) {
    throw new Error(`Invalid SPDX expression ${expression}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runPnpmJson(args) {
  const { command, commandArgs, windowsVerbatimArguments = false } = resolvePnpmInvocation(args);
  const stdout = execFileSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

function resolvePnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  const hasNpmExecPath = npmExecPath !== undefined && existsSync(npmExecPath);
  if (!hasNpmExecPath) return { command: 'pnpm', commandArgs: args };
  if (/\.[cm]?js$/i.test(npmExecPath)) {
    return { command: process.execPath, commandArgs: [npmExecPath, ...args] };
  }
  if (/\.(?:cmd|bat)$/i.test(npmExecPath)) {
    const commandLine = [npmExecPath, ...args].map(quoteCmdArgument).join(' ');
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      commandArgs: ['/d', '/s', '/c', `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: npmExecPath, commandArgs: args };
}

function quoteCmdArgument(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertPortableOutput(output) {
  const normalizedRoot = repoRoot.replaceAll('\\', '/');
  if (output.replaceAll('\\', '/').includes(normalizedRoot)) {
    throw new Error('Generated notices contain the local repository path.');
  }
}

function assertInsideRepo(path) {
  assertInsideDirectory(repoRoot, path, 'Workspace path');
}

function assertInsideDirectory(parent, path, label) {
  const pathFromParent = relative(parent, path);
  if (pathFromParent === '..' || pathFromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromParent)) {
    throw new Error(`${label} is outside ${parent}: ${path}`);
  }
}

function sortedRecord(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => compareText(left, right)));
}

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function escapeTable(value) {
  return value.replaceAll('|', '\\|');
}

function backtickFence(text) {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
