import { join } from 'node:path';

import type { AgentProviderId, AgentProviderStatus } from '../shared/contracts.js';
import type { AgentRuntime } from './agentRuntime.js';
import { AGENT_PROVIDERS, assessProviderReadiness } from './agentProvider.js';
import { CodexAppServer } from './codexAppServer.js';
import { DeepSeekRuntime } from './deepseekRuntime.js';
import type { ProviderCredentialStore } from './providerCredentialStore.js';

/**
 * Owns provider lifecycle: builds the runtime for the selected provider, tears
 * down the previous one, and reports honest readiness.
 *
 * Nothing here holds a long-lived reference to the active runtime. Callers use
 * `holder.switching()` so a switch is observed by already-constructed
 * collaborators such as `GameHarness`.
 */

export interface ProviderFactoryContext {
  /** Directory for app-private runtime state. */
  userDataDir: string;
  credentials: ProviderCredentialStore;
  /** The Codex runtime instance created at module load. */
  codex: CodexAppServer;
  /** Whether an external image API is configured and usable. */
  imageApiConfigured: () => Promise<boolean>;
  /** Host tool executor for providers that do not ship their own. */
  buildHostTools?: () => import('./agentRuntime.js').DynamicToolSpec[];
  executeHostTool?: (
    name: string,
    args: Record<string, unknown>,
    context: { cwd: string; threadId: string; turnId: string },
  ) => Promise<{ ok: boolean; content: string }>;
  /** Workspace-relative paths a replacement runtime must never write. */
  readonlyPaths?: string[];
}

export class AgentProviderManager {
  readonly #context: ProviderFactoryContext;
  #active: AgentProviderId = 'codex';
  #deepseek: DeepSeekRuntime | null = null;

  constructor(context: ProviderFactoryContext) {
    this.#context = context;
  }

  get activeId(): AgentProviderId {
    return this.#active;
  }

  /** The runtime for a provider, constructed lazily. */
  async runtimeFor(provider: AgentProviderId): Promise<AgentRuntime> {
    if (provider === 'codex') return this.#context.codex;
    return this.#deepseekRuntime();
  }

  /**
   * Switch the active provider.
   *
   * Refuses to switch to a provider that cannot actually run, rather than
   * letting the user pick an engine that fails on the first production turn.
   */
  async activate(provider: AgentProviderId): Promise<AgentRuntime> {
    const readiness = await this.readiness(provider);
    if (!readiness.ready) {
      throw new Error(`无法启用 ${provider}：${readiness.blockers.join('；')}`);
    }
    if (this.#active !== provider) {
      // Stop the outgoing provider so no stale turn keeps writing.
      const previous = this.#active === 'deepseek' ? this.#deepseek : null;
      if (previous) await previous.stop().catch(() => undefined);
      this.#active = provider;
    }
    return this.runtimeFor(provider);
  }

  async readiness(provider: AgentProviderId): Promise<AgentProviderStatus> {
    const codexStatus = this.#context.codex.status;
    const apiKey = provider === 'deepseek'
      ? await this.#context.credentials.reveal('deepseek').catch(() => null)
      : null;
    const imageApiConfigured = await this.#context.imageApiConfigured().catch(() => false);

    const base = assessProviderReadiness(provider, {
      codex: { state: codexStatus.state, error: codexStatus.error },
      deepseekApiKey: apiKey,
      imageApiConfigured,
    });
    const descriptor = AGENT_PROVIDERS.find((entry) => entry.id === provider);
    return {
      id: provider,
      active: this.#active === provider,
      ready: base.ready,
      blockers: base.blockers,
      // Codex supplies ImageGen; anything else must use the configured API.
      requiresImageApi: !descriptor?.selfContained,
    };
  }

  async allReadiness(): Promise<AgentProviderStatus[]> {
    return Promise.all(AGENT_PROVIDERS.map((provider) => this.readiness(provider.id)));
  }

  async dispose(): Promise<void> {
    await this.#deepseek?.stop().catch(() => undefined);
    this.#deepseek = null;
  }

  async #deepseekRuntime(): Promise<DeepSeekRuntime> {
    if (this.#deepseek) return this.#deepseek;

    const apiKey = await this.#context.credentials.reveal('deepseek');
    if (!apiKey) {
      throw new Error('未设置 DeepSeek API Key。请在设置中填写后再启用。');
    }
    this.#deepseek = new DeepSeekRuntime({
      apiKey,
      threadStoreDir: join(this.#context.userDataDir, 'deepseek-threads'),
      ...(this.#context.buildHostTools ? { buildHostTools: this.#context.buildHostTools } : {}),
      ...(this.#context.executeHostTool ? { executeHostTool: this.#context.executeHostTool } : {}),
      readonlyPaths: this.#context.readonlyPaths
        ?? ['AGENTS.md', '.noobi', '.codex', 'GAME_DESIGN.md'],
    });
    await this.#deepseek.start();
    return this.#deepseek;
  }

  /** Drop the cached DeepSeek runtime so a new key takes effect. */
  invalidate(): void {
    void this.#deepseek?.stop().catch(() => undefined);
    this.#deepseek = null;
  }
}
