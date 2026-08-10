/**
 * `agentProfileCatalog` domain — pure workspace-aware profile projection.
 *
 * Merges registry contributions by priority, preserves builtin profiles unless
 * a file profile explicitly opts into overriding them, and records the winning
 * source plus suppressed candidates for catalog and management read surfaces.
 */

import type { AgentProfile } from './agentProfileCatalog';
import type { AgentProfileRegistration } from './agentProfileRegistry';
import { BUILTIN_AGENT_PROFILE_SOURCE_ID } from './builtinAgentProfileLoader';

export interface ProjectedAgentProfileSuppressedCandidate {
  readonly sourceId: string;
  readonly priority: number;
  readonly reason: 'priority' | 'builtin-override-required';
}

export interface ProjectedAgentProfileInspection {
  readonly name: string;
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
  readonly suppressed: readonly ProjectedAgentProfileSuppressedCandidate[];
}

export interface AgentProfileProjection {
  readonly profiles: ReadonlyMap<string, AgentProfile>;
  readonly inspections: ReadonlyMap<string, ProjectedAgentProfileInspection>;
}

interface ProfileCandidate {
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
}

export function projectAgentProfiles(
  entries: readonly AgentProfileRegistration[],
  warn?: (message: string) => void,
): AgentProfileProjection {
  const profiles = new Map<string, AgentProfile>();
  const inspections = new Map<string, ProjectedAgentProfileInspection>();
  const builtinEntry = entries.find((entry) => entry.sourceId === BUILTIN_AGENT_PROFILE_SOURCE_ID);

  if (builtinEntry !== undefined) {
    for (const profile of builtinEntry.contribution.profiles) {
      profiles.set(profile.name, profile);
      inspections.set(profile.name, {
        name: profile.name,
        profile,
        sourceId: builtinEntry.sourceId,
        priority: builtinEntry.priority,
        suppressed: [],
      });
    }
  }

  const candidatesByName = new Map<string, ProfileCandidate[]>();
  const ordered = entries
    .filter((entry) => entry.sourceId !== BUILTIN_AGENT_PROFILE_SOURCE_ID)
    .toSorted((left, right) => right.priority - left.priority);
  for (const entry of ordered) {
    const profilesByName = new Map<string, AgentProfile>();
    for (const profile of entry.contribution.profiles) profilesByName.set(profile.name, profile);
    for (const profile of profilesByName.values()) {
      const candidates = candidatesByName.get(profile.name) ?? [];
      candidates.push({ profile, sourceId: entry.sourceId, priority: entry.priority });
      candidatesByName.set(profile.name, candidates);
    }
  }

  for (const candidates of candidatesByName.values()) {
    const suppressed: ProjectedAgentProfileSuppressedCandidate[] = [];
    let winner = false;
    for (const [index, candidate] of candidates.entries()) {
      if (profiles.has(candidate.profile.name) && candidate.profile.override !== true) {
        warn?.(
          `agent file profile "${candidate.profile.name}" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it`,
        );
        suppressed.push({
          sourceId: candidate.sourceId,
          priority: candidate.priority,
          reason: 'builtin-override-required',
        });
        continue;
      }
      profiles.set(candidate.profile.name, candidate.profile);
      inspections.set(candidate.profile.name, {
        name: candidate.profile.name,
        profile: candidate.profile,
        sourceId: candidate.sourceId,
        priority: candidate.priority,
        suppressed: [
          ...suppressed,
          ...candidates.slice(index + 1).map((rest) => ({
            sourceId: rest.sourceId,
            priority: rest.priority,
            reason: 'priority' as const,
          })),
        ],
      });
      winner = true;
      break;
    }
    if (!winner && suppressed.length > 0) {
      const name = candidates[0]?.profile.name;
      const existing = name === undefined ? undefined : inspections.get(name);
      if (existing !== undefined) inspections.set(existing.name, { ...existing, suppressed });
    }
  }

  return { profiles, inspections };
}
