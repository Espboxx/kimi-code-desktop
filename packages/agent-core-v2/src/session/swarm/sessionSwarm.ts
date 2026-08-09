/**
 * `sessionSwarm` domain — batch scheduler for swarm agent runs.
 *
 * Defines `ISessionSwarmService`, the Session-scoped service that runs a batch
 * of agents on behalf of a caller agent. Owns the in-flight batch state so
 * cancellation can reach every run. Bound at Session scope.
 */

import type { TokenUsage } from '#/kosong/contract/usage';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

type SessionSwarmTaskBase<T> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly swarmItem?: string;
  readonly runInBackground: boolean;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
  readonly onAgentBound?: (agentId: string) => Promise<void>;
};

export type SessionSwarmSpawnTask<T = unknown> = SessionSwarmTaskBase<T> & {
  readonly kind: 'spawn';
  readonly resumeAgentId?: undefined;
  readonly binding?: { readonly model: string; readonly thinking?: string };
};

export type SessionSwarmResumeTask<T = unknown> = SessionSwarmTaskBase<T> & {
  readonly kind: 'resume';
  readonly resumeAgentId: string;
};

export type SessionSwarmTask<T = unknown> = SessionSwarmSpawnTask<T> | SessionSwarmResumeTask<T>;

export interface SessionSwarmRunArgs<T = unknown> {
  readonly callerAgentId: string;
  readonly tasks: readonly SessionSwarmTask<T>[];
  readonly onResult?: (result: SessionSwarmRunResult<T>) => void | Promise<void>;
}

export interface SessionSwarmRunResult<T = unknown> {
  readonly task: SessionSwarmTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
}

export interface SessionSwarmLaunchReceipt<T = unknown> {
  readonly batchId: string;
  readonly accepted: readonly SessionSwarmTask<T>[];
  readonly completion: Promise<readonly SessionSwarmRunResult<T>[]>;
}

export interface ISessionSwarmService {
  readonly _serviceBrand: undefined;

  getSwarmItem(args: {
    readonly callerAgentId: string;
    readonly agentId: string;
  }): Promise<string | undefined>;
  launch<T>(args: SessionSwarmRunArgs<T>): SessionSwarmLaunchReceipt<T>;
  run<T>(args: SessionSwarmRunArgs<T>): Promise<readonly SessionSwarmRunResult<T>[]>;
  cancel(args: { readonly callerAgentId: string }): void;
  settle(): Promise<void>;
}

export const ISessionSwarmService: ServiceIdentifier<ISessionSwarmService> =
  createDecorator<ISessionSwarmService>('sessionSwarmService');
