# Kimi Code Desktop

Windows-first Electron/React host for the Kimi Code v2 engine. This is part of
the unofficial derivative project described in the root [README](../../README.en.md)
and [NOTICE](../../NOTICE.md). The Electron main
process owns one application-lifetime `createKimiHarnessV2` instance and a
runtime for every active session. The sandboxed renderer uses the validated
`window.kimiDesktop` bridge and never receives OAuth tokens, API keys, raw
configuration secrets, or direct filesystem access.

The desktop workbench provides the workspace tree, persisted Kimi sessions,
the transcript timeline, native subagent and swarm activity, plan and goal
state, a fixed TodoList, background tasks, context controls, Team channels,
extensions, MCP management, authentication, configuration, and diagnostics.
It consumes `@moonshot-ai/kimi-code-sdk` and `@moonshot-ai/transcript`; it does
not embed `dist-web` or import `agent-core-v2` directly.

## Workbench

The central editor group keeps session, workspace file, Git diff, and Team tabs in a
single MRU list. Workspace files use the locally bundled Monaco Editor with
manual save, search, undo, theme synchronization, and persisted tab/view state.
Use `Ctrl+S` to save, `Ctrl+W` to close the active tab, and `Ctrl+Tab` to move
through recent tabs. Closing a dirty tab or the application requires an
explicit save, discard, or cancel decision.

Explorer decorations aggregate Git state through directories. The former
bottom Changes, raw Diff, Session Shell, and Events panel is not mounted; Git
diff tabs saved by earlier builds can still be restored.

Editing is limited to existing UTF-8 regular files inside the workspace, up to
2 MiB. Symlinks, path traversal, binary files, and oversized files are read
only. Saves use optimistic content versions and atomic replacement; external
changes reload clean tabs or surface an explicit conflict for dirty tabs.

## Experimental Team Mode

Set `KIMI_CODE_EXPERIMENTAL_TEAM_COLLABORATION=1` before launching Desktop to
enable session-scoped Team collaboration. The first Swarm creates one Team and
the `general` channel. Its Team tab opens in the background, shows live members,
messages, nested assignments, unread counts, and running or failed badges, and
does not steal focus from an editor or conversation. Closing the tab only
closes the view.

In Team Mode, `AgentSwarm` launches work without blocking the leader. Agents
coordinate through `TeamSend`, inspect work through `TeamStatus`, and wait
without polling through `TeamWait`. User messages sent from the Team page keep
the same idempotency key when retried after a failure. Team data is restored
from its session log and remains separate from the transcript replica.

## Run

Use Node.js 24.15.0 from the repository root:

```powershell
fnm exec --using=24.15.0 -- pnpm install
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop build
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop start
```

On the first launch Desktop shows a welcome page and waits for the user to
choose a workspace. A successful selection is remembered and restored on the
next launch; a missing remembered directory falls back to the welcome page.
Set `KIMI_DESKTOP_WORKSPACE` only when an explicit startup override is needed.

`KIMI_CODE_HOME` selects an isolated Kimi Code state directory. Existing
sessions retain their own model and mode settings; current global settings are
used only as defaults for new sessions. If a configuration contains models but
has no default pointer, Desktop selects the first configured model so a new
session is immediately usable.

## Validate

```powershell
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop test
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop typecheck
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop licenses:check
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop build
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop e2e
```

The Electron test uses isolated workspace and home directories plus local
fixtures. Screenshots are written under `apps/desktop/output/playwright/` at the
default and minimum supported window sizes.

## Package for Windows

Build a self-contained x64 portable executable that does not require Node.js or
pnpm on the target computer:

```powershell
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop dist:win
```

The distributable is written to
`apps/desktop/release/Kimi-Code-Desktop-<version>-x64-portable.exe`. Use
`pack:win` to produce an unpacked directory for local smoke testing without
creating the portable archive. Both commands reject a stale
`THIRD_PARTY_NOTICES.md`; regenerate it with `licenses:generate` after changing
runtime dependencies.

Windows builds are unsigned by default, so SmartScreen may prompt on first
launch. Packaged resources include the repository MIT License, project NOTICE,
and the generated third-party notice inventory. Electron's own `LICENSE.electron.txt` and
`LICENSES.chromium.html` remain in the distribution root.
