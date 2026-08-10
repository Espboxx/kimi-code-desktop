// Scenario: Desktop end-to-end product flows across sessions, transcripts, files, teams, and lifecycle actions.
// Responsibilities: validate user-observable Electron behavior against isolated local provider and workspace fixtures.
// Wiring: real Electron main/renderer with local mock OAuth, MCP, provider, plugin, and filesystem boundaries.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appDir, '..', '..');
const artifactDir = join(appDir, 'output', 'playwright');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'kimi-desktop-e2e-'));
const kimiHome = join(fixtureRoot, 'home');
const workspace = join(fixtureRoot, 'workspace');
const additionalDir = join(fixtureRoot, 'additional');
const pluginDir = join(fixtureRoot, 'fixture-plugin');
const electronProfile = join(fixtureRoot, 'electron-profile');
const firstLaunchProfile = join(fixtureRoot, 'first-launch-profile');
const exportPath = join(fixtureRoot, 'session-export.zip');
const samplePath = join(workspace, 'sample.txt');
const recordWritePath = join(workspace, 'record-write.txt');
const dualPath = join(workspace, 'dual.txt');
const nestedSourcePath = join(workspace, 'src', 'nested', 'source.ts');
const untrackedPath = join(workspace, 'src', 'new', 'untracked.txt');
const sampleImagePath = join(workspace, 'pixel.png');
const secondImagePath = join(workspace, 'pixel-2.png');
const oversizedImagePath = join(workspace, 'oversized.png');
const swarmOutputPath = join(workspace, 'swarm-alpha.txt');
const teamProfilePath = join(workspace, '.kimi-code', 'agents', 'fixture-researcher.md');
const providerToken = 'sk-desktop-e2e-boundary-secret';
const processLogs = [];
const pageErrors = [];
let firstApp;
let secondApp;
let bootstrapApp;
let provider;
let persistedComposerHeight;
let persistedTheme;
let secondarySessionId;
let teamSessionId;

