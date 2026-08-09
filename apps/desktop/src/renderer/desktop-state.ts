import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptStore } from '@moonshot-ai/transcript';

import type {
  DesktopSnapshot,
  KimiDesktopError,
  SequencedTranscriptBatch,
  SessionStatusSnapshot,
  TeamOperation,
  TeamStateSnapshot,
  TranscriptSnapshot,
} from '../shared/desktop-api';

interface WorkspaceChangeState {
  readonly version: number;
  readonly paths: readonly string[];
}

export interface CloseRequestState {
  readonly requestId: string;
  readonly dirtyPaths: readonly string[];
}
import { DesktopTranscriptReplica } from './transcript-replica';
import { TeamReplica } from './team-replica';

export interface DesktopState {
  readonly snapshot?: DesktopSnapshot;
  readonly transcript?: TranscriptStore;
  readonly transcriptVersion: number;
  readonly teams: Readonly<Record<string, TeamStateSnapshot>>;
  readonly teamVersion: number;
  readonly workspaceChange: WorkspaceChangeState;
  readonly sessionStatuses: Readonly<Record<string, SessionStatusSnapshot>>;
  readonly pendingInteractionCounts: Readonly<Record<string, number>>;
  readonly closeRequest?: CloseRequestState;
  readonly error?: KimiDesktopError;
  readonly dismissCloseRequest: () => void;
  readonly clearError: () => void;
  readonly refresh: () => Promise<void>;
}

