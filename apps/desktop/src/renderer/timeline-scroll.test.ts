/**
 * Scenario: timeline auto-follow policy for live transcript updates.
 * Responsibilities: preserve history reading while following explicit navigation and submissions.
 * Wiring: pure policy inputs; no external collaborators.
 * Run: pnpm --filter @moonshot-ai/kimi-code-desktop test
 */
import { describe, expect, it } from 'vitest';

import { decideTimelineAutoFollow } from './timeline-scroll';

describe('timeline auto-follow policy', () => {
  it('follows live updates when the reader is already near the bottom', () => {
    expect(decideTimelineAutoFollow({
      hasContent: true,
      nearBottom: true,
      streamChanged: false,
      followRequested: false,
      pendingFollow: false,
    })).toEqual({ shouldFollow: true, pendingFollow: false });
  });

  it('preserves the reader position when a system marker arrives while reading history', () => {
    expect(decideTimelineAutoFollow({
      hasContent: true,
      nearBottom: false,
      streamChanged: false,
      followRequested: false,
      pendingFollow: false,
    })).toEqual({ shouldFollow: false, pendingFollow: false });
  });

  it('follows the active transcript when the session or Agent changes', () => {
    expect(decideTimelineAutoFollow({
      hasContent: true,
      nearBottom: false,
      streamChanged: true,
      followRequested: false,
      pendingFollow: false,
    })).toEqual({ shouldFollow: true, pendingFollow: false });
  });

  it('follows a user submission even when the reader was viewing history', () => {
    expect(decideTimelineAutoFollow({
      hasContent: true,
      nearBottom: false,
      streamChanged: false,
      followRequested: true,
      pendingFollow: false,
    })).toEqual({ shouldFollow: true, pendingFollow: false });
  });

  it('does not scroll an empty transcript', () => {
    expect(decideTimelineAutoFollow({
      hasContent: false,
      nearBottom: true,
      streamChanged: true,
      followRequested: true,
      pendingFollow: false,
    })).toEqual({ shouldFollow: false, pendingFollow: true });
  });

  it('follows delayed history after a session switch request was deferred', () => {
    expect(decideTimelineAutoFollow({
      hasContent: true,
      nearBottom: false,
      streamChanged: false,
      followRequested: false,
      pendingFollow: true,
    })).toEqual({ shouldFollow: true, pendingFollow: false });
  });
});
