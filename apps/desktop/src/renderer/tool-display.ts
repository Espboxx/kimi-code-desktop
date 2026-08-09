import type { ToolCallFrame, TranscriptInteraction } from '@moonshot-ai/transcript';

import { formatJson } from './ui-utils';

const MAX_INLINE_PAYLOAD_CHARS = 32_000;

export type ToolDisplayState =
  | 'preparing'
  | 'waiting-approval'
  | 'waiting-answer'
  | 'running'
  | 'done'
  | 'error';

export function toolDisplayState(
  frame: Pick<ToolCallFrame, 'state' | 'input' | 'display'>,
  interaction?: Pick<TranscriptInteraction, 'interactionKind' | 'state'>,
): ToolDisplayState {
  if (frame.state === 'done') return 'done';
  if (frame.state === 'error') return 'error';
  if (interaction?.state === 'pending') {
    return interaction.interactionKind === 'approval' ? 'waiting-approval' : 'waiting-answer';
  }
  if (frame.input === undefined && frame.display === undefined) return 'preparing';
  return 'running';
}

export interface PayloadPreview {
  readonly text: string;
  readonly omittedCharacters: number;
}

export type FileOperationKind = 'read' | 'write' | 'edit';

export interface FileOperationDisplay {
  readonly operation: FileOperationKind;
  readonly path: string;
  readonly content?: string;
  readonly before?: string;
  readonly after?: string;
}

export interface FileOperationTarget {
  readonly toolCallId: string;
  readonly operation: FileOperationKind;
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

export function fileOperationDisplay(value: unknown): FileOperationDisplay | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const operation = source['operation'];
  const path = source['path'];
  if (
    source['kind'] !== 'file_io'
    || (operation !== 'read' && operation !== 'write' && operation !== 'edit')
    || typeof path !== 'string'
    || path.trim().length === 0
  ) return undefined;
  return {
    operation,
    path,
    content: typeof source['content'] === 'string' ? source['content'] : undefined,
    before: typeof source['before'] === 'string' ? source['before'] : undefined,
    after: typeof source['after'] === 'string' ? source['after'] : undefined,
  };
}

export function workspaceFilePath(workspaceRoot: string, candidate: string): string | undefined {
  const root = normalizeAbsolutePath(workspaceRoot);
  const input = candidate.replaceAll('\\', '/');
  if (root === undefined || input.trim().length === 0) return undefined;
  if (!isAbsolutePath(input)) return normalizeRelativePath(input);

  const absolute = normalizeAbsolutePath(input);
  if (absolute === undefined) return undefined;
  const caseInsensitive = /^[A-Za-z]:\//.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparablePath = caseInsensitive ? absolute.toLowerCase() : absolute;
  if (!comparablePath.startsWith(`${comparableRoot}/`)) return undefined;
  return absolute.slice(root.length + 1);
}

export function payloadPreview(value: unknown, maxCharacters = MAX_INLINE_PAYLOAD_CHARS): PayloadPreview {
  const formatted = formatJson(value);
  const limit = Math.max(0, maxCharacters);
  if (formatted.length <= limit) return { text: formatted, omittedCharacters: 0 };
  return {
    text: formatted.slice(0, limit),
    omittedCharacters: formatted.length - limit,
  };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('//') || /^[A-Za-z]:\//.test(path);
}

function normalizeAbsolutePath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!isAbsolutePath(normalized)) return undefined;
  const prefix = /^[A-Za-z]:\//.test(normalized)
    ? normalized.slice(0, 3)
    : normalized.startsWith('//')
      ? '//'
      : '/';
  const rest = normalized.slice(prefix.length);
  const relative = normalizeRelativePath(rest);
  return relative === undefined ? undefined : `${prefix}${relative}`.replace(/\/$/, '');
}

function normalizeRelativePath(path: string): string | undefined {
  const segments: string[] = [];
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join('/');
}
