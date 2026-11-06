import {
  AlertTriangle,
  Boxes,
  Cable,
  CheckCircle2,
  Cpu,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  KeyRound,
  LogIn,
  LogOut,
  Monitor,
  Palette,
  RefreshCw,
  Save,
  Settings2,
  SquareTerminal,
  SunMoon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type {
  AgentProviderId,
  AgentProviderStatus,
  AppSettings,
  LoginStartResult,
  ProviderCredentialStatus,
  RuntimeStatus,
} from '../../shared/contracts';
import {
  DEFAULT_NOOBI_CREW,
  DEFAULT_NOOBI_PACK_ID,
  DEFAULT_NOOBI_SCENE_ID,
  DEFAULT_NOOBI_SOLO_SCENE_ID,
  DEFAULT_NOOBI_STAGE_MODE,
} from '../../shared/contracts';
import { runtimeLabel, toMessage } from '../ui';
import { Modal } from './Modal';
import { EnvironmentSettings } from './EnvironmentSettings';
import { NoobiCrewPicker } from './NoobiCrewPicker';
import { NoobiPackPicker } from './NoobiPackPicker';
import { NoobiScenePicker, NoobiSoloScenePicker } from './NoobiScenePicker';
import {
  McpSettings,
  MediaApiSettings,
  PromptSettings,
  SkillsSettings,
  useExtensionSettings,
} from './SettingsExtensions';

export type SettingsSection = 'account' | 'environment' | 'media' | 'defaults' | 'noobi' | 'skills' | 'mcp' | 'prompts' | 'appearance';

const PROVIDER_CHOICES: ReadonlyArray<{ id: AgentProviderId; label: string; detail: string }> = [
  {
    id: 'codex',
    label: 'Codex App Server',
    detail: '官方运行时 · 自带工具链 · 需 ChatGPT 账号',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    detail: 'API Key 直连 · 国内可用 · 需自备图片 API',
  },
];

/** Keys compared to detect unsaved edits in the settings form. */
const SETTINGS_COMPARE_KEYS = [
  'defaultWorkspace',
  'defaultModel',
  'defaultEffort',
  'defaultNoobiStageMode',
  'defaultNoobiSoloSceneId',
  'defaultNoobiSceneId',
  'defaultNoobiPackId',
  'defaultNoobiCrew',
  'theme',
  'agentProvider',
] as const satisfies readonly (keyof AppSettings)[];

function sameSettingValue(
  key: keyof AppSettings,
  left: AppSettings,
  right: AppSettings,
): boolean {
  if (key === 'defaultNoobiCrew') {
    return JSON.stringify(left.defaultNoobiCrew) === JSON.stringify(right.defaultNoobiCrew);
  }
  return left[key] === right[key];
}

interface SettingsModalProps {
  value: AppSettings;
  runtime: RuntimeStatus;
  initialSection?: SettingsSection;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
  onRuntime: (runtime: RuntimeStatus) => void;
  /** Lets the shell refresh home-screen readiness after a provider switch. */
  onProvidersChanged?: (providers: AgentProviderStatus[]) => void;
}

const SECTIONS = [
  { id: 'account', label: '运行时与账户', detail: 'Codex / DeepSeek', icon: KeyRound },
  { id: 'environment', label: '环境管理', detail: 'Node、Codex、Godot', icon: Cpu },
  { id: 'media', label: '媒体 API', detail: '图像、音频、3D', icon: Boxes },
  { id: 'defaults', label: '项目默认值', detail: '目录、模型、推理', icon: Settings2 },
  { id: 'noobi', label: 'Noobi 工坊', detail: '伙伴形象与场景', icon: Palette },
  { id: 'skills', label: 'Skills', detail: 'Agent 专业能力', icon: FileCode2 },
  { id: 'mcp', label: 'MCP Servers', detail: '工具与数据连接', icon: Cable },
  { id: 'prompts', label: '提示词', detail: '分角色模板', icon: FileText },
  { id: 'appearance', label: '外观', detail: '深色与浅色', icon: SunMoon },
] as const;

export function SettingsModal({
  value,
  runtime,
  initialSection = 'account',
  onClose,
  onSaved,
  onRuntime,
  onProvidersChanged,
}: SettingsModalProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [login, setLogin] = useState<LoginStartResult | null>(null);
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const extensions = useExtensionSettings(setMessage);

  useEffect(() => setDraft(value), [value]);

  const selectedModel = useMemo(
    () => runtime.models.find((item) => item.model === draft.defaultModel),
    [draft.defaultModel, runtime.models],
  );
  const efforts = selectedModel?.efforts.length
    ? selectedModel.efforts
    : ['minimal', 'low', 'medium', 'high', 'xhigh'];
  const noobiStageMode = draft.defaultNoobiStageMode ?? DEFAULT_NOOBI_STAGE_MODE;

  const settingsDirty = useMemo(
    () => SETTINGS_COMPARE_KEYS.some((key) => !sameSettingValue(key, draft, value)),
    [draft, value],
  );

  async function refreshRuntime() {
    setBusy(true);
    setMessage('');
    try {
      onRuntime(await window.noobi.refreshRuntime());
      setMessage('运行时状态已刷新。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function startLogin() {
    setBusy(true);
    setMessage('');
    try {
      const result = await window.noobi.startLogin();
      setLogin(result);
      setMessage('请在官方页面完成 Codex 登录。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setMessage('');
    try {
      onRuntime(await window.noobi.logout());
      setLogin(null);
      setMessage('已退出 Codex 账户。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Switch the agent runtime immediately.
   *
   * The choice is persisted and the runtime hot-swapped in Main, so the user
   * does not have to save the whole settings form for it to take effect. A
   * provider that cannot run is rejected there and reported here.
   */
  async function selectProvider(provider: AgentProviderId) {
    if (provider === draft.agentProvider) return;
    setBusy(true);
    setMessage('');
    try {
      const snapshot = await window.noobi.selectAgentProvider(provider);
      setDraft((current) => ({ ...current, agentProvider: snapshot.settings.agentProvider }));
      onSaved(snapshot.settings);
      onRuntime(snapshot.runtime);
      onProvidersChanged?.(snapshot.agentProviders);
      setMessage(provider === 'deepseek'
        ? '已切换到 DeepSeek。'
        : '已切换到 Codex App Server。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseDirectory() {
    const directory = await window.noobi.chooseDirectory();
    if (directory) setDraft((current) => ({ ...current, defaultWorkspace: directory }));
  }

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const saved = await window.noobi.saveSettings(draft);
      setDraft(saved);
      onSaved(saved);
      setMessage('设置已保存。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function confirmPromptDiscard(): boolean {
    if (promptDirty && !window.confirm('提示词有未保存更改。离开此页面会放弃这些更改，是否继续？')) {
      return false;
    }
    if (settingsDirty && !window.confirm('设置还有未保存的更改。离开会放弃这些更改，是否继续？')) {
      return false;
    }
    return true;
  }

  function closeSettings() {
    if (promptBusy || !confirmPromptDiscard()) return;
    setPromptDirty(false);
    onClose();
  }

  function selectSection(next: SettingsSection) {
    if (next === section || promptBusy || !confirmPromptDiscard()) return;
    setPromptDirty(false);
    setSection(next);
    setMessage('');
  }

  return (
    <Modal
      eyebrow="SYSTEM / CONTROL CENTER"
      title="设置"
      description="配置 Agent 运行时、媒体服务、扩展能力和制作规范。"
      className="settings-modal"
      onClose={busy || promptBusy ? undefined : closeSettings}
      footer={
        <>
          <span className="settings-feedback" role="status">{message}</span>
          {section === 'defaults' || section === 'noobi' || section === 'appearance' ? (
            <button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>
              <Save size={15} /> {busy ? '保存中…' : '保存设置'}
            </button>
          ) : null}
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={section === item.id ? 'is-active' : ''}
                aria-current={section === item.id ? 'page' : undefined}
                disabled={promptBusy}
                onClick={() => selectSection(item.id)}
              >
                <Icon size={16} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="settings-page">
          {section === 'account' ? (
            <AccountSettings
              runtime={runtime}
              login={login}
              busy={busy}
              onRefresh={() => void refreshRuntime()}
              onLogin={() => void startLogin()}
              onLogout={() => void logout()}
              provider={draft.agentProvider}
              onProviderChange={(provider) => void selectProvider(provider)}
            />
          ) : null}

          {section === 'environment' ? <EnvironmentSettings onMessage={setMessage} /> : null}

          {section === 'media' ? <MediaApiSettings controller={extensions} /> : null}

          {section === 'defaults' ? (
            <section>
              <SettingsHeading
                eyebrow="PROJECT DEFAULTS"
                title="新项目默认值"
                description="这些值只作为新任务起点，每个项目仍可单独选择模型和推理强度。"
              />
              <div className="settings-form">
                <label>
                  <span>默认工作区</span>
                  <div className="path-control">
                    <input
                      value={draft.defaultWorkspace}
                      onChange={(event) => setDraft((current) => ({ ...current, defaultWorkspace: event.target.value }))}
                    />
                    <button type="button" onClick={() => void chooseDirectory()}>
                      <FolderOpen size={14} /> 选择
                    </button>
                  </div>
                </label>
                <label>
                  <span>默认模型</span>
                  <select
                    value={draft.defaultModel ?? ''}
                    onChange={(event) => {
                      const model = runtime.models.find((item) => item.model === event.target.value);
                      setDraft((current) => ({
                        ...current,
                        defaultModel: event.target.value || null,
                        defaultEffort: model?.defaultEffort ?? current.defaultEffort,
                      }));
                    }}
                  >
                    <option value="">使用 Codex 默认模型</option>
                    {runtime.models.map((item) => (
                      <option value={item.model} key={item.id}>{item.displayName}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>默认推理强度</span>
                  <select
                    value={draft.defaultEffort}
                    onChange={(event) => setDraft((current) => ({ ...current, defaultEffort: event.target.value }))}
                  >
                    {efforts.map((effort) => (
                      <option value={effort} key={effort}>{effort.toUpperCase()}</option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          ) : null}

          {section === 'noobi' ? (
            <section>
              <SettingsHeading
                eyebrow="NOOBI WORKSHOP"
                title="选择默认搭档与工作场景"
                description="默认先由一位 Noobi 在一个单人工作室中陪你制作；多人编队与多人场景放在下方，按需启用。"
              />

              <section
                className={`noobi-mode-panel noobi-solo-panel${noobiStageMode === 'solo' ? ' is-active' : ''}`}
                aria-label="默认单人搭档与工作室"
              >
                <header className="noobi-mode-panel-heading">
                  <div>
                    <small>SOLO / DEFAULT</small>
                    <strong>一位搭档，一个工作室</strong>
                    <p>角色和场景分别选择，可以自由组合；选择任一项都会把单人模式设为默认。</p>
                  </div>
                  <span className="noobi-mode-state">
                    {noobiStageMode === 'solo' ? '当前默认' : '点击选项启用'}
                  </span>
                </header>

                <section className="noobi-setup-step" aria-labelledby="noobi-character-step-title">
                  <header className="noobi-setup-step-heading">
                    <span aria-hidden="true">01</span>
                    <div>
                      <small>SOLO PARTNER</small>
                      <strong id="noobi-character-step-title">先选择一位默认角色</strong>
                      <p>这位 Noobi 会独自出现在制作预览里，并跟随 Agent 的阶段行动。</p>
                    </div>
                  </header>
                  <NoobiPackPicker
                    value={draft.defaultNoobiPackId ?? DEFAULT_NOOBI_PACK_ID}
                    mode="global"
                    presentation="character"
                    busy={busy}
                    onChange={(defaultNoobiPackId) => {
                      if (!defaultNoobiPackId) return;
                      setDraft((current) => ({
                        ...current,
                        defaultNoobiPackId,
                        defaultNoobiStageMode: 'solo',
                      }));
                    }}
                  />
                </section>

                <NoobiSoloScenePicker
                  value={draft.defaultNoobiSoloSceneId ?? DEFAULT_NOOBI_SOLO_SCENE_ID}
                  busy={busy}
                  onChange={(defaultNoobiSoloSceneId) => {
                    setDraft((current) => ({
                      ...current,
                      defaultNoobiSoloSceneId,
                      defaultNoobiStageMode: 'solo',
                    }));
                  }}
                />
              </section>

              <section
                className={`noobi-mode-panel noobi-multiplayer-panel${noobiStageMode === 'crew' ? ' is-active' : ''}`}
                aria-label="多人协作与多人场景"
              >
                <header className="noobi-mode-panel-heading">
                  <div>
                    <small>MULTIPLAYER / OPTIONAL</small>
                    <strong>需要时，再组建多人编队</strong>
                    <p>先配置 2–4 位伙伴的岗位，再在最下方选择一个多人舞台。</p>
                  </div>
                  <span className="noobi-mode-state">
                    {noobiStageMode === 'crew' ? '当前默认' : '可选模式'}
                  </span>
                </header>

                <NoobiCrewPicker
                  value={draft.defaultNoobiCrew ?? DEFAULT_NOOBI_CREW}
                  busy={busy}
                  onChange={(defaultNoobiCrew) => {
                    setDraft((current) => ({ ...current, defaultNoobiCrew }));
                  }}
                />
                <NoobiScenePicker
                  value={noobiStageMode === 'crew'
                    ? draft.defaultNoobiSceneId ?? DEFAULT_NOOBI_SCENE_ID
                    : null}
                  busy={busy}
                  onChange={(defaultNoobiSceneId) => {
                    setDraft((current) => ({
                      ...current,
                      defaultNoobiSceneId,
                      defaultNoobiStageMode: 'crew',
                    }));
                  }}
                />
                <p className="noobi-pack-settings-note">
                  只有选择多人舞台后，制作预览才会切换为编队模式。协作工坊按岗位渲染当前编队；荷塘钓鱼保留固定四人的完整动态演出。
                </p>
              </section>
            </section>
          ) : null}

          {section === 'skills' ? <SkillsSettings controller={extensions} /> : null}

          {section === 'mcp' ? <McpSettings controller={extensions} /> : null}

          {section === 'prompts' ? (
            <PromptSettings
              controller={extensions}
              onDirtyChange={setPromptDirty}
              onBusyChange={setPromptBusy}
            />
          ) : null}

          {section === 'appearance' ? (
            <section>
              <SettingsHeading
                eyebrow="APPEARANCE"
                title="界面主题"
                description="功能颜色在两种主题下保持一致，颜色只用来表达状态。"
              />
              <div className="theme-choices" role="radiogroup" aria-label="界面主题">
                {(['dark', 'light'] as const).map((theme) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.theme === theme}
                    className={draft.theme === theme ? 'is-active' : ''}
                    key={theme}
                    onClick={() => setDraft((current) => ({ ...current, theme }))}
                  >
                    <span className={`theme-swatch theme-${theme}`} aria-hidden="true">
                      <i /><i /><i />
                    </span>
                    <span>
                      <strong>{theme === 'dark' ? '深色' : '浅色'}</strong>
                      <small>{theme === 'dark' ? '适合长时间制作' : '适合明亮工作环境'}</small>
                    </span>
                    {draft.theme === theme ? <CheckCircle2 size={16} /> : null}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function AccountSettings({
  runtime,
  login,
  busy,
  onRefresh,
  onLogin,
  onLogout,
  provider,
  onProviderChange,
}: {
  runtime: RuntimeStatus;
  login: LoginStartResult | null;
  busy: boolean;
  onRefresh: () => void;
  onLogin: () => void;
  onLogout: () => void;
  provider: AgentProviderId;
  onProviderChange: (provider: AgentProviderId) => void;
}) {
  const [providers, setProviders] = useState<AgentProviderStatus[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredentialStatus[]>([]);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');

  const refreshProviders = useCallback(async () => {
    const [nextProviders, nextCredentials] = await Promise.all([
      window.noobi.listAgentProviders(),
      window.noobi.listProviderCredentials(),
    ]);
    setProviders(nextProviders);
    setCredentials(nextCredentials);
  }, []);

  useEffect(() => {
    void refreshProviders().catch(() => undefined);
  }, [refreshProviders, provider]);

  const activeProvider = providers.find((entry) => entry.id === provider);
  const deepseekCredential = credentials.find((entry) => entry.provider === 'deepseek');
  const isCodex = provider === 'codex';

  const saveKey = async (): Promise<void> => {
    setKeyBusy(true);
    setKeyMessage('');
    try {
      const next = await window.noobi.setProviderApiKey('deepseek', apiKeyDraft);
      setCredentials(next);
      // Never keep the plaintext key in renderer state after saving.
      setApiKeyDraft('');
      setKeyMessage('已保存');
      await refreshProviders();
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <section>
      <SettingsHeading
        eyebrow="AGENT RUNTIME"
        title="运行时与账户"
        description="Noobi 通过 Agent 运行时驱动游戏制作。Codex 自带完整工具链；DeepSeek 使用 API Key 直连，工具与会话由本机实现。"
        action={
          <button className="secondary-button compact" type="button" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={13} className={busy ? 'spin' : ''} /> 刷新
          </button>
        }
      />

      <div className="provider-picker">
        {PROVIDER_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className={`provider-option${provider === choice.id ? ' active' : ''}`}
            disabled={busy}
            onClick={() => onProviderChange(choice.id)}
          >
            <strong>{choice.label}</strong>
            <small>{choice.detail}</small>
          </button>
        ))}
      </div>

      {activeProvider && !activeProvider.ready ? (
        <div className="provider-blockers">
          <AlertTriangle size={15} />
          <div>
            <strong>当前运行时还不可用</strong>
            <ul>
              {activeProvider.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          </div>
        </div>
      ) : null}

      {activeProvider?.requiresImageApi ? (
        <div className="provider-note">
          该运行时不带内置图片生成，必须先在「媒体 API」中配置图像 API 才能开始制作。
        </div>
      ) : null}

      <div className={`runtime-card state-${runtime.state}`}>
        <div className="runtime-card-heading">
          <span className={`runtime-dot state-${runtime.state}`} />
          <div>
            <strong>{runtimeLabel(runtime)}</strong>
            <small>{runtime.version ?? 'VERSION UNKNOWN'}</small>
          </div>
        </div>
        {runtime.error ? <p className="runtime-error">{runtime.error}</p> : null}
        <dl>
          <div><dt>Binary</dt><dd>{runtime.binaryPath ?? '尚未定位'}</dd></div>
          <div><dt>Codex Home</dt><dd>{runtime.codexHome ?? '尚未启动'}</dd></div>
          <div><dt>Models</dt><dd>{runtime.models.length}</dd></div>
          <div><dt>Image route</dt><dd>{runtime.capabilities.externalImageGeneration ? '外部 API 优先' : runtime.capabilities.imageGeneration ? 'Codex ImageGen' : '当前不可用'}</dd></div>
          <div><dt>Media tools</dt><dd>{runtime.state === 'ready' ? '素材库 / 音效已接入' : '等待运行时'}</dd></div>
        </dl>
      </div>

      {isCodex ? (
        <div className="account-card">
          <div className="account-icon"><SquareTerminal size={20} /></div>
          <div className="account-copy">
            <span>CHATGPT / CODEX ACCOUNT</span>
            <strong>{runtime.account?.email ?? '尚未登录'}</strong>
            <small>{runtime.account?.planType ?? runtime.account?.type ?? '使用 ChatGPT 账号授权 Codex'}</small>
          </div>
          {runtime.account ? (
            <button className="secondary-button compact" type="button" disabled={busy} onClick={onLogout}>
              <LogOut size={13} /> 退出
            </button>
          ) : (
            <button className="primary-button compact" type="button" disabled={busy} onClick={onLogin}>
              <LogIn size={13} /> 登录
            </button>
          )}
        </div>
      ) : (
        <div className="settings-form provider-key-form">
          <label>
            <span>DeepSeek API Key</span>
            <div className="path-control">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={deepseekCredential?.hasApiKey ? '已保存（留空则不修改）' : 'sk-...'}
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
              />
              <button
                type="button"
                disabled={keyBusy || apiKeyDraft.trim().length === 0}
                onClick={() => void saveKey()}
              >
                <KeyRound size={14} /> 保存
              </button>
            </div>
          </label>
          <p className="settings-hint">
            Key 使用系统密钥库加密后保存在本机，不会写入项目目录，也不会传给 Agent 或子进程。
            {deepseekCredential && !deepseekCredential.encryptionAvailable
              ? ' 当前系统密钥加密不可用，无法安全保存。'
              : ''}
            {deepseekCredential?.hasApiKey ? ' 已保存的 Key 可留空后再次保存以保留。' : ''}
          </p>
          {keyMessage ? <p className="settings-hint">{keyMessage}</p> : null}
        </div>
      )}

      {isCodex && login ? (
        <div className="login-instructions">
          <Monitor size={17} />
          <div>
            <strong>在官方页面完成登录</strong>
            {login.userCode ? <code>{login.userCode}</code> : null}
            {login.verificationUrl || login.authUrl ? (
              <a href={login.verificationUrl ?? login.authUrl} target="_blank" rel="noreferrer">
                打开验证页面 <ExternalLink size={12} />
              </a>
            ) : (
              <span>系统浏览器已打开，请在那里完成授权。</span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SettingsHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="settings-page-heading">
      <div>
        <span>{eyebrow}</span>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
