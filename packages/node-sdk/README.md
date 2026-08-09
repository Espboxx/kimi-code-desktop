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

## License

MIT
