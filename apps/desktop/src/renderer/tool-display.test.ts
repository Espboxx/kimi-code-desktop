// Scenario: Desktop tool cards while arguments stream, approval blocks, and execution finishes.
// Responsibilities: expose one unambiguous user-facing phase for each observable tool state.
// Wiring: pure display-state helper over public transcript contracts. Run with the Desktop Vitest config.
import { describe, expect, it } from 'vitest';

import {
  fileOperationDisplay,
  payloadPreview,
  toolDisplayState,
  workspaceFilePath,
} from './tool-display';

describe('tool card phase (streaming and interaction state)', () => {
  it('reports parameter preparation before parsed input arrives', () => {
    expect(toolDisplayState({ state: 'running', input: undefined, display: undefined })).toBe('preparing');
  });

  it('reports approval waiting while a permission interaction is pending', () => {
    expect(toolDisplayState(
      { state: 'running', input: undefined, display: undefined },
      { interactionKind: 'approval', state: 'pending' },
    )).toBe('waiting-approval');
  });

  it('reports answer waiting while a question interaction is pending', () => {
    expect(toolDisplayState(
      { state: 'running', input: {}, display: undefined },
      { interactionKind: 'question', state: 'pending' },
    )).toBe('waiting-answer');
  });

  it('reports execution after parsed input arrives without a pending interaction', () => {
    expect(toolDisplayState({ state: 'running', input: {}, display: undefined })).toBe('running');
  });

  it('reports the terminal frame state after execution completes', () => {
    expect(toolDisplayState({ state: 'done', input: {}, display: undefined })).toBe('done');
  });
});

describe('tool payload preview (bounded inline rendering)', () => {
  it('keeps a short payload intact when it fits the inline limit', () => {
    expect(payloadPreview('short', 10)).toEqual({ text: 'short', omittedCharacters: 0 });
  });

  it('reports omitted characters when a payload exceeds the inline limit', () => {
    expect(payloadPreview('0123456789', 4)).toEqual({ text: '0123', omittedCharacters: 6 });
  });
});

describe('file operation actions (structured display and workspace path)', () => {
  it('recognizes a structured edit operation with its before and after snippets', () => {
    expect(fileOperationDisplay({
      kind: 'file_io', operation: 'edit', path: 'src/main.ts', before: 'old', after: 'new',
    })).toEqual({
      operation: 'edit', path: 'src/main.ts', content: undefined, before: 'old', after: 'new',
    });
  });

  it('rejects file search metadata because it does not open one operated file', () => {
    expect(fileOperationDisplay({ kind: 'file_io', operation: 'grep', path: 'src' })).toBeUndefined();
  });

  it('converts a Windows absolute path inside the workspace to a relative editor path', () => {
    expect(workspaceFilePath('D:\\code\\example', 'd:\\CODE\\example\\src\\main.ts')).toBe('src/main.ts');
  });

  it('keeps a normalized relative path inside the workspace', () => {
    expect(workspaceFilePath('D:\\code\\example', 'src/feature/../main.ts')).toBe('src/main.ts');
  });

  it('rejects an absolute path outside the active workspace', () => {
    expect(workspaceFilePath('D:\\code\\example', 'D:\\other\\secret.txt')).toBeUndefined();
  });

  it('rejects a relative path that escapes the active workspace', () => {
    expect(workspaceFilePath('D:\\code\\example', '../secret.txt')).toBeUndefined();
  });
});
