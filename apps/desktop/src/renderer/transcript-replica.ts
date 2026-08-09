import { TranscriptStore } from '@moonshot-ai/transcript';

import type { SequencedTranscriptBatch, TranscriptSnapshot } from '../shared/desktop-api';

export type TranscriptBatchResult = 'applied' | 'ignored' | 'gap';

export class DesktopTranscriptReplica {
  private value?: TranscriptStore;
  private sequences = new Map<string, number>();

  get store(): TranscriptStore | undefined {
    return this.value;
  }

  reset(baseline?: TranscriptSnapshot): TranscriptStore | undefined {
    if (baseline === undefined) {
      this.value = undefined;
      this.sequences.clear();
      return undefined;
    }

    const next = new TranscriptStore(baseline.sessionId);
    const sequences = new Map<string, number>();
    for (const descriptor of baseline.agents) {
      const agent = next.ensureAgent(descriptor.agentId, descriptor);
      const snapshot = baseline.transcripts[descriptor.agentId];
      if (snapshot !== undefined) {
        agent.receive([{ op: 'reset', agentId: descriptor.agentId, snapshot }]);
      }
      sequences.set(descriptor.agentId, baseline.seqByAgent[descriptor.agentId] ?? 0);
    }
    this.value = next;
    this.sequences = sequences;
    return next;
  }

  apply(batch: SequencedTranscriptBatch): TranscriptBatchResult {
    const store = this.value;
    if (store === undefined || store.sessionId !== batch.sessionId) return 'ignored';

    const current = this.sequences.get(batch.agentId) ?? 0;
    if (batch.seq <= current) return 'ignored';
    if (batch.seq !== current + 1) return 'gap';

    const result = (store.getAgent(batch.agentId) ?? store.ensureAgent(batch.agentId, { agentId: batch.agentId })).apply(batch.ops);
    if (result.gap !== undefined) return 'gap';
    this.sequences.set(batch.agentId, batch.seq);
    return 'applied';
  }
}
