export type DesktopSurface = 'chat' | 'team';

export const TEAM_SESSION_METADATA = {
  kimiDesktop: {
    version: 1,
    surface: 'team',
  },
} as const;

export function desktopSessionSurface(
  metadata: unknown,
  hasTeam = false,
): DesktopSurface {
  if (hasTeam) return 'team';
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return 'chat';
  const desktop = (metadata as Record<string, unknown>)['kimiDesktop'];
  if (desktop === null || typeof desktop !== 'object' || Array.isArray(desktop)) return 'chat';
  return (desktop as Record<string, unknown>)['surface'] === 'team' ? 'team' : 'chat';
}
