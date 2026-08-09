# Desktop Workspace 切换竞态修复设计

## 背景

`apps/desktop/src/electron/runtime.ts` 的 workspace watcher 和 `openWorkspace` 都会启动异步刷新。当前刷新完成后直接写入运行时状态；如果用户在刷新期间切换 workspace，旧 workspace 的结果可能覆盖新 workspace 的 `workspace/tree/gitFiles`，并发送错误的 `workspace.changed` 通知。

现有 Desktop 测试全部通过，但没有覆盖 workspace 切换与异步刷新并发场景。

## 目标与非目标

目标：

- 防止过期 workspace 刷新结果写入当前运行时状态。
- 防止过期刷新发送 `workspace.changed` 通知。
- 保留现有 180ms watcher debounce、路径聚合排序、session 恢复、remember/publish 选项和 watcher 生命周期行为。
- 增加可稳定复现的并发回归测试。

非目标：

- 不改变 IPC 命令、快照字段或通知协议。
- 不重写 workspace 全量扫描或 Git 状态读取逻辑。
- 不处理与该竞态无关的 Monaco 性能和 CI 覆盖问题。

## 设计

在 `KimiDesktopRuntime` 中增加 workspace generation（生命周期版本号）。每次开始新的 workspace 生命周期（打开目标 workspace、清理当前 workspace）时递增版本。

异步操作捕获开始时的 `root` 与 generation。刷新数据完成后，提交状态前检查捕获值仍与当前 runtime 的 root 和 generation 匹配；不匹配时丢弃结果并不发送通知。

具体流程：

1. `openWorkspace` 在解析并确认目标目录有效后开始新的 generation。目标 workspace 的目录、trust、sessions 加载都绑定该 generation。
2. 在异步加载完成后、提交 `workspaceRoot` 和其他快照字段前检查 generation/root。若期间发生了另一次打开或清理，当前调用直接结束，不执行旧的提交和后续副作用。
3. `refreshWorkspace` 捕获当前 root/generation；`refreshWorkspace(root)` 与 trust 信息完成后再次检查。只有检查通过才写入 `workspace/tree/gitFiles` 并调用 `host.notify`。
4. watcher 调度保留现有 debounce 和 pending path 聚合，将调度时的 root/generation 传入刷新回调；timer 回调和刷新提交处都进行有效性检查。
5. `clearWorkspaceState` 递增 generation，使清理前启动的刷新、扩展或 session 恢复流程失效；现有清理逻辑继续负责关闭 watcher、session runtime 和清空状态。

建议将 root/generation 判断抽成小型纯 helper（例如 `isCurrentWorkspace`），便于单元测试并避免在异步分支中重复编写条件。

## 错误处理

- 过期任务是正常的竞态结果，静默丢弃，不调用 `publishError`。
- 当前 workspace 的真实刷新失败继续沿用现有错误处理，由调用方按 `workspace.watch` 或对应操作上下文发布错误。
- 清理和 watcher 关闭行为保持现状。

## 测试

在现有 `apps/desktop/src/electron/runtime.test.ts` 中增加 guard 单测，覆盖 root/generation 匹配、root 不匹配和 generation 过期。

增加 workspace 并发回归测试：使用可控 Promise 延迟 A workspace 的刷新，启动切换到 B，完成 A 的旧刷新，再完成 B 的刷新；断言最终 snapshot 的 workspace、tree、gitFiles 属于 B，且没有由 A 旧结果产生的 `workspace.changed` 通知。测试应同时覆盖 watcher refresh 或等价的 refresh 提交路径，并保持现有测试命令可运行：

```text
pnpm --filter @moonshot-ai/kimi-code-desktop test
```

## 验收标准

- A→B 切换期间，A 的异步结果不能修改当前状态或发出 workspace.changed。
- 现有 Desktop 测试全部通过，新增并发回归测试稳定通过。
- 不改变公开 IPC/快照契约，且 diff 仅包含竞态防护、必要测试和本设计文档。
