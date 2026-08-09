import type { TeamAssignment, TeamMember } from '../shared/desktop-api';

export interface TeamMentionAlias {
  readonly alias: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly profileName?: string;
}

export interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function buildTeamMentionAliases(
  members: readonly TeamMember[],
  assignments: readonly TeamAssignment[],
): readonly TeamMentionAlias[] {
  const aliases = new Map<string, TeamMentionAlias>();
  for (const member of members) {
    const latestAssignment = assignments.findLast(
      (assignment) => assignment.agentId === member.agentId,
    );
    const displayName = member.displayName ?? latestAssignment?.displayName ?? member.agentId;
    const presentation = {
      agentId: member.agentId,
      displayName,
      profileName: latestAssignment?.profileName,
    };
    aliases.set(member.agentId.toLocaleLowerCase(), { alias: member.agentId, ...presentation });
    aliases.set(displayName.toLocaleLowerCase(), { alias: displayName, ...presentation });
  }
  return [...aliases.values()].toSorted((left, right) => right.alias.length - left.alias.length);
}

export function rehypeTeamMentions(aliases: readonly TeamMentionAlias[]) {
  const byAlias = new Map(aliases.map((alias) => [alias.alias.toLocaleLowerCase(), alias]));
  const pattern = aliases.length === 0
    ? undefined
    : new RegExp(
        `(^|[^\\p{L}\\p{N}_-])@(${aliases.map((alias) => escapeRegex(alias.alias)).join('|')})(?![\\p{L}\\p{N}_-])`,
        'giu',
      );
  return (tree: HastNode): void => {
    if (pattern === undefined) return;
    transformMentionChildren(tree, pattern, byAlias, false);
  };
}

function transformMentionChildren(
  node: HastNode,
  pattern: RegExp,
  aliases: ReadonlyMap<string, TeamMentionAlias>,
  excluded: boolean,
): void {
  const nextExcluded = excluded || node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'a';
  if (nextExcluded || node.children === undefined) return;
  const children: HastNode[] = [];
  for (const child of node.children) {
    if (child.type !== 'text' || child.value === undefined) {
      transformMentionChildren(child, pattern, aliases, false);
      children.push(child);
      continue;
    }
    children.push(...mentionNodes(child.value, pattern, aliases));
  }
  node.children = children;
}

function mentionNodes(
  text: string,
  pattern: RegExp,
  aliases: ReadonlyMap<string, TeamMentionAlias>,
): HastNode[] {
  pattern.lastIndex = 0;
  const nodes: HastNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const prefix = match[1] ?? '';
    const value = match[2] ?? '';
    const mentionStart = index + prefix.length;
    if (mentionStart > cursor) nodes.push({ type: 'text', value: text.slice(cursor, mentionStart) });
    const alias = aliases.get(value.toLocaleLowerCase());
    if (alias === undefined) {
      nodes.push({ type: 'text', value: `@${value}` });
    } else {
      nodes.push({
        type: 'element',
        tagName: 'button',
        properties: {
          type: 'button',
          className: ['team-mention'],
          dataAgentId: alias.agentId,
          title: alias.profileName === undefined
            ? `${alias.displayName} · ${alias.agentId}`
            : `${alias.displayName} · ${alias.profileName} · ${alias.agentId}`,
        },
        children: [{ type: 'text', value: `@${value}` }],
      });
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push({ type: 'text', value: text.slice(cursor) });
  return nodes.length === 0 ? [{ type: 'text', value: text }] : nodes;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