try {
  await Promise.all([
    mkdir(kimiHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(additionalDir, { recursive: true }),
    mkdir(pluginDir, { recursive: true }),
    mkdir(artifactDir, { recursive: true }),
  ]);
  await prepareWorkspace();
  await preparePlugin();
  provider = await startProvider();
  await writeConfig(provider.baseUrl);

  const bootstrap = await launchDesktopWith({ profile: firstLaunchProfile });
  bootstrapApp = bootstrap.app;
  const bootstrapPage = bootstrap.page;
  await bootstrapPage.locator('.workspace-welcome').waitFor({ state: 'visible' });
  assert.equal(await bootstrapPage.locator('.workspace-welcome-action').innerText(), '选择工作区');
  assert.equal(await bootstrapPage.locator('.workbench').count(), 0, 'first launch must not enter a workspace');
  assert.equal(await bootstrapPage.locator('.sidebar').count(), 0, 'sidebar must stay hidden without a workspace');
  assert.equal(await bootstrapPage.locator('.inspector').count(), 0, 'inspector must stay hidden without a workspace');
  const emptyWorkspaceSnapshot = await bootstrapPage.evaluate(() => window.kimiDesktop.host.snapshot());
  assert.equal(emptyWorkspaceSnapshot.workspace.root, '');
  assert.deepEqual(emptyWorkspaceSnapshot.sessions, []);
  await auditWelcomeAndScreenshot(bootstrapApp, bootstrapPage, 1_620, 1_040, join(artifactDir, 'workspace-welcome-1620x1040.png'));
  await auditWelcomeAndScreenshot(bootstrapApp, bootstrapPage, 1_180, 760, join(artifactDir, 'workspace-welcome-1180x760.png'));
  assert.equal(await bootstrapPage.evaluate(async () => {
    try {
      await window.kimiDesktop.session.create();
      return false;
    } catch {
      return true;
    }
  }), true, 'session commands must be rejected until a workspace is selected');
  const noWorkspaceError = bootstrapPage.locator('.error-toast').filter({ hasText: 'workspace.not_selected' });
  await noWorkspaceError.waitFor({ state: 'visible' });
  await noWorkspaceError.getByTitle('关闭').click();

  await bootstrapPage.evaluate((path) => window.kimiDesktop.workspace.open(path), workspace);
  await bootstrapPage.waitForFunction(async (path) => (await window.kimiDesktop.host.snapshot()).workspace.root === path, workspace);
  await bootstrapPage.locator('.workbench').waitFor({ state: 'visible' });
  await stopDesktop(bootstrapApp);
  bootstrapApp = undefined;

  const restoredWorkspaceApp = await launchDesktopWith({ profile: firstLaunchProfile });
  bootstrapApp = restoredWorkspaceApp.app;
  await restoredWorkspaceApp.page.waitForFunction(async (path) => (await window.kimiDesktop.host.snapshot()).workspace.root === path, workspace);
  assert.equal(await restoredWorkspaceApp.page.locator('.workspace-welcome').count(), 0, 'remembered workspace should restore on restart');
  await stopDesktop(bootstrapApp);
  bootstrapApp = undefined;

  await writeFile(join(firstLaunchProfile, 'workspace-state.json'), `${JSON.stringify({
    version: 1,
    lastWorkspace: join(fixtureRoot, 'missing-workspace'),
  }, null, 2)}\n`, 'utf8');
  const missing = await launchDesktopWith({ profile: firstLaunchProfile });
  bootstrapApp = missing.app;
  await missing.page.locator('.workspace-welcome').waitFor({ state: 'visible' });
  assert.equal((await missing.page.evaluate(() => window.kimiDesktop.host.snapshot())).workspace.root, '');
  await stopDesktop(bootstrapApp);
  bootstrapApp = undefined;
  assert.deepEqual(JSON.parse(await readFile(join(firstLaunchProfile, 'workspace-state.json'), 'utf8')), { version: 1 });

  const first = await launchDesktop();
  firstApp = first.app;
  const page = first.page;
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  assert.ok(initialTheme === 'light' || initialTheme === 'dark', `unexpected initial theme: ${String(initialTheme)}`);
  const themeButton = page.locator('.top-actions').getByRole('button', { name: /切换到(?:深色|浅色)主题/ });
  assert.equal(await page.locator('.top-actions').getByTitle('设置', { exact: true }).count(), 1, 'settings must have exactly one gear button');
  await themeButton.click();
  persistedTheme = initialTheme === 'light' ? 'dark' : 'light';
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, persistedTheme);
  assert.equal(await page.evaluate(() => localStorage.getItem('kimi-desktop.theme.v1')), persistedTheme);
  await page.evaluate(() => window.kimiDesktop.workspace.trust());
  const sessionId = await page.evaluate(() => window.kimiDesktop.session.create({
    model: 'desktop-test',
    thinking: 'off',
    permission: 'manual',
  }));
  assert.equal(typeof sessionId, 'string');

  const composerControls = page.locator('.session-controls[data-placement="composer"]');
  assert.equal(await page.locator('.session-controls[data-placement="topbar"]').count(), 0, 'top session controls should be removed');
  await composerControls.waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.composer-modes button').allTextContents(), ['Prompt', 'Steer']);
  assert.equal(await page.locator('.composer-modes').getByTitle('Agent Swarm').count(), 0, 'one-shot Swarm should not be exposed');
  assert.equal(await composerControls.getByTitle('Session Swarm 模式').count(), 0, 'normal Chat must not expose Team/Swarm controls');
  const automaticTitle = 'Live title sync E2E';
  await submitPrompt(page, automaticTitle);
  await waitForAssistant(page, 'Desktop fixture response.');
  await page.waitForFunction(async ({ id, title }) => {
    const session = (await window.kimiDesktop.session.list()).find((item) => item.id === id);
    return session?.title === title
      && [...document.querySelectorAll('.session-row strong')].some((element) => element.textContent === title)
      && [...document.querySelectorAll('.workbench-tab')].some((element) => element.textContent?.includes(title));
  }, { id: sessionId, title: automaticTitle });
  await page.evaluate((id) => window.kimiDesktop.session.rename(id, 'Desktop E2E Session'), sessionId);
  await page.locator('.workbench-tab').filter({ hasText: 'Desktop E2E Session' }).waitFor({ state: 'visible' });

  const sessionsBeforeDelete = await page.evaluate(() => window.kimiDesktop.session.list().then((items) => items.map((item) => item.id)));
  await page.locator('.section-heading button[title="新建会话"]').click();
  await page.waitForFunction(async (known) => (await window.kimiDesktop.session.list()).some((item) => !known.includes(item.id)), sessionsBeforeDelete);
  const deletedSessionId = await page.evaluate(async (known) => (
    await window.kimiDesktop.session.list()
  ).find((item) => !known.includes(item.id))?.id, sessionsBeforeDelete);
  assert.equal(typeof deletedSessionId, 'string');
  await page.evaluate((id) => window.kimiDesktop.session.rename(id, 'Desktop Delete E2E'), deletedSessionId);
  const deletedSessionRow = page.locator('.session-row').filter({ hasText: 'Desktop Delete E2E' });
  await deletedSessionRow.waitFor({ state: 'visible' });
  await deletedSessionRow.getByTitle('永久删除').click();
  const deleteDialog = page.locator('.action-dialog').filter({ hasText: '永久删除会话' });
  await deleteDialog.waitFor({ state: 'visible' });
  await deleteDialog.getByRole('button', { name: '确认', exact: true }).click();
  await deletedSessionRow.waitFor({ state: 'hidden' });
  await page.locator('.workbench-tab').filter({ hasText: 'Desktop Delete E2E' }).waitFor({ state: 'hidden' });
  await page.locator('.workbench-tab.active').filter({ hasText: 'Desktop E2E Session' }).waitFor({ state: 'visible' });
  await page.waitForFunction(async (id) => (await window.kimiDesktop.host.snapshot()).activeSessionId === id, sessionId);
  assert.equal(await page.locator('.editor-state').filter({ hasText: '正在恢复会话' }).count(), 0);
  assert.equal(await page.locator('.error-toast').filter({ hasText: 'session.resume_failed' }).count(), 0);
  assert.equal(await page.evaluate((id) => Object.values(localStorage).some((value) => value.includes(id)), deletedSessionId), false);

  const todoPanel = page.locator('.todo-fixed-panel');
  await todoPanel.waitFor({ state: 'visible' });
  assert.match(await page.locator('.inspector-tabs').innerText(), /后台任务/);
  assert.equal(
    await page.locator('.inspector-tabs button').filter({ hasText: '上下文' }).count(),
    0,
  );
  await submitPrompt(page, 'Create a TodoList with one running and one pending desktop task.');
  await waitForAssistant(page, 'TodoList updated by Kimi.');
  await todoPanel.getByText('Inspect desktop runtime', { exact: true }).waitFor();
  assert.match(await todoPanel.locator('.todo-card-active > header').innerText(), /2/);
  assert.match(await todoPanel.locator('.todo-card-completed > header').innerText(), /0/);

  const pendingTodo = todoPanel.locator('.todo-item').filter({ hasText: 'Run desktop tests' });
  await pendingTodo.getByRole('button', { name: /Run desktop tests：未完成/ }).click();
  await todoPanel.locator('.todo-item-in_progress').filter({ hasText: 'Run desktop tests' }).waitFor();
  const editableTodo = todoPanel.locator('.todo-item').filter({ hasText: 'Run desktop tests' });
  await editableTodo.getByRole('button', { name: 'Run desktop tests', exact: true }).click();
  const todoTitleInput = todoPanel.locator('.todo-title-input');
  await todoTitleInput.fill('Run complete desktop suite');
  await todoPanel.getByTitle('保存名称').click();
  await todoPanel.getByText('Run complete desktop suite', { exact: true }).waitFor();
  const renamedTodo = todoPanel.locator('.todo-item').filter({ hasText: 'Run complete desktop suite' });
  await renamedTodo.getByRole('button', { name: /Run complete desktop suite：正在进行/ }).click();
  await todoPanel.locator('.todo-card-completed .todo-item-done').filter({ hasText: 'Run complete desktop suite' }).waitFor();

  await todoPanel.locator('.todo-add-row input').fill('Delete temporary task');
  await todoPanel.getByTitle('新增任务').click();
  const temporaryTodo = todoPanel.locator('.todo-item').filter({ hasText: 'Delete temporary task' });
  await temporaryTodo.waitFor();
  await temporaryTodo.getByTitle('删除任务').click();
  await temporaryTodo.getByTitle('再次点击确认删除').click();
  await temporaryTodo.waitFor({ state: 'hidden' });

  const planButton = composerControls.getByTitle('Plan 模式');
  await planButton.evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction(async () => (await window.kimiDesktop.host.snapshot()).session.status?.planMode === true);
  assert.equal(await planButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.error-toast').filter({ hasText: 'session.plan_mode_invalid' }).count(), 0);
  await planButton.click();
  await page.waitForFunction(async () => (await window.kimiDesktop.host.snapshot()).session.status?.planMode === false);
  await composerControls.getByLabel('Thinking').selectOption('low');
  await page.waitForFunction(async () => (await window.kimiDesktop.host.snapshot()).session.status?.thinkingEffort === 'low');
  assert.equal(await composerControls.getByLabel('Thinking').inputValue(), 'low');
  await composerControls.getByLabel('Thinking').selectOption('off');
  await composerControls.getByLabel('权限').selectOption('auto');
  await page.waitForFunction(async () => (await window.kimiDesktop.host.snapshot()).session.status?.permission === 'auto');
  assert.equal(await composerControls.getByLabel('权限').inputValue(), 'auto');
  await composerControls.getByLabel('权限').selectOption('manual');
  await page.waitForFunction(async () => (await window.kimiDesktop.host.snapshot()).session.status?.permission === 'manual');

  await page.evaluate(async (id) => {
    await window.kimiDesktop.turn.setPermission('yolo', id);
    await window.kimiDesktop.turn.setSwarmMode(true, id);
  }, sessionId);
  await assertActiveSessionSettings(page, {
    sessionId,
    model: 'desktop-test',
    thinkingEffort: 'off',
    permission: 'yolo',
    planMode: false,
    swarmMode: true,
  });
  await page.evaluate(async (id) => {
    await window.kimiDesktop.turn.setSwarmMode(false, id);
    await window.kimiDesktop.turn.setPermission('manual', id);
  }, sessionId);
  await page.waitForFunction(async () => {
    const status = (await window.kimiDesktop.host.snapshot()).session.status;
    return status?.swarmMode !== true && status?.permission === 'manual';
  });

  const resizeHandle = page.locator('.composer-resize-handle');
  const editorBeforeResize = await page.locator('.composer textarea').boundingBox();
  const handleBox = await resizeHandle.boundingBox();
  assert.ok(editorBeforeResize !== null && handleBox !== null, 'composer resize surfaces are missing');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 56, { steps: 5 });
  await page.mouse.up();
  const editorAfterResize = await page.locator('.composer textarea').boundingBox();
  assert.ok(editorAfterResize !== null && editorAfterResize.height >= editorBeforeResize.height + 48, 'composer did not grow after dragging');
  persistedComposerHeight = Math.round(editorAfterResize.height);
  assert.equal(await page.evaluate(() => Number(localStorage.getItem('kimi-desktop.composer-height.v1'))), persistedComposerHeight);

  await submitPrompt(page, 'Edit sample.txt through an approval request.');
  const pendingDock = page.locator('.pending-interaction-dock');
  const approval = page.locator('.approval-panel');
  await approval.waitFor({ state: 'visible', timeout: 30_000 });
  assert.match(await pendingDock.innerText(), /Kimi 等待处理/);
  await page.locator('.tool-state.waiting').filter({ hasText: '等待批准' }).last().waitFor({ state: 'visible' });
  assert.equal(await readFile(samplePath, 'utf8'), 'before\n');
  await approval.locator('.button-primary').click();
  await waitForAssistant(page, 'Edited sample.txt through approved tool.');
  assert.equal(await readFile(samplePath, 'utf8'), 'after\n');

  const editFrame = page.locator('.tool-frame').filter({ hasText: 'Edit' }).last();
  await editFrame.locator('.tool-open-action').click();
  await page.locator('.operation-diff-editor-view').waitFor({ state: 'visible' });
  assert.match(await page.locator('.operation-diff-editor-view .editor-toolbar').innerText(), /操作前片段[\s\S]*操作后片段/);
  await page.locator('.operation-diff-editor-view').getByRole('button', { name: '当前 Git 差异', exact: true }).click();
  await page.locator('.diff-editor-view:not(.operation-diff-editor-view)').waitFor({ state: 'visible' });
  await selectSessionByTitle(page, 'Desktop E2E Session');

  await submitPrompt(page, 'Write operation record for the file timeline.');
  await pendingDock.locator('.approval-panel').waitFor({ state: 'visible', timeout: 30_000 });
  await pendingDock.locator('.approval-panel .button-primary').click();
  await waitForAssistant(page, 'Wrote record-write.txt through approved tool.');
  assert.equal(await readFile(recordWritePath, 'utf8'), 'written by tool\n');
  const writeFrame = page.locator('.tool-frame').filter({ hasText: 'Write' }).last();
  await writeFrame.locator('.tool-open-action').click();
  await page.locator('.workbench-tab.active').filter({ hasText: 'record-write.txt' }).waitFor({ state: 'visible' });
  await page.locator('.editor-view .monaco-editor').waitFor({ state: 'visible' });
  await selectSessionByTitle(page, 'Desktop E2E Session');

  await submitPrompt(page, 'Read operation record from the file timeline.');
  await waitForAssistant(page, 'Read record-write.txt through the tool timeline.');
  const readFrame = page.locator('.tool-frame').filter({ hasText: 'Read' }).last();
  await readFrame.locator('.tool-open-action').click();
  await page.locator('.workbench-tab.active').filter({ hasText: 'record-write.txt' }).waitFor({ state: 'visible' });
  await selectSessionByTitle(page, 'Desktop E2E Session');

  await submitPrompt(page, 'Ask me which verification target to run.');
  const question = page.locator('.question-panel');
  await question.waitFor({ state: 'visible', timeout: 30_000 });
  await question.locator('.question-option').first().click();
  await question.locator('.button-primary').click();
  await waitForAssistant(page, 'Question answered with the selected target.');

  const imageChooserPromise = page.waitForEvent('filechooser');
  await page.locator('.image-picker-button').click();
  const imageChooser = await imageChooserPromise;
  await imageChooser.setFiles([sampleImagePath, secondImagePath]);
  await page.waitForFunction(() => document.querySelectorAll('.composer-chips > span').length === 2);
  assert.match(await page.locator('.composer-chips').innerText(), /pixel\.png/);
  assert.match(await page.locator('.composer-chips').innerText(), /pixel-2\.png/);
  await submitPrompt(page, 'Render the attached image in the transcript.');
  await waitForAssistant(page, 'Attached image rendered.');
  const mediaSnapshot = await page.evaluate(() => window.kimiDesktop.host.snapshot());
  const mediaTranscript = mediaSnapshot.transcript?.transcripts.main;
  assert.ok((mediaTranscript?.attachments.length ?? 0) > 0, JSON.stringify(mediaTranscript));
  const renderedImage = page.locator('.message-attachments img').last();
  await renderedImage.waitFor({ state: 'attached', timeout: 30_000 });
  assert.equal(await renderedImage.evaluate((image) => image.naturalWidth > 0), true);
  assert.ok(provider.requests.some((request) => request.hasImage === true), 'selected images did not reach the provider');

  const imagePastePrevented = await page.evaluate(() => {
    const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(encoded), (character) => character.codePointAt(0) ?? 0);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
    document.querySelector('.composer textarea')?.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(imagePastePrevented, true, 'image-only paste should suppress the browser default');
  await page.locator('.composer-chips').getByText('clipboard.png', { exact: true }).waitFor();
  await page.locator('.composer-chips button').last().click();

  await page.locator('.attachment-menu-button').click();
  const mediaInput = page.locator('.media-input-row');
  await mediaInput.waitFor({ state: 'visible' });
  await mediaInput.locator('.segmented button').nth(1).click();
  await mediaInput.locator('input').fill('https://example.test/video.mp4');
  await mediaInput.locator('.icon-button').click();
  await page.locator('.composer-chips').getByText('https://example.test/video.mp4', { exact: true }).waitFor();
  await page.locator('.composer-chips button').last().click();

  const invalidChooserPromise = page.waitForEvent('filechooser');
  await page.locator('.image-picker-button').click();
  const invalidChooser = await invalidChooserPromise;
  await invalidChooser.setFiles([samplePath, oversizedImagePath]);
  const attachmentError = page.locator('.composer-attachment-error');
  await attachmentError.waitFor({ state: 'visible' });
  assert.match(await attachmentError.innerText(), /media\.unsupported_type/);
  assert.match(await attachmentError.innerText(), /media\.invalid_size/);
  assert.match(await attachmentError.innerText(), /不支持的图片类型/);
  assert.match(await attachmentError.innerText(), /图片大小必须/);
  await attachmentError.locator('button').click();

  await page.waitForFunction(async () => ((await window.kimiDesktop.host.snapshot()).session.status?.usage?.total?.inputCacheRead ?? 0) > 0);
  const usageSnapshot = await page.evaluate(() => window.kimiDesktop.host.snapshot());
  const totalUsage = usageSnapshot.session.status?.usage?.total;
  assert.ok(totalUsage !== undefined, 'session usage is missing');
  const totalInput = totalUsage.inputOther + totalUsage.inputCacheRead + totalUsage.inputCacheCreation;
  const expectedHitRate = totalInput === 0 ? 0 : Math.round((totalUsage.inputCacheRead / totalInput) * 100);
  assert.match(await page.locator('.cache-usage-indicator').innerText(), new RegExp(`命中 ${String(expectedHitRate)}%`));
  assert.match(await page.locator('.cache-usage-indicator').getAttribute('title'), /缓存写入/);
  const expectedContextPercent = Math.max(0, Math.round((usageSnapshot.session.status?.contextUsage ?? 0) * 100));
  assert.match(await page.locator('.context-usage-indicator').innerText(), new RegExp(`上下文 ${String(expectedContextPercent)}%`));

  await page.evaluate(async (id) => {
    await window.kimiDesktop.turn.setModel('desktop-test-alt', id);
    await window.kimiDesktop.turn.setThinking('low', id);
    await window.kimiDesktop.turn.setPermission('manual', id);
  }, sessionId);
  await assertActiveSessionSettings(page, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: false,
  });
  await page.evaluate((id) => window.kimiDesktop.turn.setSwarmMode(true, id), sessionId);
  await assertActiveSessionSettings(page, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });
  await submitPrompt(page, 'Run a two-agent swarm over alpha and beta.');

  try {
    await page.waitForFunction(() => document.querySelectorAll('.pending-interaction-item').length >= 2, undefined, { timeout: 45_000 });
  } catch (error) {
    const pendingDiagnostic = await page.evaluate(async () => {
      const snapshot = await window.kimiDesktop.host.snapshot();
      return {
        activeSessionId: snapshot.activeSessionId,
        agents: snapshot.transcript?.agents,
        interactions: Object.fromEntries(Object.entries(snapshot.transcript?.transcripts ?? {}).map(([agentId, transcript]) => [
          agentId,
          transcript.interactions,
        ])),
        dock: [...document.querySelectorAll('.pending-interaction-item')].map((item) => item.textContent),
        bodyTail: document.body.innerText.slice(-2_000),
      };
    });
    throw new Error(`Swarm pending interactions did not appear: ${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      pendingDiagnostic,
      providerTail: provider.requests.slice(-12),
    })}`);
  }
  await pendingDock.waitFor({ state: 'visible' });
  assert.match(await pendingDock.innerText(), /权限审批/);
  assert.match(await pendingDock.innerText(), /问题/);
  assert.equal(await page.locator('.agent-select select').inputValue(), 'main');
  assert.equal(await pendingDock.locator('.pending-interaction-toggle[aria-expanded="true"]').count(), 1);
  await page.locator('.inspector-tabs button').nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.agent-activity-row').length >= 3);
  try {
    await page.locator('.inline-agent-activity').first().waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    const diagnostic = await page.evaluate(async () => {
      const snapshot = await window.kimiDesktop.host.snapshot();
      const main = snapshot.transcript?.transcripts.main;
      return {
        events: snapshot.rawEvents.filter((event) =>
          typeof event.type === 'string' &&
          (event.type.startsWith('subagent.') || event.type.startsWith('tool.call'))),
        mainTail: main === undefined ? undefined : {
          items: main.items.slice(-3),
          tasks: main.tasks,
        },
        selectedAgent: document.querySelector('.agent-select select')?.value,
        dimensions: ['.conversation-surface', '.conversation-header', '.timeline-scroll', '.pending-interaction-dock', '.composer-wrap']
          .map((selector) => {
            const element = document.querySelector(selector);
            const rect = element?.getBoundingClientRect();
            return { selector, height: rect?.height, top: rect?.top, bottom: rect?.bottom };
          }),
        timelineRows: [...document.querySelectorAll('.timeline-virtual-row')].map((row) => ({
          index: row.getAttribute('data-index'),
          text: row.textContent?.slice(0, 180),
          toolFrames: row.querySelectorAll('.tool-frame').length,
        })),
      };
    });
    assert.fail(`main timeline is missing inline Agent activity: ${JSON.stringify(diagnostic)}`);
  }
  assert.ok(await page.locator('.agent-activity-row.status-waiting').count() >= 2, 'pending child Agents are not shown as waiting');
  const agentDepths = await page.locator('.inspector .agent-activity-row').evaluateAll((rows) =>
    rows.map((row) => row.style.getPropertyValue('--agent-depth')),
  );
  assert.ok(agentDepths.includes('1'), `child Agents are not nested under Main Agent: ${JSON.stringify(agentDepths)}`);
  await auditAndScreenshot(firstApp, page, 1_620, 1_040, join(artifactDir, 'swarm-interactions-1620x1040.png'));
  await auditAndScreenshot(firstApp, page, 1_180, 760, join(artifactDir, 'swarm-interactions-1180x760.png'));

  let childApproval = pendingDock.locator('.pending-interaction-item').filter({ hasText: '权限审批' });
  await childApproval.locator('.pending-interaction-summary > .icon-button').click();
  await page.waitForFunction(() => document.querySelector('.agent-select select')?.value !== 'main');
  const selectedChildAgentId = await page.locator('.agent-select select').inputValue();
  assert.equal(await pendingDock.locator('.pending-interaction-item').count(), 2);
  const selectedChildPending = await page.evaluate(async (agentId) => {
    const snapshot = await window.kimiDesktop.host.snapshot();
    return snapshot.transcript?.transcripts[agentId]?.interactions.filter((interaction) => interaction.state === 'pending').length ?? 0;
  }, selectedChildAgentId);
  assert.equal(selectedChildPending, 1);
  assert.ok(await page.locator('.approval-panel').count() <= 1, 'selected child approval was rendered more than once');
  await page.locator('.agent-select select').selectOption('main');
  await page.waitForFunction(() => document.querySelectorAll('.pending-interaction-item').length === 2);

  childApproval = pendingDock.locator('.pending-interaction-item').filter({ hasText: '权限审批' });
  if (await childApproval.locator('.pending-interaction-toggle').getAttribute('aria-expanded') !== 'true') {
    await childApproval.locator('.pending-interaction-toggle').click();
  }
  await childApproval.locator('.approval-panel').waitFor({ state: 'visible' });
  await childApproval.locator('.button-primary').click();
  await page.waitForFunction(() => document.querySelectorAll('.pending-interaction-item').length === 1);

  const childQuestion = pendingDock.locator('.pending-interaction-item').filter({ hasText: '问题' });
  await childQuestion.locator('.question-panel').waitFor({ state: 'visible' });
  await childQuestion.locator('.question-option').first().click();
  await childQuestion.locator('.button-primary').click();
  await pendingDock.waitFor({ state: 'hidden' });
  await waitForAssistant(page, 'Swarm complete with two agent results.', 45_000);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.inspector .agent-activity-state')]
      .filter((element) => element.textContent?.includes('已完成（保留）')).length >= 2,
  );
  assert.equal(await page.locator('.inline-agent-summary').last().getAttribute('aria-expanded'), 'false');
  await auditAndScreenshot(firstApp, page, 1_620, 1_040, join(artifactDir, 'swarm-completed-1620x1040.png'));
  await auditAndScreenshot(firstApp, page, 1_180, 760, join(artifactDir, 'swarm-completed-1180x760.png'));
  assert.equal(await readFile(swarmOutputPath, 'utf8'), 'swarm-approved\n');

  await page.locator('.surface-switcher').getByRole('button', { name: '团队', exact: true }).click();
  await page.locator('.team-workbench').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.sidebar').count(), 0, 'Chat sidebar must stay outside the Team workbench');
  assert.equal(await page.locator('.inspector').count(), 0, 'Chat inspector must stay outside the Team workbench');
  await page.locator('.team-create-button').click();
  const createTeamDialog = page.locator('.create-team-dialog');
  await createTeamDialog.waitFor({ state: 'visible' });
  await createTeamDialog.locator('.team-objective-field textarea').fill(
    'Desktop Team E2E\nLaunch a Team Mode batch and wait for live updates.',
  );
  await createTeamDialog.getByLabel('主代理模型').selectOption('desktop-test-alt');
  assert.equal(await createTeamDialog.getByLabel('主代理模型').inputValue(), 'desktop-test-alt');
  await createTeamDialog.getByRole('button', { name: '创建并开始', exact: true }).click();
  await createTeamDialog.waitFor({ state: 'hidden', timeout: 30_000 });
  teamSessionId = await page.evaluate(async () => (
    await window.kimiDesktop.session.list()
  ).find((session) => session.title === 'Desktop Team E2E' && session.surface === 'team')?.id);
  assert.equal(typeof teamSessionId, 'string');
  const teamTab = page.locator('.workbench-tab').filter({ hasText: 'Desktop Team E2E · 团队' });
  await teamTab.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await teamTab.getAttribute('aria-selected'), 'true', 'new Team task should open its channel');
  const teamPage = page.locator('.team-page');
  await teamPage.waitFor({ state: 'visible' });
  await page.waitForFunction(async (id) => (
    await window.kimiDesktop.host.snapshot()
  ).activeSessionId === id && (
    await window.kimiDesktop.host.snapshot()
  ).session.status?.model === 'desktop-test-alt', teamSessionId);
  assert.equal(await teamPage.getByLabel('主代理模型').inputValue(), 'desktop-test-alt');
  await teamPage.locator('.team-member-list button:has(span[title="main"])').click();
  await page.locator('.team-agent-surface').waitFor({ state: 'visible' });
  await approveProfileIfNeeded(page, teamProfilePath);
  assert.ok(
    provider.requests.some((request) => request.toolName === 'AgentProfileCreate'),
    'Team leader did not create the reusable fixture profile',
  );
  await page.waitForFunction(async (id) => (
    (await window.kimiDesktop.host.snapshot()).teams[id]?.snapshot.assignments
      .filter((assignment) => assignment.status === 'running').length ?? 0
  ) >= 2, teamSessionId, { timeout: 30_000 });
  await returnToTeamChannel(page, teamPage);
  try {
    await page.waitForFunction(() => {
      const text = [...document.querySelectorAll('.team-activity-bubble')]
        .map((element) => element.textContent ?? '')
        .join('\n');
      return text.includes('界面侦察') && text.includes('构建专家');
    }, undefined, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async (id) => {
      const snapshot = await window.kimiDesktop.host.snapshot();
      const directSnapshot = await window.kimiDesktop.team.snapshot(id);
      const operations = await window.kimiDesktop.team.operations(id, 0, 100);
      return {
        activeSessionId: snapshot.activeSessionId,
        team: snapshot.teams[id],
        directSnapshot,
        operations,
        transcriptAgents: snapshot.transcript?.agents,
        activityText: [...document.querySelectorAll('.team-activity-bubble')]
          .map((element) => element.textContent ?? ''),
        visibleSurface: document.querySelector('.team-page') !== null
          ? 'team'
          : document.querySelector('.team-agent-surface') !== null ? 'agent' : 'other',
      };
    }, teamSessionId);
    assert.fail(`Team activity bubbles did not appear: ${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      diagnostic,
      providerRequests: provider.requests.slice(-20),
    })}`);
  }
  const activityBubbles = teamPage.locator('.team-activity-bubble');
  assert.ok(await activityBubbles.count() >= 2, 'active Team members are missing from the channel activity strip');
  for (const displayName of ['界面侦察', '构建专家']) {
    const bubble = activityBubbles.filter({ hasText: displayName }).first();
    assert.ok((await bubble.locator('.team-activity-action').innerText()).trim().length > 0, `${displayName} has no live action`);
  }
  const activityMetrics = await teamPage.locator('.team-activity-strip').evaluate((element) => ({
    clientHeight: element.clientHeight,
    bubbleHeights: [...element.querySelectorAll('.team-activity-bubble')]
      .map((bubble) => bubble.getBoundingClientRect().height),
  }));
  assert.equal(activityMetrics.clientHeight, 34, JSON.stringify(activityMetrics));
  assert.ok(activityMetrics.bubbleHeights.every((height) => height === 28), JSON.stringify(activityMetrics));
  await auditTeamAndScreenshot(firstApp, page, 1_620, 1_040, join(artifactDir, 'team-activity-1620x1040.png'));
  await auditTeamAndScreenshot(firstApp, page, 1_180, 760, join(artifactDir, 'team-activity-1180x760.png'));
  await activityBubbles.filter({ hasText: '构建专家' }).first().click();
  await page.locator('.team-agent-surface').waitFor({ state: 'visible' });
  assert.match(await page.locator('.team-agent-surface .conversation-header').innerText(), /构建专家/);
  await returnToTeamChannel(page, teamPage);
  provider.releaseTeamWorkers();
  await teamPage.locator('.team-member-list button:has(span[title="main"])').click();
  await page.locator('.team-agent-surface').waitFor({ state: 'visible' });
  try {
    await waitForAssistant(page, 'Team coordination resumed after a live message.', 45_000);
  } catch (error) {
    const diagnostic = await page.evaluate(() => window.kimiDesktop.host.snapshot());
    assert.fail(`Team coordination did not resume: ${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      teamSessionId,
      activeSessionId: diagnostic.activeSessionId,
      team: teamSessionId === undefined ? undefined : diagnostic.teams[teamSessionId],
      transcript: diagnostic.transcript,
      providerRequests: provider.requests.slice(-12),
    })}`);
  }
  await returnToTeamChannel(page, teamPage);
  await page.waitForFunction(() => document.querySelectorAll('.team-activity-strip').length === 0);
  const teamWaitOutput = await page.evaluate(async () => {
    const items = (await window.kimiDesktop.host.snapshot()).transcript?.transcripts.main?.items ?? [];
    let latest;
    for (const item of items) {
      if (item.kind !== 'turn') continue;
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind !== 'tool' || frame.name !== 'TeamWait') continue;
          latest = frame.output;
          if (frame.output?.includes('"type":"message.sent"')) return frame.output;
        }
      }
    }
    return latest;
  });
  assert.match(teamWaitOutput ?? '', /"type":"message\.sent"/, `TeamWait was not woken by a team message: ${teamWaitOutput ?? 'missing'}`);
  await page.waitForFunction(async (id) =>
    ((await window.kimiDesktop.host.snapshot()).teams[id]?.snapshot.latestChannelSeq ?? 0) >= 3,
  teamSessionId, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('.team-message.agent').length >= 2);
  assert.ok(await teamPage.locator('.team-assignment-node').count() >= 2, 'Team assignments are missing');
  const teamText = await teamPage.innerText();
  const assignedItems = await page.evaluate(async (id) => (
    (await window.kimiDesktop.host.snapshot()).teams[id]?.snapshot.assignments
      .map((assignment) => assignment.item)
      .filter((item) => item !== undefined)
      .sort() ?? []
  ), teamSessionId);
  assert.deepEqual(assignedItems, ['team-alpha', 'team-beta']);
  assert.match(teamText, /界面侦察/);
  assert.match(teamText, /构建专家/);
  assert.match(teamText, /explore/);
  assert.match(teamText, /fixture-researcher/);
  assert.match(teamText, /desktop-test/);
  assert.match(teamText, /desktop-test-alt/);
  assert.ok(await teamPage.locator('.team-message.agent').count() >= 2, 'Agent messages are not rendered as agent bubbles');
  assert.ok(await teamPage.locator('.team-message.agent .team-message-bubble br').count() >= 2, 'single newlines were not rendered');
  const mention = teamPage.locator('.team-mention').filter({ hasText: '@构建专家' }).first();
  await mention.waitFor({ state: 'visible' });
  const longBubble = teamPage.locator('.team-message-bubble').filter({ hasText: '验证行 01' });
  const bubbleMetrics = await longBubble.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  assert.ok(bubbleMetrics.clientHeight <= 240, `Team bubble exceeded fixed height: ${JSON.stringify(bubbleMetrics)}`);
  assert.ok(bubbleMetrics.scrollHeight > bubbleMetrics.clientHeight, `long Team bubble does not scroll: ${JSON.stringify(bubbleMetrics)}`);
  assert.equal(bubbleMetrics.overflowY, 'auto');
  await mention.click();
  await page.locator('.team-agent-surface').waitFor({ state: 'visible' });
  assert.match(await page.locator('.team-agent-surface .conversation-header').innerText(), /构建专家/);
  await returnToTeamChannel(page, teamPage);
  const teamComposer = teamPage.locator('.team-composer textarea');
  await teamComposer.fill('User follow-up from the Team channel.');
  await teamPage.locator('.team-composer button').click();
  const userMessage = teamPage.locator('.team-message.user').filter({ hasText: 'User follow-up from the Team channel.' });
  await userMessage.waitFor();
  assert.equal(await userMessage.evaluate((element) => getComputedStyle(element).flexDirection), 'row-reverse');
  assert.equal(await page.locator('.approval-panel').count(), 0, 'Team messaging must not request tool approval');
  const persistedTeamTabs = await page.evaluate(() => Object.values(localStorage)
    .filter((value) => value.includes('"kind":"team"')));
  assert.ok(persistedTeamTabs.length > 0, `Team tab was not persisted: ${JSON.stringify(persistedTeamTabs)}`);
  await auditTeamAndScreenshot(firstApp, page, 1_620, 1_040, join(artifactDir, 'team-running-1620x1040.png'));
  await auditTeamAndScreenshot(firstApp, page, 1_180, 760, join(artifactDir, 'team-running-1180x760.png'));
  const temporaryTeamId = await page.evaluate(() => window.kimiDesktop.session.create({
    surface: 'team',
    model: 'desktop-test',
  }));
  await page.evaluate((id) => window.kimiDesktop.session.rename(id, 'Desktop Delete Team E2E'), temporaryTeamId);
  const temporaryTeamRow = page.locator('.team-task-row-shell').filter({ hasText: 'Desktop Delete Team E2E' });
  await temporaryTeamRow.waitFor({ state: 'visible' });
  await temporaryTeamRow.getByRole('button', { name: '删除团队任务：Desktop Delete Team E2E' }).click();
  const deleteTeamDialog = page.locator('.action-dialog').filter({ hasText: '永久删除团队任务' });
  await deleteTeamDialog.waitFor({ state: 'visible' });
  await deleteTeamDialog.getByRole('button', { name: '确认', exact: true }).click();
  await temporaryTeamRow.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(async (id) => (
    await window.kimiDesktop.session.list()
  ).some((session) => session.id === id), temporaryTeamId), false);
  await selectSessionByTitle(page, 'Desktop E2E Session');
  assert.equal(await page.locator('.agent-select select').inputValue(), 'main');
  await assertActiveSessionSettings(page, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });

  const swarmSnapshot = await page.evaluate(() => window.kimiDesktop.host.snapshot());
  assert.ok((swarmSnapshot.transcript?.agents.length ?? 0) >= 3, 'native subagent descriptors were not projected');
  assert.equal(JSON.stringify(swarmSnapshot).includes(providerToken), false, 'provider token leaked to renderer');

  await page.locator('.composer-modes button').first().click();
  await submitPrompt(page, 'Recover after one transient provider failure.');
  try {
    await waitForAssistant(page, 'Recovered after the transient provider failure.');
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const snapshot = await window.kimiDesktop.host.snapshot();
      const main = snapshot.transcript?.transcripts.main;
      return {
        status: snapshot.session.status,
        mainTail: main === undefined ? undefined : {
          items: main.items.slice(-2),
          tasks: main.tasks,
        },
        selectedAgent: document.querySelector('.agent-select select')?.value,
        timelineHeight: document.querySelector('.timeline-scroll')?.getBoundingClientRect().height,
        timelineText: document.querySelector('.timeline-scroll')?.textContent,
      };
    });
    throw new Error(`transient retry response is not visible (${String(provider.transientAttempts)} attempts): ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  assert.ok(provider.transientAttempts >= 2, `expected a provider retry, got ${provider.transientAttempts} attempt(s)`);
  await assertActiveSessionSettings(page, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });

  const timeline = page.locator('.timeline-scroll');
  const compactionMarkersBefore = await page.evaluate(async () => {
    const snapshot = await window.kimiDesktop.host.snapshot();
    return snapshot.transcript?.transcripts.main?.items.filter((item) =>
      item.kind === 'marker' && item.marker === 'compaction').length ?? 0;
  });
  const historyScroll = await timeline.evaluate((element) => {
    element.scrollTop = 0;
    return {
      top: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  assert.ok(historyScroll.scrollHeight > historyScroll.clientHeight, 'timeline fixture is not scrollable');
  await page.evaluate((id) => window.kimiDesktop.turn.compact('Keep the desktop E2E facts.', id), sessionId);
  await page.waitForFunction(async (before) => {
    const snapshot = await window.kimiDesktop.host.snapshot();
    const count = snapshot.transcript?.transcripts.main?.items.filter((item) =>
      item.kind === 'marker' && item.marker === 'compaction').length ?? 0;
    return count >= before + 2;
  }, compactionMarkersBefore, { timeout: 45_000 });
  assert.ok(await timeline.evaluate((element) => element.scrollTop) <= historyScroll.top + 2,
    'system markers forced the timeline away from history');
  await auditAndScreenshot(firstApp, page, 1_620, 1_040, join(artifactDir, 'timeline-history-1620x1040.png'));
  await auditAndScreenshot(firstApp, page, 1_180, 760, join(artifactDir, 'timeline-history-1180x760.png'));

  await submitPrompt(page, 'Hold this turn until I cancel it.');
  const cancelButton = page.locator('.composer .cancel-button');
  await cancelButton.waitFor({ state: 'visible', timeout: 30_000 });
  await timeline.locator('.timeline-system-message').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.timeline-system-message').evaluateAll((elements) =>
    elements.every((element) => element.closest('.timeline-scroll') !== null)), true,
    'system messages must remain ordinary timeline entries');
  assert.equal(await todoPanel.locator('.todo-add-row input').isDisabled(), true, 'TodoList should be read-only while an Agent runs');
  assert.ok(await timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight) < 120,
    'user submission did not restore timeline auto-follow');
  await cancelButton.click();
  await page.waitForFunction(async () => (await window.kimiDesktop.host.snapshot()).session.status?.busy === false, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.todo-add-row input')?.disabled);
  assert.ok(provider.cancelledStreams >= 1, 'provider stream was not aborted by turn.cancel');

  await page.evaluate(async ({ id, directory }) => {
    await window.kimiDesktop.context.import('Persisted E2E context.', 'desktop-e2e', id);
    await window.kimiDesktop.context.addDirectory(directory, false, id);
  }, { id: sessionId, directory: additionalDir });
  const context = await page.evaluate((id) => window.kimiDesktop.context.get(id), sessionId);
  assert.ok(JSON.stringify(context).includes('Persisted E2E context.'));

  const shellResult = await page.evaluate((id) => window.kimiDesktop.shell.run('echo shell-ok', id), sessionId);
  assert.ok(JSON.stringify(shellResult).includes('shell-ok'));

  await page.locator('.tree-node[title^="sample.txt"]').click();
  await page.locator('.editor-view .monaco-editor').waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await page.locator('.workbench-tab-main[title="sample.txt"]').count(), 1);
  await replaceMonacoText(page, 'desktop editor save\n');
  await page.locator('.workbench-tab.active').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.workbench-tab.active').getAttribute('class').then((value) => value?.includes('dirty')), true);
  await page.keyboard.press('Control+S');
  await waitForFileText(samplePath, 'desktop editor save\n');
  await page.waitForFunction(() => !document.querySelector('.workbench-tab.active')?.classList.contains('dirty'));

  await appendMonacoText(page, 'discard me\n');
  await page.locator('.workbench-tab.active .workbench-tab-close').click();
  const tabDirtyDialog = page.locator('.dirty-files-dialog');
  await tabDirtyDialog.waitFor({ state: 'visible' });
  await tabDirtyDialog.locator('.dialog-footer').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.workbench-tab.active').count(), 1, 'cancel should keep the dirty tab');
  await page.locator('.workbench-tab.active .workbench-tab-close').click();
  await tabDirtyDialog.getByRole('button', { name: '放弃', exact: false }).click();
  await page.locator('.workbench-tab-main[title="sample.txt"]').waitFor({ state: 'hidden' });
  assert.equal(await readFile(samplePath, 'utf8'), 'desktop editor save\n');

  await page.locator('.tree-node[title^="sample.txt"]').click();
  await page.locator('.editor-view .monaco-editor').waitFor({ state: 'visible' });
  await replaceMonacoText(page, 'saved while closing tab\n');
  await page.locator('.workbench-tab.active .workbench-tab-close').click();
  await tabDirtyDialog.getByRole('button', { name: '保存', exact: false }).click();
  await waitForFileText(samplePath, 'saved while closing tab\n');

  await page.locator('.tree-node.folder-node[title^="src"]').click();
  await page.locator('.tree-node.folder-node[title^="src/nested"]').waitFor({ state: 'visible' });
  await page.locator('.tree-node.folder-node[title^="src/nested"]').click();
  await page.locator('.tree-node[title^="src/nested/source.ts"]').waitFor({ state: 'visible' });
  await page.locator('.tree-node[title^="src/nested/source.ts"]').click();
  await page.locator('.editor-view .monaco-editor').waitFor({ state: 'visible' });
  await replaceMonacoText(page, 'export const source = "editor draft";\n');
  await writeFile(nestedSourcePath, 'export const source = "external disk";\n', 'utf8');
  await page.locator('.editor-conflict').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.editor-toolbar').getByRole('button', { name: '比较', exact: true }).click();
  await page.locator('.memory-diff-dialog').waitFor({ state: 'visible' });
  await page.locator('.memory-diff-dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.editor-toolbar').getByRole('button', { name: '重新加载', exact: true }).click();
  await page.locator('.editor-conflict').waitFor({ state: 'hidden' });
  await page.locator('.monaco-editor .view-lines').getByText('external disk', { exact: false }).waitFor();

  await writeFile(dualPath, 'dual staged\n', 'utf8');
  execFileSync('git', ['add', 'dual.txt'], { cwd: workspace });
  await writeFile(dualPath, 'dual working\n', 'utf8');
  await mkdir(join(workspace, 'src', 'new'), { recursive: true });
  await writeFile(untrackedPath, 'untracked\n', 'utf8');
  await page.evaluate(() => window.kimiDesktop.workspace.refresh());
  const editorGitSnapshot = await page.evaluate(() => window.kimiDesktop.host.snapshot());
  assert.ok(editorGitSnapshot.gitFiles.some((file) => file.path === 'src/new/untracked.txt' && file.worktreeStatus === 'untracked'), JSON.stringify(editorGitSnapshot.gitFiles));
  const dualExplorerRow = page.locator('.tree-node[title^="dual.txt"]').first();
  await dualExplorerRow.waitFor({ state: 'visible' });
  assert.equal(await dualExplorerRow.locator('.tree-git-status').innerText(), 'M');
  const editorGitDiffs = await page.evaluate(async () => ({
    staged: await window.kimiDesktop.workspace.readDiff('dual.txt', 'staged'),
    working: await window.kimiDesktop.workspace.readDiff('dual.txt', 'working'),
  }));
  assert.match(editorGitDiffs.staged.originalLabel, /HEAD/);
  assert.match(editorGitDiffs.staged.modified ?? '', /dual staged/);
  assert.match(editorGitDiffs.working.originalLabel, /Index/);
  assert.match(editorGitDiffs.working.modified ?? '', /dual working/);
  assert.equal(await page.locator('.bottom-panel').count(), 0);
  await auditAndScreenshot(firstApp, page, 1_620, 1_040, join(artifactDir, 'editor-git-1620x1040.png'));
  await page.locator('.workbench-tab').filter({ hasText: 'Desktop E2E Session' }).locator('.workbench-tab-main').click();
  await composerControls.waitFor({ state: 'visible' });

  const pluginResult = await page.evaluate((source) => window.kimiDesktop.extension.installPlugin(source), pluginDir);
  assert.ok(JSON.stringify(pluginResult).includes('desktop-fixture'));
  let extensions = await page.evaluate(() => window.kimiDesktop.extension.list());
  assert.ok(JSON.stringify(extensions.plugins).includes('desktop-fixture'));
  await page.evaluate(async () => {
    await window.kimiDesktop.extension.togglePlugin('desktop-fixture', false);
    await window.kimiDesktop.extension.togglePlugin('desktop-fixture', true);
    await window.kimiDesktop.extension.reloadPlugins();
  });

  const mcpFixture = join(repoRoot, 'packages', 'agent-core-v2', 'test', 'mcpCore', 'fixtures', 'mock-stdio-server.mjs');
  await page.evaluate(({ command, fixture }) => window.kimiDesktop.mcp.add({
    name: 'desktop-fixture', transport: 'stdio', command, args: [fixture],
  }), { command: process.execPath, fixture: mcpFixture });
  const mcpTest = await page.evaluate(() => window.kimiDesktop.mcp.test('desktop-fixture'));
  assert.equal(mcpTest.success, true, JSON.stringify(mcpTest));
  assert.match(mcpTest.output, /Available tools/);
  await page.evaluate(() => window.kimiDesktop.mcp.remove('desktop-fixture'));

  await page.evaluate((command) => window.kimiDesktop.mcp.add({
    name: 'desktop-failure', transport: 'stdio', command, args: ['Z:\\missing\\desktop-mcp-fixture.mjs'],
  }), process.execPath);
  const failedMcpTest = await page.evaluate(() => window.kimiDesktop.mcp.test('desktop-failure'));
  assert.equal(failedMcpTest.success, false, JSON.stringify(failedMcpTest));
  await page.evaluate(() => window.kimiDesktop.mcp.remove('desktop-failure'));

  const capabilityError = await page.evaluate(async () => new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), 5_000);
    const unsubscribe = window.kimiDesktop.onNotification((notification) => {
      if (notification.type !== 'error' || notification.command !== 'extension.installCapability') return;
      clearTimeout(timer);
      unsubscribe();
      resolvePromise(notification.error);
    });
    void window.kimiDesktop.extension.installCapability('desktop-missing').catch(() => undefined);
  }));
  assert.equal(capabilityError?.code, 'capability.not_found', JSON.stringify(capabilityError));
  await page.locator('.error-toast .icon-button').click();

  const auth = await page.evaluate(() => window.kimiDesktop.auth.status());
  assert.equal(JSON.stringify(auth).includes('accessToken'), false);
  assert.equal(JSON.stringify(auth).includes('refreshToken'), false);
  assert.equal(JSON.stringify(auth).includes('"hasToken":true'), false);
  const login = await page.evaluate(({ baseUrl }) => window.kimiDesktop.auth.login({
    baseUrl: `${baseUrl}/v1`, oauthHost: baseUrl,
  }), { baseUrl: provider.baseUrl });
  assert.equal(login.ok, true, JSON.stringify(login));
  const loggedInAuth = await page.evaluate(() => window.kimiDesktop.auth.status());
  assert.equal(JSON.stringify(loggedInAuth).includes('"hasToken":true'), true);
  assert.equal(JSON.stringify(loggedInAuth).includes('desktop-oauth-access'), false, 'OAuth token leaked to renderer');
  const usage = await page.evaluate(() => window.kimiDesktop.auth.usage());
  assert.equal(usage.kind, 'ok', JSON.stringify(usage));
  const feedback = await page.evaluate(() => window.kimiDesktop.auth.feedback('Desktop E2E feedback'));
  assert.equal(feedback.kind, 'ok', JSON.stringify(feedback));
  await page.evaluate(() => window.kimiDesktop.auth.logout());
  const loggedOutAuth = await page.evaluate(() => window.kimiDesktop.auth.status());
  assert.equal(JSON.stringify(loggedOutAuth).includes('"hasToken":true'), false);

  const exportResult = await page.evaluate(({ id, outputPath }) => window.kimiDesktop.session.export(id, outputPath), {
    id: sessionId,
    outputPath: exportPath,
  });
  assert.equal((await stat(exportPath)).size > 100, true);
  assert.ok(JSON.stringify(exportResult).includes('session-export.zip'));

  const fullForkId = await page.evaluate((id) => window.kimiDesktop.session.fork(id, undefined, 'Full Fork'), sessionId);
  await page.evaluate((id) => window.kimiDesktop.session.delete(id), fullForkId);
  const historicalForkId = await page.evaluate((id) => window.kimiDesktop.session.fork(id, 0, 'Turn 1 Fork'), sessionId);
  await page.evaluate((id) => window.kimiDesktop.session.delete(id), historicalForkId);
  await page.evaluate((id) => window.kimiDesktop.session.resume(id), sessionId);

  const sessionsBeforeSecondary = await page.evaluate(() => window.kimiDesktop.session.list().then((items) => items.map((item) => item.id)));
  await page.locator('.section-heading button[title="新建会话"]').click();
  await page.waitForFunction(async (known) => {
    const sessions = await window.kimiDesktop.session.list();
    return sessions.some((session) => !known.includes(session.id));
  }, sessionsBeforeSecondary);
  secondarySessionId = await page.evaluate(async (known) => {
    const sessions = await window.kimiDesktop.session.list();
    return sessions.find((session) => !known.includes(session.id))?.id;
  }, sessionsBeforeSecondary);
  assert.equal(typeof secondarySessionId, 'string');
  await page.locator(`.workbench-tab.active .workbench-tab-main[title*="${secondarySessionId}"]`).waitFor({ state: 'visible' });
  await page.waitForFunction(async (id) => (await window.kimiDesktop.host.snapshot()).activeSessionId === id, secondarySessionId);
  await page.evaluate((id) => window.kimiDesktop.session.rename(id, 'Desktop E2E Secondary'), secondarySessionId);
  const secondaryDefaultThinking = (await page.evaluate(() => window.kimiDesktop.host.snapshot())).session.status?.thinkingEffort;
  assert.equal(typeof secondaryDefaultThinking, 'string', 'new session did not resolve a default Thinking level');
  await assertActiveSessionSettings(page, {
    sessionId: secondarySessionId,
    model: 'desktop-test',
    thinkingEffort: secondaryDefaultThinking,
    permission: 'manual',
    planMode: false,
    swarmMode: false,
  });
  await page.evaluate(async (id) => {
    await window.kimiDesktop.turn.setThinking('off', id);
    await window.kimiDesktop.turn.setPermission('auto', id);
    await window.kimiDesktop.turn.setPlanMode(true, id);
  }, secondarySessionId);
  await assertActiveSessionSettings(page, {
    sessionId: secondarySessionId,
    model: 'desktop-test',
    thinkingEffort: 'off',
    permission: 'auto',
    planMode: true,
    swarmMode: false,
  });
  await selectSessionByTitle(page, 'Desktop E2E Session');
  await assertActiveSessionSettings(page, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });
  await selectSessionByTitle(page, 'Desktop E2E Secondary');
  await assertActiveSessionSettings(page, {
    sessionId: secondarySessionId,
    model: 'desktop-test',
    thinkingEffort: 'off',
    permission: 'auto',
    planMode: true,
    swarmMode: false,
  });
  await selectSessionByTitle(page, 'Desktop E2E Session');
  await assertActiveSessionSettings(page, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });

  await selectTeamByTitle(page, 'Desktop Team E2E');
  await page.locator('.workbench-tab-main[title^="团队频道"]').waitFor({ state: 'visible' });
  await selectSessionByTitle(page, 'Desktop E2E Session');

  await openSettingsAndVerify(page);
  await auditAndScreenshot(firstApp, page, 1_620, 1_040, join(artifactDir, 'kimi-desktop-1620x1040.png'));
  await page.locator('.tree-node[title^="sample.txt"]').click();
  await page.locator('.editor-view .monaco-editor').waitFor({ state: 'visible' });
  await replaceMonacoText(page, 'saved by application close\n');
  await firstApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const appDirtyDialog = page.locator('.dirty-files-dialog');
  await appDirtyDialog.waitFor({ state: 'visible' });
  await appDirtyDialog.locator('.dialog-footer').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.desktop-app').count(), 1, 'cancelled application close should keep the window alive');
  await firstApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await appDirtyDialog.waitFor({ state: 'visible' });
  const firstClosed = firstApp.waitForEvent('close');
  await appDirtyDialog.getByRole('button', { name: '保存', exact: false }).click();
  await firstClosed;
  await waitForFileText(samplePath, 'saved by application close\n');
  firstApp = undefined;

  const second = await launchDesktop();
  secondApp = second.app;
  const restoredPage = second.page;
  assert.equal(await restoredPage.locator('html').getAttribute('data-theme'), persistedTheme, 'theme was not restored across app restart');
  await restoredPage.locator('.workbench-tab-main[title="sample.txt"]').waitFor({ state: 'visible' });
  assert.equal(await restoredPage.locator('.workbench-tab').filter({ hasText: '操作差异' }).count(), 0, 'ephemeral operation diff was restored');
  assert.ok(await restoredPage.locator('.workbench-tab').count() >= 2, 'saved session and editor tabs were not restored');
  await restoredPage.evaluate((id) => window.kimiDesktop.session.resume(id), sessionId);
  await restoredPage.waitForFunction(async (id) => {
    const snapshot = await window.kimiDesktop.host.snapshot();
    return snapshot.activeSessionId === id
      && JSON.stringify(snapshot.transcript).includes('Swarm complete with two agent results.');
  }, sessionId, { timeout: 30_000 });
  await selectSessionByTitle(restoredPage, 'Desktop E2E Session');
  await assertActiveSessionSettings(restoredPage, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });
  const restored = await restoredPage.evaluate(() => window.kimiDesktop.host.snapshot());
  assert.equal(restored.activeSessionId, sessionId);
  assert.ok((restored.transcript?.agents.length ?? 0) >= 3);
  await restoredPage.locator('.todo-fixed-panel').getByText('Run complete desktop suite', { exact: true }).waitFor();
  await restoredPage.locator('.surface-switcher').getByRole('button', { name: '团队', exact: true }).click();
  const restoredTeamTab = restoredPage.locator('.workbench-tab-main[title^="团队频道"]');
  try {
    await restoredTeamTab.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    const restoreDiagnostic = await restoredPage.evaluate(async () => ({
      storage: Object.fromEntries(Object.entries(localStorage)),
      snapshot: await window.kimiDesktop.host.snapshot(),
      tabs: [...document.querySelectorAll('.workbench-tab-main')].map((tab) => ({ title: tab.getAttribute('title'), text: tab.textContent })),
    }));
    assert.fail(`Team tab did not restore: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error), restoreDiagnostic })}`);
  }
  await restoredTeamTab.click();
  await restoredPage.locator('.team-page').getByText('User follow-up from the Team channel.', { exact: true }).waitFor();
  assert.match(await restoredPage.locator('.team-page').innerText(), /界面侦察/);
  assert.match(await restoredPage.locator('.team-page').innerText(), /构建专家/);
  await selectSessionByTitle(restoredPage, 'Desktop E2E Session');
  await restoredPage.locator('.inspector-tabs button').nth(1).click();
  await restoredPage.waitForFunction(() => document.querySelectorAll('.inspector .agent-activity-row').length >= 3);
  assert.ok(
    await restoredPage.locator('.inspector .agent-activity-state').filter({ hasText: '已完成（保留）' }).count() >= 2,
    'completed child Agents were not restored as retained terminal transcripts',
  );
  const restoredDepths = await restoredPage.locator('.inspector .agent-activity-row').evaluateAll((rows) =>
    rows.map((row) => row.style.getPropertyValue('--agent-depth')),
  );
  assert.ok(restoredDepths.includes('1'), `restored Agent parentage is missing: ${JSON.stringify(restoredDepths)}`);
  await restoredPage.locator('.message-attachments img').last().waitFor({ state: 'visible', timeout: 30_000 });
  const restoredComposerHeight = await restoredPage.locator('.composer textarea').evaluate((element) => Math.round(element.getBoundingClientRect().height));
  assert.equal(restoredComposerHeight, persistedComposerHeight, 'composer height was not restored across app restart');
  await selectSessionByTitle(restoredPage, 'Desktop E2E Secondary');
  assert.equal(await restoredPage.locator('.todo-fixed-panel .todo-item').count(), 0, 'TodoList leaked across sessions');
  await assertActiveSessionSettings(restoredPage, {
    sessionId: secondarySessionId,
    model: 'desktop-test',
    thinkingEffort: 'off',
    permission: 'auto',
    planMode: true,
    swarmMode: false,
  });
  await selectSessionByTitle(restoredPage, 'Desktop E2E Session');
  await assertActiveSessionSettings(restoredPage, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });
  await restoredPage.evaluate((id) => window.kimiDesktop.session.reload(id), sessionId);
  await restoredPage.waitForFunction((_id) => document.body.innerText.includes('Desktop E2E Session'), sessionId);
  await assertActiveSessionSettings(restoredPage, {
    sessionId,
    model: 'desktop-test-alt',
    thinkingEffort: 'low',
    permission: 'manual',
    planMode: false,
    swarmMode: true,
  });
  await auditAndScreenshot(secondApp, restoredPage, 1_180, 760, join(artifactDir, 'kimi-desktop-1180x760.png'));
  await restoredPage.locator('.workbench-tab-main[title="sample.txt"]').click();
  await restoredPage.locator('.editor-view .monaco-editor').waitFor({ state: 'visible' });
  await auditAndScreenshot(secondApp, restoredPage, 1_180, 760, join(artifactDir, 'editor-git-1180x760.png'));

  await restoredPage.evaluate(() => window.kimiDesktop.extension.removePlugin('desktop-fixture'));
  extensions = await restoredPage.evaluate(() => window.kimiDesktop.extension.list());
  assert.equal(JSON.stringify(extensions.plugins).includes('desktop-fixture'), false);

  const sessionList = await restoredPage.evaluate(() => window.kimiDesktop.session.list());
  assert.equal(sessionList.filter((item) => item.id === sessionId).length, 1);
  assert.ok(provider.requests.length >= 8, `expected provider traffic, got ${provider.requests.length}`);
  assert.deepEqual(pageErrors, []);

  const report = {
    ok: true,
    sessionId,
    secondarySessionId,
    teamSessionId,
    providerRequests: provider.requests.length,
    providerAuthorizationObserved: provider.requests.some((request) => request.authorization === `Bearer ${providerToken}`),
    providerRetryAttempts: provider.transientAttempts,
    cancelledProviderStreams: provider.cancelledStreams,
    oauthRequests: provider.oauthRequests,
    restoredAgents: restored.transcript?.agents.length ?? 0,
    exportPath,
    screenshots: [
      join(artifactDir, 'workspace-welcome-1620x1040.png'),
      join(artifactDir, 'workspace-welcome-1180x760.png'),
      join(artifactDir, 'kimi-desktop-1620x1040.png'),
      join(artifactDir, 'kimi-desktop-1180x760.png'),
      join(artifactDir, 'editor-git-1620x1040.png'),
      join(artifactDir, 'editor-git-1180x760.png'),
      join(artifactDir, 'swarm-interactions-1620x1040.png'),
      join(artifactDir, 'swarm-interactions-1180x760.png'),
      join(artifactDir, 'swarm-completed-1620x1040.png'),
      join(artifactDir, 'swarm-completed-1180x760.png'),
      join(artifactDir, 'timeline-history-1620x1040.png'),
      join(artifactDir, 'timeline-history-1180x760.png'),
      join(artifactDir, 'team-activity-1620x1040.png'),
      join(artifactDir, 'team-activity-1180x760.png'),
      join(artifactDir, 'team-running-1620x1040.png'),
      join(artifactDir, 'team-running-1180x760.png'),
    ],
    processLogs,
  };
  assert.equal(report.providerAuthorizationObserved, true);
  assert.equal(provider.unsupportedSchemaCount, 0, 'provider rejected an unsupported Unicode tool pattern');
  await writeFile(join(artifactDir, 'e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ processLogs, pageErrors }, null, 2)}\n`);
  throw error;
} finally {
  provider?.releaseTeamWorkers();
  await bootstrapApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await firstApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await secondApp?.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await bootstrapApp?.close().catch(() => undefined);
  await firstApp?.close().catch(() => undefined);
  await secondApp?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  if (process.env.KIMI_DESKTOP_E2E_KEEP !== '1') {
    await removeWithRetry(fixtureRoot);
  } else {
    process.stdout.write(`Fixture retained at ${fixtureRoot}\n`);
  }
}

