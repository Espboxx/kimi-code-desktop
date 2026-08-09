import { existsSync } from 'node:fs';

import { LocalKaos, type Environment } from '@moonshot-ai/kaos';

const windowsBash = [
  process.env['KIMI_GIT_BASH'],
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

export const TEST_OS_ENV: Environment = {
  osKind: process.platform === 'win32' ? 'Windows' : 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: windowsBash ?? '/bin/bash',
};

// `LocalKaos`'s constructor is `private` at the TS level only — at runtime
// it's just a function. Skip the singleton/async detection path and build a
// fresh instance with a stub `osEnv` so test helpers can hand a real Kaos
// directly to `RuntimeConfig`.
type LocalKaosCtor = new (osEnv: Environment) => LocalKaos;
export const testKaos: LocalKaos = new (LocalKaos as unknown as LocalKaosCtor)(TEST_OS_ENV);
