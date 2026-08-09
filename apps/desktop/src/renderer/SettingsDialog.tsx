import { useMemo, useState } from 'react';
import {
  Activity,
  Blocks,
  Bot,
  Check,
  CircleAlert,
  Cloud,
  FlaskConical,
  FolderOpen,
  KeyRound,
  LogIn,
  LogOut,
  MessageSquareText,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';

import type { DesktopSnapshot, JsonRecord } from '../shared/desktop-api';
import {
  experimentalFeatureSourceLabel,
  isVisibleDesktopExperimentalFeature,
  localizeExperimentalFeature,
} from './experimental-features';
import { array, bool, classNames, formatJson, number, record, text } from './ui-utils';

type SettingsTab = 'account' | 'models' | 'mcp' | 'extensions' | 'workspace' | 'diagnostics';

export function SettingsDialog({ snapshot, onClose }: { readonly snapshot: DesktopSnapshot; readonly onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>('account');
  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'account', label: '账户', icon: <UserRound size={15} /> },
    { id: 'models', label: '模型与 Provider', icon: <Bot size={15} /> },
    { id: 'mcp', label: 'MCP', icon: <Plug size={15} /> },
    { id: 'extensions', label: '扩展', icon: <Blocks size={15} /> },
    { id: 'workspace', label: '工作区', icon: <ShieldCheck size={15} /> },
    { id: 'diagnostics', label: '诊断', icon: <Activity size={15} /> },
  ];
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Kimi Code Desktop 设置">
        <header className="dialog-header">
          <div><Settings2 size={17} /><strong>设置</strong></div>
          <button className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav">
            {tabs.map((item) => <button className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} key={item.id}>{item.icon}<span>{item.label}</span></button>)}
          </nav>
          <main className="settings-content">
            {tab === 'account' && <AccountSettings snapshot={snapshot} />}
            {tab === 'models' && <ModelSettings snapshot={snapshot} />}
            {tab === 'mcp' && <McpSettings snapshot={snapshot} />}
            {tab === 'extensions' && <ExtensionSettings snapshot={snapshot} />}
            {tab === 'workspace' && <WorkspaceSettings snapshot={snapshot} />}
            {tab === 'diagnostics' && <DiagnosticsSettings snapshot={snapshot} />}
          </main>
        </div>
      </div>
    </div>
  );
}

function AccountSettings({ snapshot }: { readonly snapshot: DesktopSnapshot }) {
  const [usage, setUsage] = useState<unknown>();
  const [feedback, setFeedback] = useState('');
  const [contact, setContact] = useState('');
  const providers = array(record(snapshot.auth)['providers']);
  const signedIn = providers.some((raw) => bool(record(raw)['hasToken']));
  return (
    <SettingsPage title="Kimi 账户" description="OAuth 凭据由主进程保存，renderer 不会读取 token。">
      <section className="settings-section">
        <div className="account-status">
          <span className={classNames('account-icon', signedIn && 'signed-in')}>{signedIn ? <Check size={17} /> : <KeyRound size={17} />}</span>
          <div><strong>{signedIn ? '已登录 Kimi Code' : '未登录'}</strong><small>{signedIn ? '托管模型与用量服务可用' : '可继续使用已配置的自定义 Provider'}</small></div>
          {signedIn
            ? <button onClick={() => void window.kimiDesktop.auth.logout()}><LogOut size={14} />退出</button>
            : <button className="button-primary" onClick={() => void window.kimiDesktop.auth.login()}><LogIn size={14} />OAuth 登录</button>}
        </div>
        <div className="settings-actions">
          <button onClick={() => void window.kimiDesktop.auth.status()}><RefreshCw size={13} />刷新状态</button>
          <button disabled={!signedIn} onClick={() => void window.kimiDesktop.auth.usage().then(setUsage)}><Cloud size={13} />托管用量</button>
        </div>
        {usage !== undefined && <pre className="settings-json">{formatJson(usage)}</pre>}
      </section>
      <section className="settings-section">
        <h3><MessageSquareText size={15} />反馈</h3>
        <textarea rows={5} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="描述问题或建议" />
        <div className="inline-form"><input value={contact} onChange={(event) => setContact(event.target.value)} placeholder="联系方式（可选）" /><button disabled={!signedIn || feedback.trim().length === 0} onClick={() => {
          void window.kimiDesktop.auth.feedback(feedback.trim(), contact.trim() || undefined);
          setFeedback('');
        }}>提交反馈</button></div>
      </section>
    </SettingsPage>
  );
}

