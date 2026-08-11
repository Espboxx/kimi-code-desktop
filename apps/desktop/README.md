# Kimi Code Desktop

Cross-platform Electron/React host for the Kimi Code v2 engine, released for
Windows x64, macOS arm64, and Linux x64. This is part of
the unofficial derivative project described in the root [README](../../README.en.md)
and [NOTICE](../../NOTICE.md). The Electron main
process owns one application-lifetime `createKimiHarnessV2` instance and a
runtime for every active session. The sandboxed renderer uses the validated
`window.kimiDesktop` bridge and never receives OAuth tokens, API keys, raw
configuration secrets, or direct filesystem access.

The desktop workbench provides the workspace tree, persisted Kimi sessions,
the transcript timeline, native subagent and parallel-agent activity, plan and goal
state, a fixed TodoList, background tasks, context controls, Team channels,
extensions, MCP management, authentication, configuration, and diagnostics.
It consumes `@moonshot-ai/kimi-code-sdk` and `@moonshot-ai/transcript`; it does
not embed `dist-web` or import `agent-core-v2` directly.

## Workbenches

The header separates normal Sessions from the dedicated Team workbench. Each
surface keeps its own visible MRU tabs, while file and diff tabs stay with the
surface that opened them. Workspace files use the locally bundled Monaco Editor with
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

## Team workbench

Select **Team** in the header and create a task with an objective plus either the
current default permission or YOLO. Desktop enables the underlying collaboration
capability, creates the Team and `general` channel immediately, and persists the
session as a Team task. The left column lists Team tasks, the center owns channel,
agent, file, and diff tabs, and the right column shows members and nested assignments.

Posting a Team message uses an idempotency key and wakes the leader through a
collaboration turn when idle or a steer update when busy. The channel renders
bounded-height user/Agent bubbles, Markdown single-line breaks, and highlighted,
clickable mentions. The leader gives every new member a persistent display name
and selects a profession independently per assignment. If the catalog has no
suitable profession, the approval-gated `AgentProfileCreate` tool writes and loads
a reusable workspace profile (or an explicitly requested user profile). Agent
coordination uses `TeamSend`, `TeamStatus`, and `TeamWait`; the leader prompt calls
for independent delegation, progress sharing, blocker escalation, and a final
handoff. Existing sessions with Team data are marked as Team sessions when resumed,
without changing normal Chat sessions.

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

## Package by target

Build the package on its target operating system. Each result is self-contained
and does not require Node.js or pnpm on the target computer:

```powershell
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop dist:win
```

```bash
pnpm --filter @moonshot-ai/kimi-code-desktop dist:mac
pnpm --filter @moonshot-ai/kimi-code-desktop dist:linux
```

The outputs are written under `apps/desktop/release/`:

- Windows x64: `Kimi-Code-Desktop-<version>-x64-portable.exe`
- macOS arm64: `Kimi-Code-Desktop-<version>-arm64.dmg`
- Linux x64: `Kimi-Code-Desktop-<version>-x64.AppImage` and `Kimi-Code-Desktop-<version>-x64.deb`

Use `pack:win`, `pack:mac`, or `pack:linux` to produce an unpacked directory
for target-native smoke testing without creating the distributable archive.
All commands reject a stale
`THIRD_PARTY_NOTICES.md`; regenerate it with `licenses:generate` after changing
runtime dependencies.

Windows and macOS builds are unsigned by default. The macOS package explicitly
uses `identity: null` and disables hardened runtime until Developer ID signing
and notarization are configured. Packaged resources include the repository MIT
License, project NOTICE, generated third-party inventory, Electron license, and
Chromium license. The external `node-pty` production dependency and its native
binary are unpacked from ASAR and checked by the packaged smoke.
