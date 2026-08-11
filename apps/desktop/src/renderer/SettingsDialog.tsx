import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Blocks,
  Bot,
  BriefcaseBusiness,
  Check,
  CircleAlert,
  Cloud,
  Download,
  ExternalLink,
  FlaskConical,
  FolderOpen,
  KeyRound,
  Info,
  LogIn,
  LogOut,
  MessageSquareText,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';

import type {
  AgentProfileDescriptor,
  AgentProfileDraft,
  AgentProfileListResult,
  DesktopSnapshot,
  DesktopUpdateSnapshot,
  JsonRecord,
} from '../shared/desktop-api';
import {
  experimentalFeatureSourceLabel,
  isVisibleDesktopExperimentalFeature,
  localizeExperimentalFeature,
} from './experimental-features';
import { array, bool, classNames, formatJson, number, record, text } from './ui-utils';

export type SettingsTab = 'account' | 'models' | 'profiles' | 'mcp' | 'extensions' | 'workspace' | 'diagnostics' | 'about';

export function SettingsDialog({
  snapshot,
  initialTab,
  onClose,
}: {
  readonly snapshot: DesktopSnapshot;
  readonly initialTab?: SettingsTab;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'account');
  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'account', label: '账户', icon: <UserRound size={15} /> },
    { id: 'models', label: '模型与 Provider', icon: <Bot size={15} /> },
    { id: 'profiles', label: 'Agent 职业', icon: <BriefcaseBusiness size={15} /> },
    { id: 'mcp', label: 'MCP', icon: <Plug size={15} /> },
    { id: 'extensions', label: '扩展', icon: <Blocks size={15} /> },
    { id: 'workspace', label: '工作区', icon: <ShieldCheck size={15} /> },
    { id: 'diagnostics', label: '诊断', icon: <Activity size={15} /> },
    { id: 'about', label: '关于与更新', icon: <Info size={15} /> },
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
            {tab === 'profiles' && <ProfileSettings snapshot={snapshot} />}
            {tab === 'mcp' && <McpSettings snapshot={snapshot} />}
            {tab === 'extensions' && <ExtensionSettings snapshot={snapshot} />}
            {tab === 'workspace' && <WorkspaceSettings snapshot={snapshot} />}
            {tab === 'diagnostics' && <DiagnosticsSettings snapshot={snapshot} />}
            {tab === 'about' && <AboutSettings update={snapshot.update} />}
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

interface ProfileFormState {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly prompt: string;
  readonly scope: 'workspace' | 'user';
  readonly override: boolean;
  readonly tools: string;
  readonly disallowedTools: string;
  readonly subagents: string;
  readonly modelPreference: 'auto' | 'primary' | 'secondary';
}

const EMPTY_PROFILE_FORM: ProfileFormState = {
  name: '',
  description: '',
  whenToUse: '',
  prompt: '',
  scope: 'workspace',
  override: false,
  tools: '',
  disallowedTools: '',
  subagents: '',
  modelPreference: 'auto',
};

