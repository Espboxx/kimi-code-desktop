import { describe, expect, it } from 'vitest';

import type { TeamOperation, TeamSnapshot } from '../shared/desktop-api';
import { createTeamState } from '../shared/team-state';
import {
  buildTeamMentionAliases,
  rehypeTeamMentions,
  type HastNode,
} from './team-message-markdown';
import { TeamReplica } from './team-replica';

const team = {
  id: 'team-1',
  sessionId: 's1',
  channelId: 'general',
  leaderAgentId: 'main',
  createdAt: 1,
} as const;

function baseline(): TeamSnapshot {
  return {
    state: 'ready',
    team,
    members: [{ agentId: 'main', displayName: '组长', role: 'leader', joinedAt: 1, joinedSeq: 1 }],
    batches: [],
    assignments: [],
    latestSeq: 1,
    latestChannelSeq: 0,
  };
}

describe('TeamReplica', () => {
  it('applies contiguous operations, deduplicates messages, and reports gaps', () => {
    const replica = new TeamReplica();
    replica.reset('s1', createTeamState(baseline()));
    const batch: TeamOperation = {
      version: 1,
      type: 'batch.created',
      seq: 2,
      at: 2,
      batch: { id: 'b1', callerAgentId: 'main', status: 'running', createdAt: 2, updatedAt: 2 },
      assignments: [{
        id: 'a1', batchId: 'b1', displayName: '构建专家', profileName: 'coder', description: 'Implement',
        status: 'queued', createdAt: 2, updatedAt: 2,
      }],
    };
    const message: TeamOperation = {
      version: 1,
      type: 'message.sent',
      seq: 3,
      at: 3,
      message: {
        id: 'm1', teamId: 'team-1', channelId: 'general', seq: 3, channelSeq: 1,
        sender: { actorKind: 'user', actorId: 'desktop-user', role: 'user' },
        body: 'Proceed', clientMessageId: 'client-1', createdAt: 3,
      },
    };

    expect(replica.apply('s1', [batch, message])).toBe('applied');
    expect(replica.get('s1')?.snapshot.latestSeq).toBe(3);
    expect(replica.get('s1')?.snapshot.assignments[0]?.displayName).toBe('构建专家');
    expect(replica.get('s1')?.messages).toHaveLength(1);
    expect(replica.apply('s1', [message])).toBe('duplicate');
    expect(replica.apply('s1', [{ ...message, seq: 5, message: { ...message.message, id: 'm2', seq: 5, channelSeq: 2 } }])).toBe('gap');
  });

  it('keeps independent session replicas', () => {
    const replica = new TeamReplica();
    replica.reset('s1', createTeamState(baseline()));
    replica.reset('s2', createTeamState({ ...baseline(), team: { ...team, id: 'team-2', sessionId: 's2' } }));
    replica.reset('s1', undefined);
    expect(replica.get('s1')).toBeUndefined();
    expect(replica.get('s2')?.snapshot.team?.id).toBe('team-2');
  });
});

describe('Team mention presentation', () => {
  it('maps display names and agent ids while leaving code and links untouched', () => {
    const aliases = buildTeamMentionAliases(
      [
        { agentId: 'agent-2', displayName: '界面侦察', role: 'member', joinedAt: 1, joinedSeq: 1 },
        { agentId: 'agent-3', displayName: '构建专家', role: 'member', joinedAt: 1, joinedSeq: 2 },
      ],
      [
        {
          id: 'a2', batchId: 'b1', agentId: 'agent-2', displayName: '界面侦察',
          profileName: 'explore', description: 'Inspect', status: 'running', createdAt: 1, updatedAt: 1,
        },
        {
          id: 'a3', batchId: 'b1', agentId: 'agent-3', displayName: '构建专家',
          profileName: 'coder', description: 'Implement', status: 'running', createdAt: 1, updatedAt: 1,
        },
      ],
    );
    const tree: HastNode = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: '请 @界面侦察 联系 @agent-3。' }] },
        { type: 'element', tagName: 'code', children: [{ type: 'text', value: '@界面侦察' }] },
        { type: 'element', tagName: 'a', children: [{ type: 'text', value: '@构建专家' }] },
      ],
    };

    rehypeTeamMentions(aliases)(tree);

    const children = tree.children!;
    const paragraph = children[0]!;
    const mentions = paragraph.children!.filter((node) => node.tagName === 'button');
    expect(mentions).toHaveLength(2);
    expect(mentions.map((node) => node.properties?.['dataAgentId'])).toEqual([
      'agent-2',
      'agent-3',
    ]);
    expect(children[1]?.children?.[0]?.value).toBe('@界面侦察');
    expect(children[2]?.children?.[0]?.value).toBe('@构建专家');
  });
});
