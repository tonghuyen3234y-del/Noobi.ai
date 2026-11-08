import type { AgentRuntime } from './agentRuntime.js';

/**
 * Runtime selection.
 *
 * Both engines are Codex App Server. What differs is the model service behind
 * it, which is why they need separate homes and separate credentials:
 *
 *   openai — the user signs in with ChatGPT; Codex talks to OpenAI natively.
 *   qwen   — the user supplies one DashScope (Bailian) API key. Codex cannot
 *            talk to DashScope directly (its Responses implementation rejects
 *            the tool role), so the host runs a protocol shim in between.
 */

export type AgentProviderId = 'openai' | 'qwen';

/** Docker-style capability notes the UI renders verbatim. */
export interface AgentProviderDescriptor {
  id: AgentProviderId;
  label: string;
  /** Short description shown in settings. */
  summary: string;
  /** Credential the provider needs, or null when it uses interactive login. */
  credentialKind: 'chatgpt-login' | 'api-key';
  /** Environment variable Codex reads the key from. */
  apiKeyEnvVar: string | null;
  /** True when image generation comes from the provider itself. */
  builtInImageGeneration: boolean;
}

export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'openai';

export const AGENT_PROVIDERS: readonly AgentProviderDescriptor[] = [
  {
    id: 'openai',
    label: 'ChatGPT 登录',
    summary: '使用 ChatGPT 账号授权 Codex App Server。无需填写 API Key，模型权限由账号决定。',
    credentialKind: 'chatgpt-login',
    apiKeyEnvVar: null,
    builtInImageGeneration: true,
  },
  {
    id: 'qwen',
    label: 'Qwen（百炼）',
    summary: '一个阿里云百炼 API Key 同时用于编程、读图和生图。生图走 Qwen-Image，不依赖 Codex 内置能力。',
    credentialKind: 'api-key',
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    builtInImageGeneration: false,
  },
];

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return value === 'openai' || value === 'qwen';
}

export function describeProvider(id: AgentProviderId): AgentProviderDescriptor {
  const found = AGENT_PROVIDERS.find((provider) => provider.id === id);
  if (!found) throw new Error(`Unknown agent provider: ${String(id)}`);
  return found;
}

/** Facts the UI needs to render honest capability warnings. */
export interface ProviderReadiness {
  provider: AgentProviderId;
  ready: boolean;
  /** Human-readable blockers; empty when ready. */
  blockers: string[];
  /** Non-blocking caveats. */
  warnings: string[];
}

export function assessProviderReadiness(
  provider: AgentProviderId,
  context: {
    /** Codex runtime state for this provider's home. */
    codex: { state: string; error: string | null };
    /** Whether a DashScope key is stored. */
    qwenApiKey: string | null;
    /** Whether an external image API is configured. */
    imageApiConfigured: boolean;
  },
): ProviderReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const descriptor = describeProvider(provider);

  // `stopped` means "not spawned yet", which is the normal state before a
  // provider has ever been activated; only a real failure is a blocker.
  const codexFailed = context.codex.state === 'error'
    || context.codex.state === 'failed';
  if (codexFailed) {
    blockers.push(context.codex.error ?? 'Codex App Server 未就绪');
  }

  if (descriptor.credentialKind === 'api-key' && !context.qwenApiKey?.trim()) {
    blockers.push('未填写阿里云百炼 API Key');
  }

  // Qwen has no in-model image generator, so art needs the DashScope image API.
  // Kept as a warning: a run that needs no new art must still be possible.
  if (!descriptor.builtInImageGeneration && !context.imageApiConfigured) {
    warnings.push('未配置图片服务：需要新素材时会停下，请在设置 → 媒体 API 中填写百炼图像服务。');
  }

  return { provider, ready: blockers.length === 0, blockers, warnings };
}

/** Swap the runtime a set of long-lived collaborators points at. */
export interface RuntimeHolder {
  readonly current: AgentRuntime;
  replace(runtime: AgentRuntime): void;
}

/**
 * Builds a runtime holder.
 *
 * `GameHarness`, `GameEngineAdvisor`, `ApprovalBroker` and the MCP manager all
 * capture a runtime instance at construction, so switching providers by
 * reassigning a field would leave them pointing at the old one. `switching()`
 * returns a stable proxy that always forwards to the active runtime, which lets
 * those collaborators be constructed once and still follow a provider change.
 */
export function createRuntimeHolder(initial: AgentRuntime): RuntimeHolder & {
  switching(): AgentRuntime;
} {
  let current = initial;
  const target = (): AgentRuntime => current;

  const proxy = new Proxy({} as AgentRuntime, {
    get(_target, property) {
      const active = target() as unknown as Record<PropertyKey, unknown>;
      const value = active[property];
      // Bind methods to the live runtime so `this` is always correct after a swap.
      return typeof value === 'function' ? value.bind(active) : value;
    },
    set(_target, property, value) {
      (target() as unknown as Record<PropertyKey, unknown>)[property] = value;
      return true;
    },
    has(_target, property) {
      return property in (target() as unknown as object);
    },
  });

  return {
    get current() {
      return current;
    },
    replace(runtime: AgentRuntime) {
      current = runtime;
    },
    switching() {
      return proxy;
    },
  };
}
