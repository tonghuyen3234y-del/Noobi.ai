import { join } from 'node:path';

import type { AgentProviderId, AgentProviderStatus } from '../shared/contracts.js';
import type { AgentRuntime } from './agentRuntime.js';
import { AGENT_PROVIDERS, assessProviderReadiness, DEFAULT_AGENT_PROVIDER } from './agentProvider.js';
import { CodexAppServer, type CodexProviderConfig } from './codexAppServer.js';
import type { ProviderCredentialStore } from './providerCredentialStore.js';
import { startQwenResponsesShim, type RunningShim } from './qwenResponsesShim.js';

/**
 * Owns provider lifecycle for a single Agent framework (Codex App Server).
 *
 * Both providers run the same binary and the same agent loop; only the model
 * service differs. Each gets its own `CODEX_HOME`, which keeps ChatGPT tokens,
 * DashScope keys, thread transcripts and session state physically separate —
 * switching providers can never leak one service's session into the other.
 */

export const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com';
/** Bailian model used for planning, coding and review. */
export const QWEN_TEXT_MODEL = 'qwen-plus';
const QWEN_PROVIDER_ID = 'qwen';

export interface ProviderFactoryContext {
  /** Directory for app-private runtime state. */
  userDataDir: string;
  credentials: ProviderCredentialStore;
  /** Whether an external image API is configured and usable. */
  imageApiConfigured: () => Promise<boolean>;
  /** Overrides for tests. */
  fetchImpl?: typeof fetch;
}

export class AgentProviderManager {
  readonly #context: ProviderFactoryContext;
  #active: AgentProviderId = DEFAULT_AGENT_PROVIDER;
  readonly #runtimes = new Map<AgentProviderId, CodexAppServer>();
  #shim: RunningShim | null = null;

  constructor(context: ProviderFactoryContext) {
    this.#context = context;
  }

  get activeId(): AgentProviderId {
    return this.#active;
  }

  /** Codex home for a provider. Two providers never share one. */
  codexHomeFor(provider: AgentProviderId): string {
    return join(this.#context.userDataDir, `codex-home-${provider}`);
  }

  /**
   * The runtime for a provider, constructed on first use.
   *
   * Qwen needs the protocol shim running before Codex starts, because the
   * provider's `base_url` points at it.
   */
  async runtimeFor(provider: AgentProviderId): Promise<CodexAppServer> {
    const existing = this.#runtimes.get(provider);
    if (existing) return existing;

    const runtime = new CodexAppServer({
      codexHome: this.codexHomeFor(provider),
      ...(provider === 'qwen' ? { provider: await this.#qwenProviderConfig() } : {}),
    });
    this.#runtimes.set(provider, runtime);
    return runtime;
  }

  /** Select a provider without requiring that it can run yet. */
  select(provider: AgentProviderId): void {
    if (this.#active === provider) return;
    this.#active = provider;
  }

  /**
   * Switch the active provider and return a runtime that is ready to run.
   * Refuses a provider that cannot work, instead of failing on the first turn.
   */
  async activate(provider: AgentProviderId): Promise<AgentRuntime> {
    const readiness = await this.readiness(provider);
    if (!readiness.ready) {
      throw new Error(`无法启用 ${provider}：${readiness.blockers.join('；')}`);
    }
    this.select(provider);
    return this.runtimeFor(provider);
  }

  /**
   * A runtime for the selected provider that may be unable to run.
   *
   * Startup uses this so the UI shows the engine the user actually selected
   * together with its real blocker, instead of silently falling back.
   */
  async runtimeOrPlaceholder(provider: AgentProviderId): Promise<CodexAppServer> {
    try {
      return await this.runtimeFor(provider);
    } catch (error) {
      // Qwen without a key still needs a runtime object so the settings card can
      // render the selected provider and name the blocker. Returning the OpenAI
      // runtime instead made the Qwen card display ChatGPT's status.
      if (provider !== 'qwen') throw error;
      const placeholder = new CodexAppServer({
        codexHome: this.codexHomeFor(provider),
      });
      placeholder.markUnavailable(asMessageOf(error));
      // Deliberately not cached: a placeholder is a view of "cannot start yet",
      // and caching it would make readiness report the key blocker twice and
      // keep the stale failure after a key is saved.
      return placeholder;
    }
  }

  async readiness(provider: AgentProviderId): Promise<AgentProviderStatus> {
    const descriptors = AGENT_PROVIDERS.find((entry) => entry.id === provider);
    const codexStatus = await this.#codexStatus(provider);
    const apiKey = descriptors?.credentialKind === 'api-key'
      ? await this.#context.credentials.reveal('qwen').catch(() => null)
      : null;
    const imageApiConfigured = await this.#context.imageApiConfigured().catch(() => false);
    const base = assessProviderReadiness(provider, {
      codex: codexStatus,
      qwenApiKey: apiKey,
      imageApiConfigured,
    });
    return {
      id: provider,
      active: this.#active === provider,
      ready: base.ready,
      blockers: base.blockers,
      warnings: base.warnings,
      // Only OpenAI's own service supplies ImageGen through Codex.
      requiresImageApi: !descriptors?.builtInImageGeneration,
    };
  }

  async allReadiness(): Promise<AgentProviderStatus[]> {
    return Promise.all(AGENT_PROVIDERS.map((provider) => this.readiness(provider.id)));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#runtimes.values()].map((runtime) => runtime.stop().catch(() => undefined)));
    this.#runtimes.clear();
    await this.#shim?.close().catch(() => undefined);
    this.#shim = null;
  }

  /** Drop cached runtimes so a new key takes effect. */
  invalidate(): void {
    for (const runtime of this.#runtimes.values()) {
      void runtime.stop().catch(() => undefined);
    }
    this.#runtimes.clear();
    void this.#shim?.close().catch(() => undefined);
    this.#shim = null;
  }

  /**
   * Reported state for a provider without forcing a full start.
   *
   * A provider that has never been started reports `stopped`; the UI treats
   * that as "not verified yet" rather than an error.
   */
  async #codexStatus(provider: AgentProviderId): Promise<{ state: string; error: string | null }> {
    const existing = this.#runtimes.get(provider);
    if (!existing) {
      // Report blockers that do not need the binary: a missing key is a
      // definite blocker, so surface it before paying for a spawn.
      // A missing key is reported by the credential check in
      // `assessProviderReadiness`; repeating it here produced two identical
      // blocker lines in the settings card.
      return { state: 'stopped', error: null };
    }
    const status = existing.status;
    return { state: status.state, error: status.error };
  }

  /** Provider config for Codex; starts the shim on first use. */
  async #qwenProviderConfig(): Promise<CodexProviderConfig> {
    const apiKey = await this.#context.credentials.reveal('qwen');
    if (!apiKey?.trim()) {
      throw new Error('未填写阿里云百炼 API Key。请在设置 → 运行时与账户中填写。');
    }
    if (!this.#shim) {
      this.#shim = await startQwenResponsesShim({
        upstream: DASHSCOPE_BASE_URL,
        ...(this.#context.fetchImpl ? { fetchImpl: this.#context.fetchImpl } : {}),
        debug: process.env.NOOBI_DEBUG === '1',
      });
    }
    return {
      id: QWEN_PROVIDER_ID,
      name: 'Qwen via DashScope',
      baseUrl: `${this.#shim.baseUrl}/compatible-mode/v1`,
      envKey: 'DASHSCOPE_API_KEY',
      apiKey,
      model: QWEN_TEXT_MODEL,
      wireApi: 'responses',
    };
  }
}

function asMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
