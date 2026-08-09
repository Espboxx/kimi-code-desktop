/**
 * `collaboration` domain — per-agent world-time delivery cursor wire model.
 *
 * Advances the team cursor atomically with delivered context messages and
 * records explicit advances for filtered operations. The model is deliberately
 * not checkpointed, so undo and compaction never rewind team delivery.
 */

import { z } from 'zod';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { defineModel } from '#/wire/model';

export type CollaborationDeliveryState = Record<string, number>;

export const CollaborationDeliveryModel = defineModel<CollaborationDeliveryState>(
  'collaborationDelivery',
  () => ({}),
  {
    reducers: {
      'context.append_message': (state, payload: { readonly message: ContextMessage }) => {
        const origin = payload.message.origin;
        if (origin?.kind !== 'team_message') return state;
        const current = state[origin.teamId] ?? 0;
        if (origin.toSeq <= current) return state;
        return { ...state, [origin.teamId]: origin.toSeq };
      },
    },
  },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'team.delivery.advance': typeof teamDeliveryAdvance;
  }
}

export const teamDeliveryAdvance = CollaborationDeliveryModel.defineOp('team.delivery.advance', {
  schema: z.object({ teamId: z.string().min(1), toSeq: z.number().int().nonnegative() }).strict(),
  apply: (state, payload) => {
    const current = state[payload.teamId] ?? 0;
    return payload.toSeq <= current ? state : { ...state, [payload.teamId]: payload.toSeq };
  },
});
