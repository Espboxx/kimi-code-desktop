import { TranscriptStore, type TurnHeader } from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import type { TranscriptSnapshot } from '../shared/desktop-api';
import { DesktopTranscriptReplica } from './transcript-replica';

describe('DesktopTranscriptReplica', () => {
  it('restores a baseline, ignores duplicates, and reports sequence gaps', () => {
    const source = new TranscriptStore('s1');
    const agent = source.ensureAgent('main', { agentId: 'main', type: 'main' });
    agent.apply([{ op: 'turn.upsert', turn: turn('t1', 1) }]);
    const baseline: TranscriptSnapshot = {
      sessionId: 's1',
      agents: source.agents(),
      transcripts: { main: agent.snapshot() },
      seqByAgent: { main: 4 },
    };
    const replica = new DesktopTranscriptReplica();
    replica.reset(baseline);

    const next = { sessionId: 's1', agentId: 'main', seq: 5, ops: [{ op: 'turn.upsert', turn: turn('t2', 2) }] } as const;
    expect(replica.apply(next)).toBe('applied');
    expect(replica.store?.getAgent('main')?.getTurn('t2')).toBeDefined();
    expect(replica.store?.agents()).toContainEqual({ agentId: 'main', type: 'main' });
    expect(replica.apply(next)).toBe('ignored');
    expect(replica.apply({ ...next, seq: 7 })).toBe('gap');
    expect(replica.apply({ ...next, sessionId: 'other', seq: 6 })).toBe('ignored');
  });
});

function turn(turnId: string, ordinal: number): TurnHeader {
  return { kind: 'turn', turnId, ordinal, state: 'completed', origin: { kind: 'user' } };
}
