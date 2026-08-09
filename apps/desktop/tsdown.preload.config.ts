import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/electron/preload.ts'],
  format: ['cjs'],
  outDir: 'dist-electron',
  clean: false,
  dts: false,
  hash: false,
  deps: {
    neverBundle: ['electron'],
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'preload.cjs',
  },
});
