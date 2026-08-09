import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const workspacePreferencesSchema = z.object({
  version: z.literal(1),
  lastWorkspace: z.string().min(1).optional(),
}).strict();

export interface WorkspacePreferences {
  readonly version: 1;
  readonly lastWorkspace?: string;
}

const EMPTY_PREFERENCES: WorkspacePreferences = { version: 1 };

export function workspacePreferencesPath(userDataDir: string): string {
  return join(userDataDir, 'workspace-state.json');
}

export async function readWorkspacePreferences(path: string): Promise<WorkspacePreferences> {
  try {
    return workspacePreferencesSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return EMPTY_PREFERENCES;
  }
}

export async function writeWorkspacePreferences(path: string, lastWorkspace?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify({ version: 1, lastWorkspace }, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function selectInitialWorkspace(
  environmentWorkspace: string | undefined,
  preferences: WorkspacePreferences,
): string | undefined {
  return environmentWorkspace?.trim() || preferences.lastWorkspace;
}

export async function isWorkspaceDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