function ProfileSettings({ snapshot }: { readonly snapshot: DesktopSnapshot }) {
  const [catalog, setCatalog] = useState<AgentProfileListResult>({ profiles: [], diagnostics: [] });
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProfileFormState>(EMPTY_PROFILE_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selected = catalog.profiles.find((profile) => profile.id === selectedId);

  const load = async (nextId?: string) => {
    if (snapshot.workspace.root.length === 0) return;
    setLoading(true);
    setError('');
    try {
      const result = await window.kimiDesktop.profile.list();
      setCatalog(result);
      if (nextId !== undefined) {
        const next = result.profiles.find((profile) => profile.id === nextId);
        setSelectedId(next?.id);
        if (next !== undefined) setForm(profileToForm(next));
      }
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [snapshot.workspace.root]);

  const choose = (profile: AgentProfileDescriptor) => {
    setCreating(false);
    setSelectedId(profile.id);
    setForm(profileToForm(profile));
    setError('');
  };

  const create = () => {
    setCreating(true);
    setSelectedId(undefined);
    setForm(EMPTY_PROFILE_FORM);
    setError('');
  };

  const save = async () => {
    const draft = profileDraft(form);
    if (draft.name.length === 0 || draft.description.length === 0 || draft.prompt.length === 0) {
      setError('名称、子 Agent 简介和系统提示词不能为空。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = creating
        ? await window.kimiDesktop.profile.create(draft)
        : selected?.editable === true && selected.revision !== undefined
          ? await window.kimiDesktop.profile.update({ ...draft, revision: selected.revision })
          : undefined;
      if (result === undefined) return;
      setCreating(false);
      await load(result.profile.id);
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (
      selected?.editable !== true ||
      selected.scope === undefined ||
      selected.revision === undefined ||
      !window.confirm(`删除 Agent 职业「${selected.name}」？此操作会删除对应 Markdown 文件。`)
    ) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      await window.kimiDesktop.profile.delete({
        name: selected.name,
        scope: selected.scope,
        revision: selected.revision,
      });
      setSelectedId(undefined);
      setForm(EMPTY_PROFILE_FORM);
      await load();
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setSaving(false);
    }
  };

  if (snapshot.workspace.root.length === 0) {
    return (
      <SettingsPage title="Agent 职业" description="为主代理和团队子代理维护可复用的专业角色。">
        <section className="settings-section">
          <div className="settings-empty">选择工作区后才能管理 Agent 职业。</div>
        </section>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Agent 职业" description="每个职业的子 Agent 简介和适用任务会直接提供给主代理用于分工。工作区职业保存在 .kimi-code/agents；用户职业可跨工作区复用；插件与内置职业只读。">
      <section className="settings-section profile-manager-section">
        <div className="section-title-row">
          <h3><BriefcaseBusiness size={14} />职业目录</h3>
          <div className="row-actions">
            <button disabled={loading || saving} onClick={() => void load(selectedId)}><RefreshCw size={13} />刷新</button>
            <button className="button-primary" disabled={saving} onClick={create}><Plus size={13} />新建职业</button>
          </div>
        </div>
        <div className="profile-manager">
          <div className="profile-list" aria-label="Agent 职业列表">
            {catalog.profiles.map((profile) => (
              <button
                className={classNames('profile-list-item', !creating && selectedId === profile.id && 'active')}
                key={profile.id}
                onClick={() => choose(profile)}
              >
                <span className="profile-list-heading">
                  <strong>{profile.name}</strong>
                  <em className={classNames('profile-effective', profile.effective && 'active')}>{profile.effective ? '生效' : '被覆盖'}</em>
                </span>
                <small>{profile.description || '暂无简介'}</small>
                <span className="profile-meta"><code>{profile.sourceId}</code>{profile.editable ? '可编辑' : '只读'}</span>
              </button>
            ))}
            {catalog.profiles.length === 0 && <div className="settings-empty">没有可用职业</div>}
          </div>
          <div className="profile-editor">
            {(creating || selected?.editable === true) && (
              <>
                <div className="form-grid profile-form-grid">
                  <label><span>名称（kebab-case）</span><input disabled={!creating} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="code-reviewer" /></label>
                  <label><span>保存范围</span><select disabled={!creating} value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value as ProfileFormState['scope'] })}><option value="workspace">当前工作区</option><option value="user">所有工作区</option></select></label>
                  <label className="span-two"><span>子 Agent 简介（主代理分配时可见）</span><input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="擅长审查实现质量、定位回归风险并给出修复建议" /></label>
                  <label className="span-two"><span>适用任务（主代理分配时可见，可选）</span><input value={form.whenToUse} onChange={(event) => setForm({ ...form, whenToUse: event.target.value })} placeholder="代码审查、回归分析和合并前质量检查" /></label>
                  <label><span>默认模型角色</span><select value={form.modelPreference} onChange={(event) => setForm({ ...form, modelPreference: event.target.value as ProfileFormState['modelPreference'] })}><option value="auto">自动</option><option value="primary">主模型</option><option value="secondary">辅助模型</option></select></label>
                  <label className="profile-checkbox"><span>覆盖同名内置职业</span><input type="checkbox" checked={form.override} onChange={(event) => setForm({ ...form, override: event.target.checked })} /></label>
                  <label className="span-two"><span>允许的工具（逗号或换行分隔，空白表示不限制）</span><textarea rows={2} value={form.tools} onChange={(event) => setForm({ ...form, tools: event.target.value })} placeholder="Read, Grep, Bash" /></label>
                  <label className="span-two"><span>禁用的工具</span><textarea rows={2} value={form.disallowedTools} onChange={(event) => setForm({ ...form, disallowedTools: event.target.value })} placeholder="Write" /></label>
                  <label className="span-two"><span>允许委派的子职业</span><textarea rows={2} value={form.subagents} onChange={(event) => setForm({ ...form, subagents: event.target.value })} placeholder="test-engineer, docs-writer" /></label>
                  <label className="span-two"><span>系统提示词</span><textarea className="code-input profile-prompt" rows={10} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="定义这个 Agent 的职责、工作方式与交付标准。" /></label>
                </div>
                <div className="settings-actions profile-editor-actions">
                  {!creating && <button className="danger" disabled={saving} onClick={() => void remove()}><Trash2 size={13} />删除</button>}
                  <button className="button-primary" disabled={saving} onClick={() => void save()}><Save size={13} />{creating ? '创建职业' : '保存修改'}</button>
                </div>
              </>
            )}
            {!creating && selected !== undefined && !selected.editable && (
              <div className="profile-readonly">
                <BriefcaseBusiness size={24} />
                <h3>{selected.name}</h3>
                <p>{selected.description || '暂无简介'}</p>
                {selected.whenToUse !== undefined && <p><strong>使用时机：</strong>{selected.whenToUse}</p>}
                <dl><dt>来源</dt><dd>{selected.sourceId}</dd><dt>状态</dt><dd>{selected.effective ? '当前生效' : '被更高优先级职业覆盖'}</dd><dt>模型偏好</dt><dd>{selected.modelPreference}</dd></dl>
                <div className="dialog-notice">该职业来自内置代码、插件、兼容目录或显式启动参数，只能查看，不能在此修改。</div>
              </div>
            )}
            {!creating && selected === undefined && <div className="profile-editor-placeholder"><BriefcaseBusiness size={28} /><span>选择一个职业查看详情，或新建职业。</span></div>}
          </div>
        </div>
        {catalog.diagnostics.length > 0 && (
          <div className="profile-diagnostics">
            <strong>有 {catalog.diagnostics.length} 个职业文件未加载</strong>
            {catalog.diagnostics.map((diagnostic) => <small key={`${diagnostic.sourceId}:${diagnostic.path}:${diagnostic.message}`}>{diagnostic.path ?? diagnostic.sourceId} · {diagnostic.message}</small>)}
          </div>
        )}
        {error.length > 0 && <div className="form-error"><CircleAlert size={13} />{error}</div>}
      </section>
    </SettingsPage>
  );
}

function profileToForm(profile: AgentProfileDescriptor): ProfileFormState {
  return {
    name: profile.name,
    description: profile.description,
    whenToUse: profile.whenToUse ?? '',
    prompt: profile.prompt ?? '',
    scope: profile.scope ?? 'workspace',
    override: profile.override,
    tools: profile.tools?.join(', ') ?? '',
    disallowedTools: profile.disallowedTools?.join(', ') ?? '',
    subagents: profile.subagents?.join(', ') ?? '',
    modelPreference: profile.modelPreference,
  };
}

function profileDraft(form: ProfileFormState): AgentProfileDraft {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    whenToUse: form.whenToUse.trim() || undefined,
    prompt: form.prompt.trim(),
    scope: form.scope,
    override: form.override,
    tools: profileList(form.tools),
    disallowedTools: profileList(form.disallowedTools),
    subagents: profileList(form.subagents),
    modelPreference: form.modelPreference,
  };
}

