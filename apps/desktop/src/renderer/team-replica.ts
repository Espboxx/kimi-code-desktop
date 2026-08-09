import type { TeamOperation, TeamStateSnapshot } from '../shared/desktop-api';
import { applyTeamOperations } from '../shared/team-state';

export type TeamReplicaApplyResult = 'applied' | 'duplicate' | 'gap' | 'missing';

export class TeamReplica {
  private states = new Map<string, TeamStateSnapshot>();

  resetAll(states: Readonly<Record<string, TeamStateSnapshot>>): void {
    this.states = new Map(Object.entries(states));
  }

  reset(sessionId: string, state?: TeamStateSnapshot): void {
    if (state === undefined) this.states.delete(sessionId);
    else this.states.set(sessionId, state);
  }

  apply(sessionId: string, operations: readonly TeamOperation[]): TeamReplicaApplyResult {
    const state = this.states.get(sessionId);
    if (state === undefined) return 'missing';
    const fresh = operations.filter((operation) => operation.seq > state.snapshot.latestSeq);
    if (fresh.length === 0) return 'duplicate';
    const next = applyTeamOperations(state, fresh);
    if (next === undefined) return 'gap';
    this.states.set(sessionId, next);
    return 'applied';
  }

  get(sessionId: string): TeamStateSnapshot | undefined {
    return this.states.get(sessionId);
  }

  all(): Readonly<Record<string, TeamStateSnapshot>> {
    return Object.fromEntries(this.states);
  }
}