async function prepareWorkspace() {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const agentDir = join(kimiHome, 'agents');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(join(workspace, 'src', 'nested'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(samplePath, 'before\n', 'utf8'),
    writeFile(dualPath, 'dual base\n', 'utf8'),
    writeFile(nestedSourcePath, 'export const source = "base";\n', 'utf8'),
    writeFile(sampleImagePath, pixel),
    writeFile(secondImagePath, pixel),
    writeFile(oversizedImagePath, Buffer.alloc(25 * 1024 * 1024 + 1)),
    writeFile(join(agentDir, 'interactive-worker.md'), [
      '---',
      'name: interactive-worker',
      'description: Desktop E2E worker that can request approval or ask a question',
      'tools:',
      '  - Write',
      '  - AskUserQuestion',
      '---',
      '',
      'Run the requested fixture action. Your final response is the complete result for the caller.',
      '',
    ].join('\n'), 'utf8'),
  ]);
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'desktop-e2e@example.test'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'Desktop E2E'], { cwd: workspace });
  execFileSync('git', ['add', 'sample.txt', 'dual.txt', 'src/nested/source.ts', 'pixel.png', 'pixel-2.png'], { cwd: workspace });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: workspace });
}

async function preparePlugin() {
  await mkdir(join(pluginDir, 'commands'), { recursive: true });
  await writeFile(join(pluginDir, 'kimi.plugin.json'), JSON.stringify({
    name: 'desktop-fixture',
    version: '1.0.0',
    commands: './commands/',
  }), 'utf8');
  await writeFile(join(pluginDir, 'commands', 'verify.md'), [
    '---',
    'description: Verify the desktop fixture',
    '---',
    '',
    'Verify $ARGUMENTS',
    '',
  ].join('\n'), 'utf8');
}

