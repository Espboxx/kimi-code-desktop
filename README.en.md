# Kimi Code Desktop

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[简体中文](README.md) · [Third-party licenses](apps/desktop/THIRD_PARTY_NOTICES.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> [!IMPORTANT]
> This is an **unofficial derivative project** based on the upstream [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) repository. It is not an official Moonshot AI distribution and does not imply endorsement by Moonshot AI. See [NOTICE.md](NOTICE.md).

Kimi Code Desktop is a Windows-first Electron workbench that brings Kimi Code agent sessions, code editing, Git state, task panels, and multi-agent collaboration into one native window. The monorepo still contains the upstream CLI, SDK, and engine packages; this homepage focuses on the Desktop product.

## Screenshots

### First launch

![Kimi Code Desktop workspace welcome page](docs/media/desktop-workspace-welcome.png)

### Full workbench

![Kimi Code Desktop full workbench](docs/media/desktop-workbench.png)

### Dedicated Team workbench

![Kimi Code Desktop dedicated Team workbench](docs/media/desktop-team-workbench.png)

These screenshots are generated from an isolated local E2E fixture and contain no machine-specific path, real session, or credential data.

## Highlights

- **Session workbench:** persisted Kimi sessions, streaming transcripts, approvals and questions, context status, Plan, Goal, TodoList, and background tasks in one view.
- **Code and Git:** a workspace tree, aggregated Git decorations, Git diff tabs, and a bundled Monaco Editor with save, search, undo, and dirty-file close protection.
- **Agent observability:** inspect running, completed, failed, and interactive states for the main agent, subagents, and parallel tasks.
- **Dedicated Team workbench:** manage multi-agent tasks, named members, profession-based assignments, unread messages, and agent details in a top-level Team surface. The channel uses distinct user/agent bubbles with Markdown line breaks and clickable `@mentions`.
- **Configuration and extensions:** manage authentication, models, MCP, Skills, Plugins, diagnostics, and workspace trust inside Desktop.
- **Security boundary:** the renderer runs with sandbox and context isolation and can reach native capabilities only through the validated `window.kimiDesktop` IPC bridge.

## Download and run

The `desktop-v*` GitHub Actions workflow builds a portable Windows x64 executable. Open this repository's [GitHub Releases](../../releases) page and download:

- `Kimi-Code-Desktop-0.3.1-x64-portable.exe`
- `Kimi-Code-Desktop-0.3.1-x64-portable.exe.sha256`

Verify the SHA256 checksum in PowerShell:

```powershell
$exe = ".\Kimi-Code-Desktop-0.3.1-x64-portable.exe"
$expected = (Get-Content "$exe.sha256").Split()[0]
$actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$actual -eq $expected
```

After the command returns `True`, run the EXE directly. The target machine does not need Node.js or pnpm.

Automated builds are **unsigned by default**, so Windows SmartScreen may show a warning on first launch. Verify the release source and SHA256 before running it. Code signing can be added separately when a certificate is available.

## Choose a workspace on first launch

Desktop does not scan your drives automatically. A fresh installation stays on the welcome page until you:

1. Select **Choose workspace**.
2. Pick an existing project directory.
3. Let Desktop load its files, Git state, and Kimi sessions.

The selection is stored locally and restored at the next launch. If the directory is moved or removed, Desktop safely returns to the welcome page. `KIMI_DESKTOP_WORKSPACE` is intended only for development or automation that needs an explicit startup override.

## Dedicated Team workbench

Team is a first-class top-level Desktop surface and does not require a manual experimental flag:

1. Select **Team** in the window header.
2. Select **New team task** and describe the objective, constraints, and acceptance criteria.
3. Keep the current default permission or use YOLO for that task only.
4. Follow progress in `general`; select a member or assignment to open that agent's details.

Each team task uses its own persisted session. Posting a channel message actively wakes the leader: an idle leader starts a collaboration turn, while a busy leader receives a steer update. The leader selects a profession such as `explore` or `coder` independently for each task and gives every new Agent a persistent display name. When no existing profession fits, the leader can create an approval-gated, reusable project profile with `AgentProfileCreate`, or explicitly select user scope for a profile shared across workspaces.

Channel messages use bounded-height bubbles, with long content scrolling inside the bubble. Single line breaks are preserved, and highlighted `@display-name` or `@agent-id` mentions open the corresponding Agent. Members share progress, blockers, and handoffs through `TeamSend`, `TeamStatus`, and `TeamWait`. File-operation records still open the target file, while edits open a before/after diff. Sessions containing Team data from earlier versions migrate safely when resumed.

## Architecture boundary

```text
Sandboxed React renderer
        │ validated window.kimiDesktop IPC
        ▼
Electron preload + main process
        │ public @moonshot-ai/kimi-code-sdk
        ▼
Kimi harness / session runtime / workspace filesystem
```

- The Electron main process owns the application Kimi harness, session runtimes, filesystem access, and native windows.
- The preload exposes only schema-validated IPC. The renderer has no Node.js, direct filesystem, or raw credential access.
- Desktop consumes core behavior through the public `@moonshot-ai/kimi-code-sdk` and `@moonshot-ai/transcript` packages rather than engine-internal APIs.
- The browser Web UI source no longer lives in this repository. See the root [AGENTS.md](AGENTS.md) for the upstream bundle sync boundary.

## Core open-source components

The project builds on these open-source components:

- [Kimi Code](https://github.com/MoonshotAI/kimi-code)
- [Electron](https://github.com/electron/electron)
- [React](https://react.dev/)
- [Monaco Editor](https://github.com/microsoft/monaco-editor)
- [TanStack Virtual](https://tanstack.com/virtual)
- [React Markdown](https://github.com/remarkjs/react-markdown)
- [Chokidar](https://github.com/paulmillr/chokidar)
- [Lucide](https://lucide.dev/)
- [Zod](https://zod.dev/)
- [Vite](https://vite.dev/), [Vitest](https://vitest.dev/), and [Playwright](https://playwright.dev/)
- [tsdown](https://tsdown.dev/) and [electron-builder](https://github.com/electron-userland/electron-builder)

See [`apps/desktop/THIRD_PARTY_NOTICES.md`](apps/desktop/THIRD_PARTY_NOTICES.md) for the complete Desktop production dependency versions, SPDX expressions, homepages, and license texts. Windows packages also include the repository MIT License, project NOTICE, this inventory, and Electron's Electron/Chromium license files.

## Build from source

Requirements: Windows, Node.js `>=24.15.0` (the `.nvmrc` version is recommended), pnpm `10.33.0`, and Git.

```powershell
git clone <repository-url>
cd <repository-directory>
fnm exec --using=24.15.0 -- pnpm install --frozen-lockfile
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop licenses:check
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop test
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop typecheck
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop build
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop start
```

Create an unpacked directory or the portable EXE:

```powershell
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop pack:win
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop dist:win
```

Run `licenses:generate` after dependency changes. Both `pack:win` and `dist:win` run `licenses:check` first and fail when the inventory is stale.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Electron main process, preload, React renderer, E2E, and Windows packaging |
| `apps/kimi-code` | The retained Kimi Code CLI / TUI application |
| `packages/node-sdk` | The public Node SDK consumed by Desktop |
| `packages/transcript` | Engine-independent transcript data layer |
| `packages/agent-core-v2` | The DI × Scope agent engine behind the Desktop SDK |
| `packages/kap-server` / `packages/klient` | Server and contract-driven client capabilities |

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Keep changes focused and run the relevant tests, typecheck, and license check. Report security issues privately through [SECURITY.md](SECURITY.md), not in a public issue.

## Sponsor

Thanks to [CodeProxy](https://codeproxy.dev/) for supporting the development and open-source release of this project.

[![CodeProxy website](docs/media/codeproxy-sponsor.png)](https://codeproxy.dev/)

## License and attribution

Upstream code and this project's modifications remain available under the [MIT License](LICENSE). The root `LICENSE` preserves the upstream copyright text; third-party dependencies retain their respective licenses. See [NOTICE.md](NOTICE.md) for attribution, unofficial-project status, and trademark information.
