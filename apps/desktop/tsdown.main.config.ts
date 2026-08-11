import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/electron/main.ts'],
  format: ['cjs'],
  outDir: 'dist-electron',
  clean: true,
  dts: false,
  hash: false,
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: ['electron', 'electron-updater', 'node-pty'],
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.cjs',
  },
});
