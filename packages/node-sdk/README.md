# @moonshot-ai/kimi-code-sdk

The TypeScript SDK for Kimi Code

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo.

See the main repository for documentation, issues, and contribution guidelines.

## Session lifecycle

`createKimiHarnessV2` owns the v2 engine and may keep multiple sessions active.
Close the harness during host shutdown so sessions, background work, and
engine resources are released.

```ts
import { createKimiHarnessV2 } from '@moonshot-ai/kimi-code-sdk';

const harness = createKimiHarnessV2({ homeDir: '.kimi-code' });
const session = await harness.createSession({ workDir: process.cwd() });

const fullFork = await harness.forkSession({ id: session.id });
const historicalFork = await harness.forkSession({
  id: session.id,
  turnIndex: 2,
  title: 'Alternative after turn 3',
});

await fullFork.close();
await historicalFork.close();
await harness.deleteSession(session.id);
await harness.close();
```

`turnIndex` is zero-based and retains the selected user-visible turn. A
historical fork rejects an active source turn or an out-of-range index. It
truncates the persisted conversation and session-owned subagent, background
task, and cron state after the cutoff. `deleteSession` closes an active session
before deleting its persisted v2 lifecycle state.

## Session TodoList

V2 sessions expose the shared TodoList used by the built-in `TodoList` tool.
Updates are persisted with the session and observed regardless of which Agent
changed the list.

```ts
const unsubscribe = session.onTodosChanged((todos) => {
  console.log(todos);
});

await session.setTodos([
  { title: 'Inspect the implementation', status: 'in_progress' },
  { title: 'Run the focused tests', status: 'pending' },
]);

console.log(await session.getTodos());
unsubscribe();
```

`getTodos`, `setTodos`, and `onTodosChanged` require the v2 engine.

## Team collaboration

V2 sessions expose the experimental Team Mode collaboration log separately
from per-Agent transcript events. Enable it before creating the harness with
`KIMI_CODE_EXPERIMENTAL_TEAM_COLLABORATION=1`. A Team is created by the first
Swarm launch in that session.

```ts
const stop = session.onTeamOperation((operation) => {
  console.log(operation.seq, operation.type);
});

const snapshot = await session.getTeamSnapshot();
const recentMessages = await session.getTeamHistory({ limit: 100 });
const missedOperations = await session.getTeamOperations({
  afterSeq: snapshot.latestSeq,
  limit: 200,
});

await session.sendTeamMessage({
  body: 'Please verify the failing tests before merging.',
  clientMessageId: crypto.randomUUID(),
});

stop();
```

`clientMessageId` is an idempotency key and must be reused when retrying the
same send. Team operations use a session-global sequence; consumers should
catch up with `getTeamOperations()` after a gap and reset from
`getTeamSnapshot()` plus `getTeamHistory()` when the gap cannot be filled.
These methods require the v2 engine and an enabled Team Mode flag.

## License

MIT
