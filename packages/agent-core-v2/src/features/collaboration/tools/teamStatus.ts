/**
 * `collaboration` domain — TeamStatus tool contract and implementation.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

import { ISessionCollaborationService } from '../collaboration';
import type { TeamMember } from '../types';

interface StatusAssignment {
  readonly id: string;
  readonly batchId: string;
  readonly taskKey?: string;
  readonly parentTaskId?: string;
  readonly parentAssignmentId?: string;
  readonly dependsOn?: readonly string[];
  readonly agentId?: string;
  readonly displayName?: string;
  readonly profileName: string;
  readonly description: string;
  readonly item?: string;
  readonly status: string;
  readonly error?: string;
}

export const TeamStatusInputSchema = z.object({}).strict();
export type TeamStatusInput = z.infer<typeof TeamStatusInputSchema>;

export interface ITeamStatusTool extends AgentTool<TeamStatusInput> { readonly _serviceBrand: undefined }
export const ITeamStatusTool = createDecorator<ITeamStatusTool>('teamStatusTool');

export class TeamStatusTool implements ITeamStatusTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamStatus' as const;
  readonly description =
    'Read team members, active work, and reusable idle agents before assigning follow-up work.';
  readonly parameters = toInputJsonSchema(TeamStatusInputSchema);

  constructor(@ISessionCollaborationService private readonly collaboration: ISessionCollaborationService) {}

  resolveExecution(_input: TeamStatusInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Reading team status',
      approvalRule: this.name,
      execute: async () => {
        const snapshot = await this.collaboration.snapshot();
        const source = snapshot.assignments as readonly StatusAssignment[];
        const assignments = source.map(summarizeAssignment);
        const memberAvailability = snapshot.members.map((member) =>
          summarizeMember(member, source),
        );
        const runtime = snapshot.protocolVersion === 2
          ? {
              scheduler: snapshot.scheduler,
              budget: snapshot.budget,
              integration: snapshot.integration,
            }
          : {};
        return {
          output: JSON.stringify({
            state: snapshot.state,
            protocolVersion: snapshot.protocolVersion,
            team: snapshot.team,
            latestSeq: snapshot.latestSeq,
            members: memberAvailability,
            reusableMembers: memberAvailability.filter(
              (member) => member.availability === 'reusable',
            ),
            batches: snapshot.batches.filter((batch) =>
              ['running', 'paused', 'interrupted'].includes(batch.status),
            ),
            assignments,
            ...runtime,
          }, null, 2),
        };
      },
    };
  }
}

function summarizeMember(member: TeamMember, assignments: readonly StatusAssignment[]) {
  const memberAssignments = assignments.filter((assignment) => assignment.agentId === member.agentId);
  const activeAssignment = memberAssignments.findLast((assignment) =>
    ['queued', 'ready', 'running', 'awaiting_validation', 'integrating'].includes(assignment.status),
  );
  const latestAssignment = memberAssignments.at(-1);
  const availability = member.role === 'leader'
    ? 'leader'
    : activeAssignment === undefined && latestAssignment !== undefined
      ? 'reusable'
      : activeAssignment === undefined
        ? 'idle'
        : 'busy';
  return {
    ...member,
    availability,
    activeAssignment: activeAssignment === undefined ? undefined : summarizeAssignment(activeAssignment),
    latestAssignment: latestAssignment === undefined ? undefined : summarizeAssignment(latestAssignment),
  };
}

function summarizeAssignment({
  id,
  batchId,
  taskKey,
  parentTaskId,
  parentAssignmentId,
  dependsOn,
  agentId,
  displayName,
  profileName,
  description,
  item,
  status,
  error,
}: StatusAssignment) {
  return {
    id,
    taskKey,
    batchId,
    parentTaskId: parentTaskId ?? parentAssignmentId,
    dependsOn,
    agentId,
    displayName,
    profileName,
    description,
    item,
    status,
    error,
  };
}