async function writeConfig(baseUrl) {
  await writeFile(join(kimiHome, 'config.toml'), `default_model = "desktop-test"

[providers.local]
type = "kimi"
base_url = "${baseUrl}/v1"
api_key = "${providerToken}"

[models."desktop-test"]
provider = "local"
model = "mock-model"
max_context_size = 128000
capabilities = ["thinking", "tool_use"]
support_efforts = ["off", "low", "high"]

[models."desktop-test-alt"]
provider = "local"
model = "mock-model-alt"
max_context_size = 128000
capabilities = ["thinking", "tool_use"]
support_efforts = ["off", "low", "high"]

[loop_control]
max_attempts_per_step = 2
`, 'utf8');
}

async function launchDesktop() {
  return launchDesktopWith({ profile: electronProfile, workspaceOverride: workspace });
}

async function launchDesktopWith({ profile, workspaceOverride }) {
  const env = {
    ...process.env,
    KIMI_CODE_HOME: kimiHome,
    KIMI_DESKTOP_E2E: '1',
  };
  delete env.KIMI_DESKTOP_WORKSPACE;
  if (workspaceOverride !== undefined) env.KIMI_DESKTOP_WORKSPACE = workspaceOverride;
  const app = await electron.launch({
    executablePath: electronPath,
    args: [appDir, `--user-data-dir=${profile}`],
    cwd: appDir,
    env,
    timeout: 30_000,
  });
  const child = app.process();
  child.stdout?.on('data', (chunk) => processLogs.push(String(chunk).trim()));
  child.stderr?.on('data', (chunk) => processLogs.push(String(chunk).trim()));
  const page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  process.stdout.write(`[e2e] window=${page.url()} title=${await page.title()}\n`);
  await page.locator('.desktop-app').waitFor({ timeout: 30_000 });
  await page.waitForFunction(async () => (await window.kimiDesktop.host.snapshot()).loading === false, undefined, { timeout: 30_000 });
  return { app, page };
}