export function useDesktopState(): DesktopState {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [transcript, setTranscript] = useState<TranscriptStore>();
  const [transcriptVersion, setTranscriptVersion] = useState(0);
  const [teams, setTeams] = useState<Readonly<Record<string, TeamStateSnapshot>>>({});
  const [teamVersion, setTeamVersion] = useState(0);
  const [workspaceChange, setWorkspaceChange] = useState<WorkspaceChangeState>({ version: 0, paths: [] });
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionStatusSnapshot>>({});
  const [pendingInteractions, setPendingInteractions] = useState<Record<string, { sessionId: string }>>({});
  const [closeRequest, setCloseRequest] = useState<CloseRequestState>();
  const [error, setError] = useState<KimiDesktopError>();
  const replicaRef = useRef(new DesktopTranscriptReplica());
  const teamReplicaRef = useRef(new TeamReplica());
  const resyncing = useRef(false);
  const teamResyncing = useRef(new Set<string>());

  const applyBaseline = useCallback((baseline?: TranscriptSnapshot) => {
    const next = replicaRef.current.reset(baseline);
    setTranscript(next);
    setTranscriptVersion((version) => version + 1);
  }, []);

  const applyTeamBaseline = useCallback((baseline: Readonly<Record<string, TeamStateSnapshot>>) => {
    teamReplicaRef.current.resetAll(baseline);
    setTeams(teamReplicaRef.current.all());
    setTeamVersion((version) => version + 1);
  }, []);

  const refresh = useCallback(async () => {
    const next = await window.kimiDesktop.host.snapshot();
    setSnapshot(next);
    applyBaseline(next.transcript);
    applyTeamBaseline(next.teams);
  }, [applyBaseline, applyTeamBaseline]);

  const applyBatch = useCallback((batch: SequencedTranscriptBatch) => {
    const result = replicaRef.current.apply(batch);
    if (result === 'gap') {
      if (!resyncing.current) {
        resyncing.current = true;
        void refresh().finally(() => { resyncing.current = false; });
      }
      return;
    }
    if (result === 'applied') setTranscriptVersion((version) => version + 1);
  }, [refresh]);

  const resetTeam = useCallback((sessionId: string, team?: TeamStateSnapshot) => {
    teamReplicaRef.current.reset(sessionId, team);
    setTeams(teamReplicaRef.current.all());
    setTeamVersion((version) => version + 1);
  }, []);

  const applyTeamBatch = useCallback((sessionId: string, operations: readonly TeamOperation[]) => {
    const result = teamReplicaRef.current.apply(sessionId, operations);
    if (result === 'applied') {
      setTeams(teamReplicaRef.current.all());
      setTeamVersion((version) => version + 1);
      return;
    }
    if ((result === 'gap' || result === 'missing') && !teamResyncing.current.has(sessionId)) {
      teamResyncing.current.add(sessionId);
      void (async () => {
        try {
          const current = teamReplicaRef.current.get(sessionId);
          if (current !== undefined) {
            const catchup = await window.kimiDesktop.team.operations(
              sessionId,
              current.snapshot.latestSeq,
              1_000,
            );
            const catchupResult = teamReplicaRef.current.apply(sessionId, catchup);
            if (catchupResult === 'applied' || catchupResult === 'duplicate') {
              setTeams(teamReplicaRef.current.all());
              if (catchupResult === 'applied') setTeamVersion((version) => version + 1);
              return;
            }
          }
          const snapshot = await window.kimiDesktop.team.snapshot(sessionId);
          const messages = snapshot.team === undefined
            ? []
            : await window.kimiDesktop.team.history(sessionId, undefined, 200);
          resetTeam(sessionId, snapshot.team === undefined ? undefined : { snapshot, messages });
        } catch (reason) {
          setError({ code: 'team.resync_failed', message: reason instanceof Error ? reason.message : String(reason) });
        } finally {
          teamResyncing.current.delete(sessionId);
        }
      })();
    }
  }, [resetTeam]);

  useEffect(() => {
    let alive = true;
    void window.kimiDesktop.host.snapshot()
      .then((next) => {
        if (!alive) return;
        setSnapshot(next);
        applyBaseline(next.transcript);
        applyTeamBaseline(next.teams);
      })
      .catch((reason) => {
        if (!alive) return;
        setError({ code: 'desktop.bootstrap', message: reason instanceof Error ? reason.message : String(reason) });
      });
    const unsubscribe = window.kimiDesktop.onNotification((notification) => {
      if (!alive) return;
      switch (notification.type) {
        case 'snapshot.reset':
          setSnapshot(notification.snapshot);
          setSessionStatuses((current) => pruneSessionState(
            current,
            new Set(notification.snapshot.sessions.map((session) => session.id)),
          ));
          setPendingInteractions((current) => prunePendingInteractions(
            current,
            new Set(notification.snapshot.sessions.map((session) => session.id)),
          ));
          if (notification.snapshot.activeSessionId !== undefined && notification.snapshot.session.status !== undefined) {
            setSessionStatuses((current) => ({
              ...current,
              [notification.snapshot.activeSessionId!]: notification.snapshot.session.status!,
            }));
          }
          applyBaseline(notification.snapshot.transcript);
          applyTeamBaseline(notification.snapshot.teams);
          break;
        case 'transcript.ops':
          applyBatch(notification.batch);
          break;
        case 'team.reset':
          resetTeam(notification.sessionId, notification.state);
          break;
        case 'team.ops':
          applyTeamBatch(notification.sessionId, notification.operations);
          break;
        case 'session.status':
          setSessionStatuses((current) => ({ ...current, [notification.sessionId]: notification.status }));
          setSnapshot((current) => current === undefined || current.activeSessionId !== notification.sessionId
            ? current
            : { ...current, session: { ...current.session, status: notification.status } });
          break;
        case 'workspace.changed':
          setSnapshot((current) => current === undefined ? current : {
            ...current,
            workspace: notification.workspace,
            tree: notification.tree,
            gitFiles: notification.gitFiles,
          });
          setWorkspaceChange((current) => ({ version: current.version + 1, paths: notification.changedPaths }));
          break;
        case 'host.closeRequested':
          setCloseRequest({ requestId: notification.requestId, dirtyPaths: notification.dirtyPaths });
          break;
        case 'error':
          setError(notification.error);
          break;
        case 'interaction.pending':
          setPendingInteractions((current) => ({
            ...current,
            [`${notification.sessionId}:${notification.interactionId}`]: { sessionId: notification.sessionId },
          }));
          break;
        case 'interaction.resolved': {
          const key = `${notification.sessionId}:${notification.interactionId}`;
          setPendingInteractions((current) => {
            if (current[key] === undefined) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          break;
        }
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [applyBaseline, applyBatch, applyTeamBaseline, applyTeamBatch, resetTeam]);

  return {
    snapshot,
    transcript,
    transcriptVersion,
    teams,
    teamVersion,
    workspaceChange,
    sessionStatuses,
    pendingInteractionCounts: Object.values(pendingInteractions).reduce<Record<string, number>>((counts, interaction) => {
      counts[interaction.sessionId] = (counts[interaction.sessionId] ?? 0) + 1;
      return counts;
    }, {}),
    closeRequest,
    error,
    dismissCloseRequest: () => setCloseRequest(undefined),
    clearError: () => setError(undefined),
    refresh,
  };
}

function pruneSessionState<T>(value: Record<string, T>, validSessionIds: ReadonlySet<string>): Record<string, T> {
  const entries = Object.entries(value).filter(([sessionId]) => validSessionIds.has(sessionId));
  return entries.length === Object.keys(value).length ? value : Object.fromEntries(entries);
}

function prunePendingInteractions<T extends { readonly sessionId: string }>(
  value: Record<string, T>,
  validSessionIds: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(value).filter(([, interaction]) => validSessionIds.has(interaction.sessionId));
  return entries.length === Object.keys(value).length ? value : Object.fromEntries(entries);
}
