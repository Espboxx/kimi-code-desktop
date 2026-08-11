import type { IAgentExecutionWorkspace } from '#/agent/executionWorkspace/executionWorkspace';

export function stubWorkspaceContext(
  workDir: string,
  additionalDirs: readonly string[] = [],
): IAgentExecutionWorkspace {
  return {
    _serviceBrand: undefined,
    workDir,
    access: 'write',
    confined: false,
    additionalDirs,
    resolve: (rel) => `${workDir}/${rel}`,
    isWithin: () => true,
    assertAllowed: (absPath) => absPath,
    configure: () => false,
  };
}
