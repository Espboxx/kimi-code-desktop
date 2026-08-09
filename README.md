# Kimi Code Desktop

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.en.md) · [第三方许可证](apps/desktop/THIRD_PARTY_NOTICES.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)

> [!IMPORTANT]
> 本项目是基于上游 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 修改的**非官方衍生项目**，不是 Moonshot AI 官方发行版，也不代表 Moonshot AI 的认可或背书。详见 [NOTICE.md](NOTICE.md)。

Kimi Code Desktop 是一个 Windows 优先的 Electron 桌面工作台，把 Kimi Code 的 Agent 会话、代码编辑、Git 状态、任务面板和多 Agent 协作放进同一个原生窗口。仓库同时保留上游 CLI、SDK 和引擎包；当前首页以 Desktop 产品为主。

## 界面预览

### 首次启动

![Kimi Code Desktop 工作区欢迎页](docs/media/desktop-workspace-welcome.png)

### 完整工作台

![Kimi Code Desktop 完整工作台](docs/media/desktop-workbench.png)

截图由隔离的本地 E2E fixture 生成，已移除本机路径、真实会话和凭据信息。

## 主要功能

- **会话工作台**：持久化 Kimi 会话、流式对话时间线、审批与提问、上下文状态、Plan、Goal、TodoList 和后台任务集中展示。
- **代码与 Git**：工作区文件树、Git 状态聚合、Git diff 标签页，以及内置 Monaco Editor；支持保存、搜索、撤销和脏文件关闭确认。
- **Agent 可观测性**：查看主 Agent、子 Agent、Swarm 的运行、完成、失败和交互状态。
- **Team Mode**：实验性的会话级团队频道、成员状态、嵌套任务、未读计数和实时协作消息。
- **配置与扩展**：在 Desktop 内管理登录、模型、MCP、Skills、Plugins、诊断和工作区信任。
- **安全边界**：渲染进程启用 sandbox 和 context isolation，只能通过经过校验的 `window.kimiDesktop` IPC 调用主进程能力。

## 下载与运行

Windows x64 便携版由 `desktop-v*` 标签触发的 GitHub Actions 构建。前往本仓库的 [GitHub Releases](../../releases)，下载：

- `Kimi-Code-Desktop-0.1.1-x64-portable.exe`
- `Kimi-Code-Desktop-0.1.1-x64-portable.exe.sha256`

下载后可在 PowerShell 校验 SHA256：

```powershell
$exe = ".\Kimi-Code-Desktop-0.1.1-x64-portable.exe"
$expected = (Get-Content "$exe.sha256").Split()[0]
$actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$actual -eq $expected
```

返回 `True` 后直接运行 EXE，无需预装 Node.js 或 pnpm。

当前自动构建默认**不做代码签名**，Windows SmartScreen 可能在首次运行时显示提示。请先核对下载来源和 SHA256；后续取得代码签名证书后会单独接入发布流程。

## 首次选择工作区

首次启动时 Desktop 不会自动扫描磁盘，而是停留在欢迎页：

1. 点击“选择工作区”。
2. 选择一个已有项目目录。
3. Desktop 加载文件、Git 状态和该工作区的会话。

选择结果保存在本地并在下次启动时恢复；如果目录已被移动或删除，应用会安全回到欢迎页。`KIMI_DESKTOP_WORKSPACE` 仅用于需要显式覆盖启动目录的开发或自动化场景。

## 实验性 Team Mode

Team Mode 默认关闭。在启动 Desktop 前设置实验开关：

```powershell
$env:KIMI_CODE_EXPERIMENTAL_TEAM_COLLABORATION = "1"
& ".\Kimi-Code-Desktop-0.1.1-x64-portable.exe"
```

首次进入 Session Swarm 后会创建会话级 Team 和 `general` 频道。Agent 可通过 `TeamSend`、`TeamStatus` 和 `TeamWait` 协作；团队日志与普通对话时间线分开恢复。该功能仍处于实验阶段，数据格式和交互可能调整。

## 架构边界

```text
Sandboxed React renderer
        │ validated window.kimiDesktop IPC
        ▼
Electron preload + main process
        │ public @moonshot-ai/kimi-code-sdk
        ▼
Kimi harness / session runtime / workspace filesystem
```

- Electron 主进程持有应用级 Kimi harness、会话 runtime、文件系统和原生窗口能力。
- preload 只暴露经过命令 schema 校验的 IPC；渲染进程没有 Node.js、文件系统或原始密钥访问权。
- Desktop 通过公开的 `@moonshot-ai/kimi-code-sdk` 和 `@moonshot-ai/transcript` 使用核心能力，不直接依赖引擎内部 API。
- 本仓库不再包含浏览器 Web UI 源码；上游 Web bundle 的同步方式见根目录 [AGENTS.md](AGENTS.md)。

## 核心开源组件

本项目建立在以下开源项目之上：

- [Kimi Code](https://github.com/MoonshotAI/kimi-code)
- [Electron](https://github.com/electron/electron)
- [React](https://react.dev/)
- [Monaco Editor](https://github.com/microsoft/monaco-editor)
- [TanStack Virtual](https://tanstack.com/virtual)
- [React Markdown](https://github.com/remarkjs/react-markdown)
- [Chokidar](https://github.com/paulmillr/chokidar)
- [Lucide](https://lucide.dev/)
- [Zod](https://zod.dev/)
- [Vite](https://vite.dev/)、[Vitest](https://vitest.dev/) 和 [Playwright](https://playwright.dev/)
- [tsdown](https://tsdown.dev/) 和 [electron-builder](https://github.com/electron-userland/electron-builder)

完整的 Desktop 生产依赖版本、SPDX 表达式、主页和许可证正文见 [`apps/desktop/THIRD_PARTY_NOTICES.md`](apps/desktop/THIRD_PARTY_NOTICES.md)。Windows 包同时携带仓库 MIT License、项目 NOTICE、第三方清单，以及 Electron 自带的 Electron/Chromium 许可证文件。

## 从源码构建

环境要求：Windows、Node.js `>=24.15.0`（推荐 `.nvmrc` 中的版本）、pnpm `10.33.0`、Git。

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

生成未打包目录或便携 EXE：

```powershell
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop pack:win
fnm exec --using=24.15.0 -- pnpm --filter @moonshot-ai/kimi-code-desktop dist:win
```

依赖变化后运行 `licenses:generate` 更新第三方清单；`pack:win` 和 `dist:win` 会先执行 `licenses:check`，清单陈旧时直接失败。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `apps/desktop` | Electron 主进程、preload、React 渲染器、E2E 与 Windows 打包配置 |
| `apps/kimi-code` | 保留的 Kimi Code CLI / TUI 应用 |
| `packages/node-sdk` | Desktop 使用的公开 Node SDK |
| `packages/transcript` | 与引擎解耦的 transcript 数据层 |
| `packages/agent-core-v2` | Desktop SDK 背后的 DI × Scope Agent 引擎 |
| `packages/kap-server` / `packages/klient` | 服务端与契约驱动客户端能力 |

## 贡献与安全

提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，保持改动聚焦，并运行相关测试、类型检查和许可证检查。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

## 许可证与归属

上游代码及本项目修改继续采用 [MIT License](LICENSE)。根 `LICENSE` 保留上游版权原文；第三方依赖按各自许可证分发。项目归属、非官方声明和商标说明见 [NOTICE.md](NOTICE.md)。