async function stopDesktop(app) {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function removeWithRetry(path) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (attempt + 1)));
    }
  }
  process.stderr.write(`[e2e] cleanup warning: ${lastError instanceof Error ? lastError.message : String(lastError)}\n`);
}

async function assertActiveSessionSettings(page, expected) {
  assert.equal(typeof expected.sessionId, 'string', 'expected session id is missing');
  await page.waitForFunction(async (target) => {
    const snapshot = await window.kimiDesktop.host.snapshot();
    const status = snapshot.session.status;
    const controls = document.querySelector('.session-controls[data-placement="composer"]');
    const model = controls?.querySelector('select[aria-label="模型"]');
    const thinking = controls?.querySelector('select[aria-label="Thinking"]');
    const permission = controls?.querySelector('select[aria-label="权限"]');
    const plan = controls?.querySelector('button[title="Plan 模式"]');
    return snapshot.activeSessionId === target.sessionId
      && status?.model === target.model
      && status.thinkingEffort === target.thinkingEffort
      && status.permission === target.permission
      && status.planMode === target.planMode
      && status.swarmMode === target.swarmMode
      && model?.value === target.model
      && thinking?.value === target.thinkingEffort
      && permission?.value === target.permission
      && plan?.getAttribute('aria-pressed') === String(target.planMode)
      && controls?.querySelector('button[title="Session Swarm 模式"]') === null;
  }, expected, { timeout: 30_000 });

  const authoritative = await page.evaluate(() => window.kimiDesktop.host.snapshot());
  const status = authoritative.session.status;
  assert.equal(authoritative.activeSessionId, expected.sessionId, JSON.stringify({
    activeSessionId: authoritative.activeSessionId,
    expectedSessionId: expected.sessionId,
    status,
  }));
  assert.equal(status?.model, expected.model, JSON.stringify({ status, config: authoritative.config.value }));
  assert.equal(status?.thinkingEffort, expected.thinkingEffort);
  assert.equal(status?.permission, expected.permission);
  assert.equal(status?.planMode, expected.planMode);
  assert.equal(status?.swarmMode, expected.swarmMode);
}

