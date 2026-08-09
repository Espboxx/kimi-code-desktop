#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(desktopDir, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (typeof tag !== 'string' || tag === '') {
  throw new Error('Pass the release tag as an argument or set GITHUB_REF_NAME.');
}
if (typeof manifest.version !== 'string' || manifest.version === '') {
  throw new Error('apps/desktop/package.json has no valid version.');
}

const expected = `desktop-v${manifest.version}`;
if (tag !== expected) {
  throw new Error(`Desktop release tag mismatch: expected ${expected}, received ${tag}.`);
}

console.log(`Desktop release tag ${tag} matches package version ${manifest.version}.`);
