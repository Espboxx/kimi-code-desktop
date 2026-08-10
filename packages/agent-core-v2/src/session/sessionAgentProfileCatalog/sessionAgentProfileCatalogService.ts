/**
 * `sessionAgentProfileCatalog` domain — `ISessionAgentProfileCatalog`
 * implementation.
 *
 * Projects the App-scope `IAgentProfileRegistry` into this session's merged
 * profile view. The relevant entries are the global ones (builtin) plus the
 * ones tagged with the seeded workspace key (user / plugin / extra /
 * workspace / explicit); they are re-merged on every registry change (the
 * projection is a cheap full recompute — merge, never incremental patching).
 * Merge rules, applied per profile name: candidates are collected from every
 * relevant entry (deduped within an entry, highest priority first); the first
 * candidate wins, except that replacing a same-name `builtin` profile
 * requires `override: true` in the frontmatter — a non-override collision is
 * warned about and skipped to the next candidate. `ready` resolves
 * immediately: the registry is already populated when this service is
 * constructed, and every later change arrives through `onDidChange`. Bound at
 * Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { BugIndicatingError } from '#/errors';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  IAgentProfileRegistry,
  type AgentProfileRegistration,
} from '#/app/agentProfileCatalog/agentProfileRegistry';
import { projectAgentProfiles } from '#/app/agentProfileCatalog/profileProjection';

import { ISessionAgentProfileCatalogSeed } from './agentProfileCatalogSeed';
import {
  ISessionAgentProfileCatalog,
  type AgentProfileInspection,
} from './sessionAgentProfileCatalog';

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class SessionAgentProfileCatalogService
  extends Disposable
  implements ISessionAgentProfileCatalog
{
  declare readonly _serviceBrand: undefined;

  private merged = new Map<string, AgentProfile>();
  private inspections = new Map<string, AgentProfileInspection>();
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  constructor(
    @IAgentProfileRegistry private readonly registry: IAgentProfileRegistry,
    @ISessionAgentProfileCatalogSeed private readonly seed: ISessionAgentProfileCatalogSeed,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.reproject();
    this._register(
      this.registry.onDidChange((change) => {
        if (change.workspaceKey !== undefined && change.workspaceKey !== this.seed.workspaceKey) {
          return;
        }
        this.reproject();
        this.onDidChangeEmitter.fire(change.sourceId);
      }),
    );
  }

  get ready(): Promise<void> {
    return Promise.resolve();
  }

  get(name: string): AgentProfile | undefined {
    return this.merged.get(name);
  }

  getDefault(): AgentProfile {
    const profile = this.get(DEFAULT_AGENT_PROFILE_NAME);
    if (profile === undefined) {
      throw new BugIndicatingError(
        `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
      );
    }
    return profile;
  }

  list(): readonly AgentProfile[] {
    return [...this.merged.values()];
  }

  inspect(name: string): AgentProfileInspection | undefined {
    return this.inspections.get(name);
  }

  async load(): Promise<void> {
    await this.ready;
  }

  async reload(): Promise<void> {
    await this.ready;
    this.reproject();
    this.onDidChangeEmitter.fire('catalog');
  }

  private relevantEntries(): AgentProfileRegistration[] {
    const key = this.seed.workspaceKey;
    return this.registry
      .entries()
      .filter((e) => e.workspaceKey === undefined || e.workspaceKey === key);
  }

  private reproject(): void {
    const projection = projectAgentProfiles(this.relevantEntries(), (message) => {
      this.log.warn(message);
    });
    this.merged = new Map(projection.profiles);
    this.inspections = new Map(projection.inspections);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAgentProfileCatalog,
  SessionAgentProfileCatalogService,
  ScopeActivation.OnScopeCreated,
  'sessionAgentProfileCatalog',
);