function profileList(value: string): readonly string[] | undefined {
  const items = [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
  return items.length === 0 ? undefined : items;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function AboutSettings({ update }: { readonly update: DesktopUpdateSnapshot }) {
  const checking = update.status === 'checking';
  const downloading = update.status === 'downloading';
  const releaseAvailable = update.status === 'available' || downloading || update.status === 'downloaded';
  return (
    <SettingsPage title="关于与更新" description="自动检查稳定版发布；下载和安装操作由 Electron 主进程执行。">
      <section className="settings-section update-settings-card">
        <div className="update-product-row">
          <span className="update-product-icon"><Info size={18} /></span>
          <div>
            <strong>Kimi Code Desktop</strong>
            <small>当前版本 {update.currentVersion} · {updateModeLabel(update)}</small>
          </div>
          <span className={classNames('update-status-badge', update.status)}>{updateStatusLabel(update)}</span>
        </div>
        {update.progress !== undefined && (
          <div className="update-progress" aria-label={`更新下载进度 ${Math.round(update.progress.percent)}%`}>
            <div><span style={{ width: `${update.progress.percent}%` }} /></div>
            <small>{Math.round(update.progress.percent)}% · {formatBytes(update.progress.transferred)} / {formatBytes(update.progress.total)}</small>
          </div>
        )}
        {update.error !== undefined && (
          <div className="update-error" role="alert"><CircleAlert size={14} /><span>{update.error.message}</span></div>
        )}
        <div className="settings-actions wrap">
          <button disabled={checking || downloading || update.status === 'downloaded'} onClick={() => void window.kimiDesktop.update.check()}>
            <RefreshCw className={checking ? 'spin' : undefined} size={13} />{checking ? '正在检查' : update.status === 'error' ? '重试检查' : '检查更新'}
          </button>
          {update.status === 'available' && update.mode === 'automatic' && (
            <button className="button-primary" onClick={() => void window.kimiDesktop.update.download()}><Download size={13} />下载更新</button>
          )}
          {update.status === 'downloaded' && (
            <button className="button-primary" onClick={() => void window.kimiDesktop.update.install()}><RefreshCw size={13} />立即重启</button>
          )}
          {((update.mode === 'manual' && releaseAvailable) || update.releaseUrl !== undefined) && (
            <button onClick={() => void window.kimiDesktop.update.openRelease()}><ExternalLink size={13} />查看 GitHub Release</button>
          )}
        </div>
        {update.checkedAt !== undefined && <small className="update-checked-at">上次检查：{new Date(update.checkedAt).toLocaleString()}</small>}
      </section>
      {releaseAvailable && (
        <section className="settings-section">
          <h3><Download size={15} />{update.releaseName ?? `Kimi Code Desktop ${update.latestVersion ?? ''}`}</h3>
          <pre className="update-release-notes">{update.releaseNotes?.trim() || '此版本没有附加发布说明。'}</pre>
        </section>
      )}
    </SettingsPage>
  );
}

function updateModeLabel(update: DesktopUpdateSnapshot): string {
  if (update.mode === 'automatic') return '支持应用内更新';
  if (update.manualReason === 'windows-portable') return 'Portable 版通过 Release 更新';
  if (update.manualReason === 'macos-unsigned') return 'macOS 版通过 Release 更新';
  if (update.manualReason === 'linux-package') return 'DEB 版通过 Release 更新';
  if (update.manualReason === 'development') return '开发模式';
  return '通过 Release 更新';
}

function updateStatusLabel(update: DesktopUpdateSnapshot): string {
  if (update.status === 'idle') return '尚未检查';
  if (update.status === 'checking') return '正在检查';
  if (update.status === 'up-to-date') return '已是最新版本';
  if (update.status === 'available') return `发现 ${update.latestVersion ?? '新版本'}`;
  if (update.status === 'downloading') return '正在下载';
  if (update.status === 'downloaded') return '等待重启';
  return '检查失败';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function SettingsPage({ title, description, children }: { readonly title: string; readonly description: string; readonly children: React.ReactNode }) {
  return (
    <div className="settings-page">
      <div className="settings-page-heading"><h2>{title}</h2><p>{description}</p></div>
      {children}
    </div>
  );
}
