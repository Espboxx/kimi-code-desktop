# Kimi Code Desktop

Private Electron/React host for the Kimi Code v2 engine. The Electron main
process owns one application-lifetime `createKimiHarnessV2` instance and a
runtime for every active session. The sandboxed renderer uses the validated
`window.kimiDesktop` bridge and never receives OAuth tokens, API keys, raw
configuration secrets, or direct filesystem access.

The desktop workbench provides the workspace tree, persisted Kimi sessions,
the transcript timeline, native subagent and swarm activity, plan and goal
state, background tasks, context controls, Git changes, a session shell,
extensions, MCP management, authentication, configuration, and diagnostics.
It consumes `@moonshot-ai/kimi-code-sdk` and `@moonshot-ai/transcript`; it does
not embed `dist-web` or import `agent-core-v2` directly.

## Workbench

The central editor group keeps session, workspace file, and Git diff tabs in a
single MRU list. Workspace files use the locally bundled Monaco Editor with
manual save, search, undo, theme synchronization, and persisted tab/view state.
Use `Ctrl+S` to save, `Ctrl+W` to close the active tab, and `Ctrl+Tab` to move
through recent tabs. Closing a dirty tab or the application requires an
explicit save, discard, or cancel decision.

Explorer decorations aggregate Git state through directories. The Changes
panel separates merge, staged, and working-tree changes and preserves the
directory hierarchy. Opening a staged entry compares `HEAD` to the index;
opening a working entry compares the index to the worktree. The raw patch view
remains available from each change row.

Editing is limited to existing UTF-8 regular files inside the workspace, up to
2 MiB. Symlinks, path traversal, binary files, and oversized files are read
only. Saves use optimistic content versions and atomic replacement; external
changes reload clean tabs or surface an explicit conflict for dirty tabs.

## Run

Use Node.js 24.15.0 from the repository root:

```powershell
fnm exec --using=24.15.0 -- pnpm install
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop build
$env:KIMI_DESKTOP_WORKSPACE = 'D:\path\to\workspace'
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop start
```

`KIMI_CODE_HOME` selects an isolated Kimi Code state directory. Existing
sessions retain their own model and mode settings; current global settings are
used only as defaults for new sessions. If a configuration contains models but
has no default pointer, Desktop selects the first configured model so a new
session is immediately usable.

## Validate

```powershell
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop test
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop typecheck
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop build
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop e2e
```

The Electron test uses isolated workspace and home directories plus local
fixtures. Screenshots are written under `apps/desktop/output/playwright/` at the
default and minimum supported window sizes.