async function submitPrompt(page, prompt) {
  const composer = page.locator('.composer textarea');
  await composer.fill(prompt);
  await composer.press('Enter');
}

async function replaceMonacoText(page, value) {
  const editor = page.locator('.editor-view .monaco-editor').last();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(value);
  await page.waitForFunction(() => document.querySelector('.workbench-tab.active')?.classList.contains('dirty') === true);
}

async function appendMonacoText(page, value) {
  const editor = page.locator('.editor-view .monaco-editor').last();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(value);
  await page.waitForFunction(() => document.querySelector('.workbench-tab.active')?.classList.contains('dirty') === true);
}

async function waitForFileText(path, expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await readFile(path, 'utf8') === expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(await readFile(path, 'utf8'), expected);
}

async function approveProfileIfNeeded(page, path) {
  const approval = page.locator('.approval-panel');
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if ((await readFile(path, 'utf8')).includes('name: "fixture-researcher"')) return;
    } catch {
      // The profile has not been written yet.
    }
    if (await approval.isVisible().catch(() => false)) {
      assert.match(await approval.innerText(), /fixture-researcher|Agent profile/i);
      await approval.locator('.button-primary').click();
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const diagnostic = await page.evaluate(() => window.kimiDesktop.host.snapshot());
  throw new Error(`Team profile was not created: ${JSON.stringify({
    providerRequests: provider.requests.slice(-12),
    activeSessionId: diagnostic.activeSessionId,
    transcript: diagnostic.transcript,
    team: diagnostic.activeSessionId === undefined ? undefined : diagnostic.teams[diagnostic.activeSessionId],
  })}`);
}