function ModelSettings({ snapshot }: { readonly snapshot: DesktopSnapshot }) {
  const config = snapshot.config.value;
  const providers = record(config['providers']);
  const models = record(config['models']);
  const [providerId, setProviderId] = useState('');
  const [providerType, setProviderType] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(text(config['defaultModel']));
  const saveProvider = async () => {
    const id = providerId.trim();
    if (id.length === 0) return;
    await window.kimiDesktop.config.set({
      providers: {
        [id]: {
          type: providerType,
          baseUrl: baseUrl.trim() || undefined,
          apiKey: apiKey || undefined,
        },
      },
    });
    setProviderId('');
    setBaseUrl('');
    setApiKey('');
  };
  return (
    <SettingsPage title="模型与 Provider" description="密钥字段只写不读；已配置状态以占位符显示。">
      <section className="settings-section">
        <h3>默认模型</h3>
        <div className="inline-form"><input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} placeholder="model alias" /><button onClick={() => void window.kimiDesktop.config.set({ defaultModel: defaultModel.trim() || undefined })}>保存</button></div>
        <div className="model-grid">
          {Object.entries(models).map(([id, raw]) => {
            const model = record(raw);
            return <div className="model-row" key={id}><div><strong>{text(model['displayName'], id)}</strong><small>{text(model['provider'])} · {text(model['model'])}</small></div><span>{number(model['maxContextSize']) || ''}</span></div>;
          })}
          {Object.keys(models).length === 0 && <div className="settings-empty">尚未配置模型 alias</div>}
        </div>
      </section>
      <section className="settings-section">
        <h3>Providers</h3>
        <div className="provider-list">
          {Object.entries(providers).map(([id, raw]) => {
            const provider = record(raw);
            return (
              <div className="provider-row" key={id}>
                <span className="provider-icon"><Cloud size={14} /></span>
                <div><strong>{id}</strong><small>{text(provider['type'])} · {text(provider['baseUrl'], 'default endpoint')}</small></div>
                {provider['apiKey'] !== undefined && <em>key configured</em>}
                <button className="icon-button danger" onClick={() => void window.kimiDesktop.config.removeProvider(id)} title="移除 Provider"><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
      </section>
      <section className="settings-section">
        <h3><Plus size={14} />自定义 Provider</h3>
        <div className="form-grid">
          <label><span>ID</span><input value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="example-provider" /></label>
          <label><span>类型</span><select value={providerType} onChange={(event) => setProviderType(event.target.value)}><option value="openai">OpenAI</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="kimi">Kimi</option><option value="google-genai">Google GenAI</option><option value="vertexai">Vertex AI</option></select></label>
          <label className="span-two"><span>Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.test/v1" /></label>
          <label className="span-two"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="只写字段" autoComplete="new-password" /></label>
        </div>
        <button className="button-primary" disabled={providerId.trim().length === 0} onClick={() => void saveProvider()}>添加 Provider</button>
      </section>
    </SettingsPage>
  );
}

function McpSettings({ snapshot }: { readonly snapshot: DesktopSnapshot }) {
  const [draft, setDraft] = useState('{\n  "name": "example",\n  "transport": "stdio",\n  "command": "example-mcp"\n}');
  const [parseError, setParseError] = useState('');
  const authByName = useMemo(() => new Map(snapshot.globalMcpAuth.map((raw) => {
    const item = record(raw);
    return [text(item['name']), item] as const;
  })), [snapshot.globalMcpAuth]);
  const add = async () => {
    try {
      const server = JSON.parse(draft) as JsonRecord;
      setParseError('');
      await window.kimiDesktop.mcp.add(server);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <SettingsPage title="MCP" description="管理全局 MCP；会话级连接状态显示在每个条目中。">
      <section className="settings-section">
        <div className="section-title-row"><h3>全局服务器</h3><button onClick={() => void window.kimiDesktop.mcp.list()}><RefreshCw size={13} />刷新</button></div>
        <div className="mcp-list">
          {snapshot.globalMcpServers.map((raw, index) => {
            const server = record(raw);
            const name = text(server['name'], `mcp-${index}`);
            const auth = authByName.get(name);
            const authState = text(auth?.['status']);
            return (
              <div className="mcp-row" key={name}>
                <span className="provider-icon"><Plug size={14} /></span>
                <div><strong>{name}</strong><small>{text(server['transport'])} · {text(server['url'], text(server['command']))}</small></div>
                <span className={classNames('mcp-state', authState === 'authorized' && 'connected')}>{authState || (server['enabled'] === false ? 'disabled' : 'configured')}</span>
                <div className="row-actions">
                  <button disabled={snapshot.workspace.root.length === 0} onClick={() => void window.kimiDesktop.mcp.test(name)} title={snapshot.workspace.root.length === 0 ? '选择工作区后可测试' : '连通性测试'}><Activity size={13} /></button>
                  {server['auth'] === 'oauth' && <button onClick={() => void window.kimiDesktop.mcp.authenticate(name)} title="OAuth"><KeyRound size={13} /></button>}
                  {authState === 'authorized' && <button onClick={() => void window.kimiDesktop.mcp.resetAuth(name)} title="重置 OAuth"><RefreshCw size={13} /></button>}
                  <button className="danger" onClick={() => void window.kimiDesktop.mcp.remove(name)} title="移除"><Trash2 size={13} /></button>
                </div>
              </div>
            );
          })}
          {snapshot.globalMcpServers.length === 0 && <div className="settings-empty">没有全局 MCP 服务器</div>}
        </div>
      </section>
      <section className="settings-section">
        <h3>当前会话 MCP</h3>
        <div className="mcp-list">
          {snapshot.session.mcpServers.map((raw, index) => {
            const server = record(raw);
            const name = text(server['name'], `session-mcp-${index}`);
            const status = text(server['status'], 'pending');
            return (
              <div className="mcp-row" key={name}>
                <span className="provider-icon"><Plug size={14} /></span>
                <div><strong>{name}</strong><small>{text(server['transport'])} · {number(server['toolCount'])} tools</small></div>
                <span className={classNames('mcp-state', status === 'connected' && 'connected')}>{status}</span>
                <button className="icon-button" disabled={snapshot.activeSessionId === undefined} onClick={() => void window.kimiDesktop.mcp.reconnect(name, snapshot.activeSessionId)} title="重新连接"><RefreshCw size={13} /></button>
              </div>
            );
          })}
          {snapshot.session.mcpServers.length === 0 && <div className="settings-empty">当前会话没有 MCP 连接</div>}
        </div>
        <div className="startup-metric"><span>启动指标</span><code>{formatJson(snapshot.session.mcpStartupMetrics ?? {})}</code></div>
      </section>
      <section className="settings-section">
        <h3><Plus size={14} />添加 MCP</h3>
        <textarea className="code-input" rows={9} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
        {parseError.length > 0 && <div className="form-error"><CircleAlert size={13} />{parseError}</div>}
        <button className="button-primary" onClick={() => void add()}>添加服务器</button>
      </section>
    </SettingsPage>
  );
}

function ExtensionSettings({ snapshot }: { readonly snapshot: DesktopSnapshot }) {
  const [source, setSource] = useState('');
  return (
    <SettingsPage title="扩展" description="管理 Skills、插件、插件 MCP 和内置 Capabilities。">
      <section className="settings-section">
        <div className="section-title-row"><h3>插件</h3><button onClick={() => void window.kimiDesktop.extension.reloadPlugins()}><RefreshCw size={13} />重载</button></div>
        <div className="extension-list">
          {snapshot.extensions.plugins.map((raw, index) => {
            const plugin = record(raw);
            const id = text(plugin['id'], text(plugin['name'], `plugin-${index}`));
            const enabled = plugin['enabled'] !== false;
            return (
              <div className="plugin-entry" key={id}>
                <div className="extension-row">
                  <span className="extension-icon"><Blocks size={14} /></span>
                  <div><strong>{text(plugin['displayName'], text(plugin['name'], id))}</strong><small>{text(plugin['version'])} · {text(plugin['originalSource'], text(plugin['source']))}</small></div>
                  <button className={classNames('toggle', enabled && 'on')} onClick={() => void window.kimiDesktop.extension.togglePlugin(id, !enabled)} aria-label={enabled ? '禁用插件' : '启用插件'}><span /></button>
                  <button className="icon-button danger" onClick={() => void window.kimiDesktop.extension.removePlugin(id)} title="移除插件"><Trash2 size={13} /></button>
                </div>
                {array(plugin['mcpServers']).map((rawServer, serverIndex) => {
                  const server = record(rawServer);
                  const name = text(server['name'], `mcp-${serverIndex}`);
                  const serverEnabled = server['enabled'] !== false;
                  return <div className="plugin-mcp-row" key={name}><Plug size={12} /><span>{name}<small>{text(server['transport'])} · {text(server['runtimeName'])}</small></span><button className={classNames('toggle', serverEnabled && 'on')} onClick={() => void window.kimiDesktop.extension.togglePluginMcp(id, name, !serverEnabled)} aria-label={serverEnabled ? `禁用 ${name}` : `启用 ${name}`}><span /></button></div>;
                })}
              </div>
            );
          })}
          {snapshot.extensions.plugins.length === 0 && <div className="settings-empty">没有安装插件</div>}
        </div>
        <div className="inline-form"><input value={source} onChange={(event) => setSource(event.target.value)} placeholder="插件目录或 GitHub source" /><button disabled={source.trim().length === 0} onClick={() => {
          void window.kimiDesktop.extension.installPlugin(source.trim());
          setSource('');
        }}><Plus size={13} />安装</button></div>
      </section>
      <section className="settings-section">
        <h3>Capabilities</h3>
        <div className="capability-grid">
          {snapshot.extensions.capabilities.map((raw, index) => {
            const capability = record(raw);
            const id = text(capability['id'], `capability-${index}`);
            const state = text(capability['state'], 'not_installed');
            const ready = state === 'ready';
            const supported = capability['supported'] !== false;
            return <div className="capability-row" key={id}><span><Sparkles size={14} /></span><div><strong>{text(capability['displayName'], id)}</strong><small>{state}{text(capability['version']).length > 0 ? ` · ${text(capability['version'])}` : ''}</small></div>{ready ? <Check size={14} /> : <button disabled={!supported || bool(record(capability['install'])['running'])} onClick={() => void window.kimiDesktop.extension.installCapability(id)}>{supported ? '安装' : '不支持'}</button>}</div>;
          })}
        </div>
      </section>
      <section className="settings-section">
        <h3>Workspace Skills</h3>
        <div className="skill-list">
          {snapshot.extensions.workspaceSkills.map((raw, index) => {
            const skill = record(raw);
            return <div className="skill-row" key={text(skill['name'], `skill-${index}`)}><Sparkles size={13} /><div><strong>{text(skill['name'])}</strong><small>{text(skill['description'], text(skill['path']))}</small></div><em>{text(skill['source'])}</em></div>;
          })}
          {snapshot.extensions.workspaceSkills.length === 0 && <div className="settings-empty">{snapshot.workspace.root.length === 0 ? '选择工作区后显示 Workspace Skills' : '当前工作区没有 Skills'}</div>}
        </div>
      </section>
    </SettingsPage>
  );
}

function WorkspaceSettings({ snapshot }: { readonly snapshot: DesktopSnapshot }) {
  if (snapshot.workspace.root.length === 0) {
    return (
      <SettingsPage title="工作区" description="尚未选择工作区">
        <section className="settings-section">
          <div className="trust-status">
            <span className="account-icon"><FolderOpen size={17} /></span>
            <div><strong>选择一个工作区</strong><small>选择后才能使用文件、Git、会话和工作区 Skills。</small></div>
            <button className="button-primary" onClick={() => void window.kimiDesktop.workspace.choose()}>打开工作区</button>
          </div>
        </section>
      </SettingsPage>
    );
  }
  return (
    <SettingsPage title="工作区" description={snapshot.workspace.root}>
      <section className="settings-section">
        <div className="trust-status">
          <span className={classNames('account-icon', snapshot.workspace.trusted && 'signed-in')}>{snapshot.workspace.trusted ? <ShieldCheck size={17} /> : <CircleAlert size={17} />}</span>
          <div><strong>{snapshot.workspace.trusted ? '工作区已信任' : '工作区未信任'}</strong><small>{snapshot.workspace.trusted ? '项目 MCP 与本地能力可按配置启用' : `${snapshot.workspace.gatedMcpServers.length} 个 MCP 等待信任`}</small></div>
          {!snapshot.workspace.trusted && <button className="button-primary" onClick={() => void window.kimiDesktop.workspace.trust()}>信任工作区</button>}
        </div>
      </section>
      <section className="settings-section">
        <h3>会话工作区操作</h3>
        <div className="settings-actions wrap">
          <button disabled={snapshot.activeSessionId === undefined} onClick={() => void window.kimiDesktop.context.initAgents(snapshot.activeSessionId)}>初始化 AGENTS.md</button>
          <button onClick={() => void window.kimiDesktop.workspace.refresh()}><RefreshCw size={13} />刷新文件与 Git</button>
        </div>
      </section>
    </SettingsPage>
  );
}

function DiagnosticsSettings({ snapshot }: { readonly snapshot: DesktopSnapshot }) {
  const [updatingFeature, setUpdatingFeature] = useState<string>();
  const [featureError, setFeatureError] = useState('');
  const setFeatureEnabled = async (id: string, enabled: boolean) => {
    setUpdatingFeature(id);
    setFeatureError('');
    try {
      await window.kimiDesktop.config.set({ experimental: { [id]: enabled } });
    } catch (error) {
      setFeatureError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingFeature(undefined);
    }
  };
  const visibleFeatures = snapshot.config.experimentalFeatures.filter(isVisibleDesktopExperimentalFeature);
  return (
    <SettingsPage title="诊断与实验特性" description="启动配置、校验结果与原始事件均已脱敏。">
      <section className="settings-section">
        <h3>配置</h3>
        <div className="path-row">{snapshot.config.path}</div>
        <pre className="settings-json">{formatJson(snapshot.config.diagnostics)}</pre>
      </section>
      <section className="settings-section">
        <h3><FlaskConical size={14} />实验特性</h3>
        <div className="feature-list">
          {visibleFeatures.map((raw, index) => {
            const feature = record(raw);
            const id = text(feature['id'], `feature-${index}`);
            const enabled = bool(feature['enabled']);
            const source = text(feature['source']);
            const locked = source === 'env' || source === 'master-env';
            const copy = localizeExperimentalFeature(id);
            const sourceLabel = experimentalFeatureSourceLabel(source);
            return (
              <div className="feature-row" key={id}>
                <div>
                  <strong>{copy.title}</strong>
                  <small>{copy.description}</small>
                </div>
                <button
                  className={classNames('toggle', enabled && 'on')}
                  disabled={locked || updatingFeature === id}
                  aria-label={`${enabled ? '禁用' : '启用'}${copy.title}`}
                  title={locked ? `由${sourceLabel}控制 · 技术标识：${id}` : `技术标识：${id} · 来源：${sourceLabel}`}
                  onClick={() => void setFeatureEnabled(id, !enabled)}
                ><span /></button>
              </div>
            );
          })}
          {visibleFeatures.length === 0 && <div className="settings-empty">没有实验特性</div>}
        </div>
        {featureError.length > 0 && <div className="form-error"><CircleAlert size={13} />{featureError}</div>}
      </section>
      <section className="settings-section">
        <h3>启动与事件</h3>
        <pre className="settings-json">{formatJson({ rawEventCount: snapshot.rawEvents.length, workspace: snapshot.workspace, activeSessionId: snapshot.activeSessionId })}</pre>
      </section>
    </SettingsPage>
  );
}

function SettingsPage({ title, description, children }: { readonly title: string; readonly description: string; readonly children: React.ReactNode }) {
  return (
    <div className="settings-page">
      <div className="settings-page-heading"><h2>{title}</h2><p>{description}</p></div>
      {children}
    </div>
  );
}
