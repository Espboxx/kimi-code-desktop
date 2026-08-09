export interface TimelineAutoFollowInput {
  readonly hasContent: boolean;
  readonly nearBottom: boolean;
  readonly streamChanged: boolean;
  readonly followRequested: boolean;
  readonly pendingFollow: boolean;
}

export interface TimelineAutoFollowDecision {
  readonly shouldFollow: boolean;
  readonly pendingFollow: boolean;
}

export function decideTimelineAutoFollow(input: TimelineAutoFollowInput): TimelineAutoFollowDecision {
  const requested = input.pendingFollow || input.streamChanged || input.followRequested;
  const shouldFollow = input.hasContent && (input.nearBottom || requested);
  return {
    shouldFollow,
    pendingFollow: requested && !shouldFollow,
  };
}