async function returnToTeamChannel(page, teamPage) {
  const back = page.locator('.team-channel-back');
  if (await back.isVisible().catch(() => false)) await back.click();
  await teamPage.waitFor({ state: 'visible', timeout: 30_000 });
}

async function selectSessionByTitle(page, title) {
  await page.locator('.surface-switcher').getByRole('button', { name: '会话', exact: true }).click();
  await page.locator('.session-row').filter({ hasText: title }).locator('.session-main').click();
  await page.waitForFunction(async (expectedTitle) => {
    const snapshot = await window.kimiDesktop.host.snapshot();
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
    return active?.title === expectedTitle && document.querySelector('.composer') !== null;
  }, title, { timeout: 30_000 });
}

async function selectTeamByTitle(page, title) {
  await page.locator('.surface-switcher').getByRole('button', { name: '团队', exact: true }).click();
  await page.locator('.team-task-row').filter({ hasText: title }).click();
  await page.waitForFunction(async (expectedTitle) => {
    const snapshot = await window.kimiDesktop.host.snapshot();
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
    return active?.title === expectedTitle && document.querySelector('.team-page') !== null;
  }, title, { timeout: 30_000 });
}

async function waitForAssistant(page, value, timeout = 30_000) {
  await page.locator('.assistant-content').getByText(value, { exact: false }).last().waitFor({ state: 'visible', timeout });
}

async function openSettingsAndVerify(page) {
  await page.locator('.top-actions button').last().click();
  const dialog = page.locator('.settings-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('.settings-nav').getByRole('button', { name: '扩展', exact: true }).click();
  await dialog.getByText('desktop-fixture', { exact: false }).waitFor();
  await dialog.locator('.settings-nav').getByRole('button', { name: 'Agent 职业', exact: true }).click();
  await dialog.getByText('fixture-researcher', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '新建职业', exact: true }).click();
  await dialog.getByLabel('名称（kebab-case）').fill('desktop-reviewer');
  await dialog.getByLabel('职业描述').fill('Reviews Desktop changes');
  await dialog.getByLabel('何时使用（可选）').fill('Use for Desktop regressions.');
  await dialog.getByLabel('系统提示词').fill('Review Desktop changes and report focused risks.');
  await dialog.getByLabel('默认模型角色').selectOption('primary');
  await dialog.getByRole('button', { name: '创建职业', exact: true }).click();
  const managedProfile = dialog.locator('.profile-list-item').filter({ hasText: 'desktop-reviewer' });
  await managedProfile.waitFor({ state: 'visible' });
  await dialog.getByLabel('职业描述').fill('Reviews Desktop changes and tests');
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await managedProfile.getByText('Reviews Desktop changes and tests', { exact: true }).waitFor();
  page.once('dialog', (confirmation) => void confirmation.accept());
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await managedProfile.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(async () => (
    await window.kimiDesktop.profile.list()
  ).profiles.some((profile) => profile.id === 'workspace:desktop-reviewer')), false);
  await dialog.locator('.settings-nav').getByRole('button', { name: '诊断', exact: true }).click();
  assert.equal(await dialog.getByLabel(/团队协作/).count(), 0, 'Desktop-owned Team capability must not appear as an experimental toggle');
  await dialog.locator('.settings-nav').getByRole('button', { name: '账户', exact: true }).click();
  await dialog.getByText('未登录', { exact: true }).waitFor();
  await dialog.locator('.dialog-header .icon-button').click();
}

async function auditAndScreenshot(app, page, width, height, outputPath) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error('Desktop window is missing');
    window.setSize(size.width, size.height);
  }, { width, height });
  await page.waitForTimeout(350);
  const audit = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      textLength: document.body.innerText.trim().length,
      topbar: rect('.topbar'),
      sidebar: rect('.sidebar'),
      conversation: rect('.conversation-pane'),
      pendingDock: rect('.pending-interaction-dock'),
      composer: rect('.composer-wrap'),
      inspector: rect('.inspector'),
      bottomPanelCount: document.querySelectorAll('.bottom-panel').length,
    };
  });
  assert.ok(audit.textLength > 200, 'renderer is blank');
  assert.ok(audit.document.width <= audit.viewport.width + 1, JSON.stringify(audit));
  assert.ok(audit.document.height <= audit.viewport.height + 1, JSON.stringify(audit));
  assert.ok(audit.sidebar.right <= audit.conversation.left + 1, JSON.stringify(audit));
  assert.ok(audit.conversation.right <= audit.inspector.left + 1, JSON.stringify(audit));
  assert.equal(audit.bottomPanelCount, 0, JSON.stringify(audit));
  assert.ok(Math.abs(audit.sidebar.bottom - audit.conversation.bottom) <= 1, JSON.stringify(audit));
  assert.ok(Math.abs(audit.conversation.bottom - audit.inspector.bottom) <= 1, JSON.stringify(audit));
  if (audit.pendingDock !== null) {
    assert.ok(audit.pendingDock.left >= audit.conversation.left, JSON.stringify(audit));
    assert.ok(audit.pendingDock.right <= audit.conversation.right, JSON.stringify(audit));
    assert.ok(audit.pendingDock.bottom <= audit.composer.top + 1, JSON.stringify(audit));
  }
  await captureSanitizedFixtureScreenshot(page, outputPath);
  assert.ok((await stat(outputPath)).size > 20_000, 'screenshot is unexpectedly small');
}

async function auditTeamAndScreenshot(app, page, width, height, outputPath) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error('Desktop window is missing');
    window.setSize(size.width, size.height);
  }, { width, height });
  await page.waitForTimeout(350);
  const audit = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      tasks: rect('.team-task-sidebar'),
      detail: rect('.team-detail-pane'),
      channel: rect('.team-messages-column'),
      assignments: rect('.team-assignments'),
      chatSidebarCount: document.querySelectorAll('.sidebar').length,
      inspectorCount: document.querySelectorAll('.inspector').length,
    };
  });
  assert.ok(audit.tasks !== null && audit.detail !== null && audit.channel !== null && audit.assignments !== null, JSON.stringify(audit));
  assert.ok(audit.document.width <= audit.viewport.width + 1, JSON.stringify(audit));
  assert.ok(audit.document.height <= audit.viewport.height + 1, JSON.stringify(audit));
  assert.ok(audit.tasks.right <= audit.detail.left + 1, JSON.stringify(audit));
  assert.ok(audit.channel.right <= audit.assignments.left + 1, JSON.stringify(audit));
  assert.equal(audit.chatSidebarCount, 0, JSON.stringify(audit));
  assert.equal(audit.inspectorCount, 0, JSON.stringify(audit));
  await captureSanitizedFixtureScreenshot(page, outputPath);
  assert.ok((await stat(outputPath)).size > 20_000, 'Team screenshot is unexpectedly small');
}

async function auditWelcomeAndScreenshot(app, page, width, height, outputPath) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error('Desktop window is missing');
    window.setSize(size.width, size.height);
  }, { width, height });
  await page.waitForTimeout(350);
  const audit = await page.evaluate(() => {
    const welcome = document.querySelector('.workspace-welcome');
    const card = document.querySelector('.workspace-welcome-card');
    if (!(welcome instanceof HTMLElement) || !(card instanceof HTMLElement)) return null;
    const welcomeRect = welcome.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      welcome: { left: welcomeRect.left, right: welcomeRect.right, top: welcomeRect.top, bottom: welcomeRect.bottom },
      card: { left: cardRect.left, right: cardRect.right, top: cardRect.top, bottom: cardRect.bottom },
      workbenchCount: document.querySelectorAll('.workbench').length,
    };
  });
  assert.ok(audit !== null, 'workspace welcome is missing');
  assert.ok(audit.document.width <= audit.viewport.width + 1, JSON.stringify(audit));
  assert.ok(audit.document.height <= audit.viewport.height + 1, JSON.stringify(audit));
  assert.equal(audit.workbenchCount, 0, JSON.stringify(audit));
  assert.ok(audit.card.left >= audit.welcome.left, JSON.stringify(audit));
  assert.ok(audit.card.right <= audit.welcome.right, JSON.stringify(audit));
  assert.ok(audit.card.top >= audit.welcome.top, JSON.stringify(audit));
  assert.ok(audit.card.bottom <= audit.welcome.bottom, JSON.stringify(audit));
  await page.screenshot({ path: outputPath });
  assert.ok((await stat(outputPath)).size > 20_000, 'welcome screenshot is unexpectedly small');
}

async function captureSanitizedFixtureScreenshot(page, outputPath) {
  const originals = await page.evaluate(() => {
    const replacements = [
      { selector: '.workspace-title small', text: 'Fixture workspace' },
      { selector: '.session-copy small', text: 'Fixture session' },
      { selector: '.team-task-copy small', text: 'Fixture team task' },
      { selector: '.conversation-header > div > span', text: 'fixture-session' },
    ];
    return replacements.map(({ selector, text }) => {
      const elements = [...document.querySelectorAll(selector)];
      const values = elements.map((element) => element.textContent);
      for (const element of elements) element.textContent = text;
      return { selector, values };
    });
  });
  try {
    await page.screenshot({ path: outputPath });
  } finally {
    await page.evaluate((replacements) => {
      for (const { selector, values } of replacements) {
        const elements = [...document.querySelectorAll(selector)];
        for (let index = 0; index < elements.length; index += 1) {
          elements[index].textContent = values[index] ?? '';
        }
      }
    }, originals);
  }
}

