import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// `rawTextPlugin` is required because server-v2 pulls in agent-core-v2's full
// barrel, which imports `*.md?raw` prompt templates.
export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'kap-server',
    include: ['test/**/*.{test,e2e}.ts'],
    setupFiles: ['test/setup.ts'],
    // Several kap-server suites exercise many independent minidb stores and
    // filesystem watchers. Under the full monorepo run, multiple Windows fork
    // workers can terminate inside Node with STATUS_STACK_BUFFER_OVERRUN.
    // Keep this project serial on Windows; other projects remain parallel.
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
  },
});