async function startProvider() {
  const requests = [];
  const oauthRequests = [];
  let responseId = 0;
  let transientAttempts = 0;
  let cancelledStreams = 0;
  let unsupportedSchemaCount = 0;
  let releaseTeamWorkers;
  const teamWorkersGate = new Promise((resolvePromise) => {
    releaseTeamWorkers = resolvePromise;
  });
  const handleRequest = async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/api/oauth/device_authorization') {
        oauthRequests.push('device_authorization');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          user_code: 'DESKTOP-E2E',
          device_code: 'desktop-device-code',
          verification_uri: 'https://desktop-e2e.invalid/verify',
          verification_uri_complete: 'https://desktop-e2e.invalid/verify?user_code=DESKTOP-E2E',
          expires_in: 60,
          interval: 0,
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/oauth/token') {
        oauthRequests.push('token');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          access_token: 'desktop-oauth-access',
          refresh_token: 'desktop-oauth-refresh',
          expires_in: 3_600,
          scope: '',
          token_type: 'Bearer',
        }));
        return;
      }
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [
          { id: 'mock-model', context_length: 128000, supports_reasoning: true },
          { id: 'mock-model-alt', context_length: 128000, supports_reasoning: true },
        ] }));
        return;
      }
      if (request.method === 'GET' && request.url?.endsWith('/usages')) {
        oauthRequests.push('usage');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ usage: { name: 'Desktop fixture', used: '2', limit: '10' }, limits: [] }));
        return;
      }
      if (request.method === 'POST' && request.url?.endsWith('/feedback')) {
        oauthRequests.push('feedback');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ feedback_id: 42 }));
        return;
      }
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (containsUnsupportedUnicodePattern(body.tools)) {
        unsupportedSchemaCount += 1;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: { message: 'Invalid schema: Unicode property escapes are not supported in tool patterns.' },
        }));
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages.at(-1) ?? {};
      const lastText = messageText(last);
      const promptText = messageText(messages.findLast((message) =>
        message?.role === 'user' && !messageText(message).trimStart().startsWith('<system-reminder>'),
      ));
      const historyText = messages.map(messageText).join('\n');
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        role: last.role,
        toolName: last.role === 'tool' ? findToolName(messages, last.tool_call_id) : undefined,
        messageCount: messages.length,
        prompt: lastText,
        hasImage: JSON.stringify(messages).includes('image_url'),
      });

      if (historyText.includes('Launch a Team Mode batch and wait for live updates.')) {
        if (hasToolCall(messages, 'AgentSwarm')) {
          const waitResults = messages.filter((message) => message.role === 'tool'
            && findToolName(messages, message.tool_call_id) === 'TeamWait');
          if (waitResults.some((message) => messageText(message).includes('"type":"message.sent"'))) {
            return sendText(response, 'Team coordination resumed after a live message.', ++responseId);
          }
          const waitNumber = waitResults.length + 1;
          return sendTool(response, 'TeamWait', { timeout_seconds: 10 }, `team-wait-call-${String(waitNumber)}`, ++responseId);
        }
      }
      if (historyText.includes('team-alpha') && !hasToolCall(messages, 'TeamSend')) {
        await teamWorkersGate;
        return sendTool(response, 'TeamSend', {
          message: '界面检查完成\n换行可见\n@构建专家 请继续验证',
        }, 'team-send-alpha', ++responseId);
      }
      if (historyText.includes('team-beta') && !hasToolCall(messages, 'TeamSend')) {
        await teamWorkersGate;
        return sendTool(response, 'TeamSend', {
          message: ['@界面侦察 已收到', ...Array.from({ length: 32 }, (_, index) => `验证行 ${String(index + 1).padStart(2, '0')}`)].join('\n'),
        }, 'team-send-beta', ++responseId);
      }

      if (last.role === 'tool') {
        const toolName = findToolName(messages, last.tool_call_id);
        if (toolName === 'Edit') return sendText(response, 'Edited sample.txt through approved tool.', ++responseId);
        if (toolName === 'Write') {
          return sendText(
            response,
            historyText.includes('Write operation record for the file timeline.')
              ? 'Wrote record-write.txt through approved tool.'
              : 'Alpha permission resolved.',
            ++responseId,
          );
        }
        if (toolName === 'Read') return sendText(response, 'Read record-write.txt through the tool timeline.', ++responseId);
        if (toolName === 'AskUserQuestion') {
          return sendText(response, historyText.includes('Review beta') ? 'Beta question resolved.' : 'Question answered with the selected target.', ++responseId);
        }
        if (toolName === 'AgentSwarm') {
          if (historyText.includes('Launch a Team Mode batch and wait for live updates.')) {
            return sendTool(response, 'TeamWait', { timeout_seconds: 10 }, 'team-wait-call-1', ++responseId);
          }
          return sendText(response, 'Swarm complete with two agent results.', ++responseId);
        }
        if (toolName === 'TeamSend') {
          return sendText(
            response,
            historyText.includes('team-alpha') ? 'Team alpha completed.' : 'Team beta completed.',
            ++responseId,
          );
        }
        if (toolName === 'TeamWait') {
          return sendText(response, 'Team coordination resumed after a live message.', ++responseId);
        }
        if (toolName === 'TodoList') return sendText(response, 'TodoList updated by Kimi.', ++responseId);
      }
      if (promptText.includes('Edit sample.txt through an approval request.')) {
        return sendTool(response, 'Edit', {
          path: 'sample.txt', old_string: 'before', new_string: 'after',
        }, 'edit-call-1', ++responseId);
      }
      if (promptText.includes('Write operation record for the file timeline.')) {
        return sendTool(response, 'Write', {
          path: 'record-write.txt', content: 'written by tool\n',
        }, 'write-record-call-1', ++responseId);
      }
      if (promptText.includes('Read operation record from the file timeline.')) {
        return sendTool(response, 'Read', {
          path: 'record-write.txt',
        }, 'read-record-call-1', ++responseId);
      }
      if (promptText.includes('Ask me which verification target to run.')) {
        return sendTool(response, 'AskUserQuestion', {
          questions: [{
            question: 'Which target should run?',
            header: 'Target',
            options: [
              { label: 'Focused tests', description: 'Run the desktop suite' },
              { label: 'Full suite', description: 'Run every repository test' },
            ],
            multi_select: false,
          }],
        }, 'question-call-1', ++responseId);
      }
      if (promptText.includes('Render the attached image in the transcript.')) {
        return sendText(response, 'Attached image rendered.', ++responseId);
      }
      if (promptText.includes('Create a TodoList with one running and one pending desktop task.')) {
        return sendTool(response, 'TodoList', {
          todos: [
            { title: 'Inspect desktop runtime', status: 'in_progress' },
            { title: 'Run desktop tests', status: 'pending' },
          ],
        }, 'todo-call-1', ++responseId);
      }
      if (promptText.includes('Run a two-agent swarm over alpha and beta.')) {
        return sendTool(response, 'AgentSwarm', {
          description: 'Review fixtures',
          prompt_template: 'Review {{item}} and report one finding.',
          items: ['alpha', 'beta'],
          subagent_type: 'interactive-worker',
        }, 'swarm-call-1', ++responseId);
      }
      if (promptText.includes('Launch a Team Mode batch and wait for live updates.')) {
        if (!hasToolCall(messages, 'AgentProfileCreate')) {
          return sendTool(response, 'AgentProfileCreate', {
            name: 'fixture-researcher',
            description: 'Validates long Team channel updates',
            when_to_use: 'Use for long-form Team fixture verification.',
            prompt: 'Inspect the assigned fixture, coordinate through TeamSend, and report a concise result.',
            scope: 'workspace',
          }, 'team-profile-create-call-1', ++responseId);
        }
        return sendTool(response, 'AgentSwarm', {
          description: 'Coordinate Team Mode fixtures',
          prompt_template: 'Inspect {{item}}, send one update with TeamSend, then finish.',
          items: [
            { item: 'team-alpha', display_name: '界面侦察', subagent_type: 'explore', model: 'desktop-test' },
            { item: 'team-beta', display_name: '构建专家', subagent_type: 'fixture-researcher', model: 'desktop-test-alt' },
          ],
        }, 'team-swarm-call-1', ++responseId);
      }
      if (promptText.includes('Inspect team-alpha, send one update with TeamSend, then finish.')) {
        await teamWorkersGate;
        return sendTool(response, 'TeamSend', {
          message: '界面检查完成\n换行可见\n@构建专家 请继续验证',
        }, 'team-send-alpha', ++responseId);
      }
      if (promptText.includes('Inspect team-beta, send one update with TeamSend, then finish.')) {
        await teamWorkersGate;
        return sendTool(response, 'TeamSend', {
          message: ['@界面侦察 已收到', ...Array.from({ length: 32 }, (_, index) => `验证行 ${String(index + 1).padStart(2, '0')}`)].join('\n'),
        }, 'team-send-beta', ++responseId);
      }
      if (promptText.includes('Recover after one transient provider failure.')) {
        transientAttempts += 1;
        if (transientAttempts === 1) {
          response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
          response.end(JSON.stringify({ error: { message: 'transient desktop fixture failure' } }));
          return;
        }
        return sendText(response, 'Recovered after the transient provider failure.', ++responseId);
      }
      if (promptText.includes('Hold this turn until I cancel it.')) {
        response.once('close', () => { cancelledStreams += 1; });
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(`data: ${JSON.stringify(completionChunk({ content: 'Waiting for cancellation...' }, null, ++responseId))}\n\n`);
        return;
      }
      if (promptText.includes('Review alpha') || historyText.includes('Review alpha')) {
        return sendTool(response, 'Write', {
          path: 'swarm-alpha.txt',
          content: 'swarm-approved\n',
        }, 'swarm-write-alpha', ++responseId);
      }
      if (promptText.includes('Review beta') || historyText.includes('Review beta')) {
        return sendTool(response, 'AskUserQuestion', {
          questions: [{
            question: 'Approve the beta verification target?',
            header: 'Beta target',
            options: [
              { label: 'Focused', description: 'Run the focused target' },
              { label: 'Full', description: 'Run the full target' },
            ],
            multi_select: false,
          }],
        }, 'swarm-question-beta', ++responseId);
      }
      return sendText(response, 'Desktop fixture response.', ++responseId);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Provider did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    oauthRequests,
    get transientAttempts() { return transientAttempts; },
    get cancelledStreams() { return cancelledStreams; },
    get unsupportedSchemaCount() { return unsupportedSchemaCount; },
    releaseTeamWorkers: () => { releaseTeamWorkers(); },
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error))),
  };
}

function containsUnsupportedUnicodePattern(value) {
  if (Array.isArray(value)) return value.some(containsUnsupportedUnicodePattern);
  if (value === null || typeof value !== 'object') return false;
  if (typeof value.pattern === 'string' && value.pattern.includes('\\p{')) return true;
  return Object.values(value).some(containsUnsupportedUnicodePattern);
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => typeof part === 'string' ? part : part?.text ?? '').join(' ');
}

function findToolName(messages, toolCallId) {
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const calls = messages[index]?.tool_calls;
    if (!Array.isArray(calls)) continue;
    const call = calls.find((candidate) => candidate.id === toolCallId);
    if (call !== undefined) return call.function?.name;
  }
  return undefined;
}

function hasToolCall(messages, toolName) {
  return messages.some((message) => Array.isArray(message?.tool_calls)
    && message.tool_calls.some((call) => call?.function?.name === toolName));
}

function sendText(response, content, id) {
  sendSse(response, [completionChunk({ content }, null, id), completionChunk({}, 'stop', id)]);
}

function sendTool(response, name, args, toolCallId, id) {
  sendSse(response, [
    completionChunk({
      tool_calls: [{
        index: 0,
        id: toolCallId,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    }, null, id),
    completionChunk({}, 'tool_calls', id),
  ]);
}

function sendSse(response, chunks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function completionChunk(delta, finishReason, id) {
  const chunk = {
    id: `chatcmpl-desktop-${id}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (finishReason !== null) {
    chunk.usage = {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 60 },
    };
  }
  return chunk;
}
