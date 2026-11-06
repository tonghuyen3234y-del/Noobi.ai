import type { AgentRuntime } from './agentRuntime.js';

/**
 * Runtime selection.
 *
 * The Codex binary remains the default: it supplies its own agent loop, tool
 * executor and session storage, so it is strictly more capable. A provider
 * built on a plain chat API (DeepSeek) is opt-in and must reimplement all three.
 */

export type AgentProviderId = 'codex' | 'deepseek';

export interface AgentProviderDescriptor {
  id: AgentProviderId;
  label: string;
  /** Short description shown in settings. */
  summary: string;
  /** Environment variable holding an API key, when the provider needs one. */
  apiKeyEnvVar: string | null;
  /** True when the provider ships its own agent loop and tools. */
  selfContained: boolean;
}

export const AGENT_PROVIDERS: readonly AgentProviderDescriptor[] = [
  {
    id: 'codex',
    label: 'Codex App Server',
    summary: '官方 Codex 原生二进制。自带 Agent 循环、工具执行与会话存储。',
    apiKeyEnvVar: null,
    selfContained: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    summary: '国内直连的 API Key 提供方。工具执行与会话由宿主实现，不支持内置图片生成。',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    selfContained: false,
  },
];

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return value === 'codex' || value === 'deepseek';
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
  /** Human-readable blockers, empty when ready. */
  blockers: string[];
}

export function assessProviderReadiness(
  provider: AgentProviderId,
  context: {
    /** Result of `CodexRuntime.status`. */
    codex: { state: string; error: string | null };
    /** Whether an API key is present in the environment. */
    deepseekApiKey: string | null;
    /** Whether an external image API is configured. */
    imageApiConfigured: boolean;
  },
): ProviderReadiness {
  const blockers: string[] = [];
  if (provider === 'codex') {
    if (context.codex.state !== 'ready') {
      blockers.push(context.codex.error ?? 'Codex App Server 未就绪');
    }
    return { provider, ready: blockers.length === 0, blockers };
  }

  if (!context.deepseekApiKey?.trim()) {
    blockers.push('未设置 DEEPSEEK_API_KEY');
  }
  // Codex supplies an in-model image fallback; DeepSeek does not, so the
  // harness's image gate becomes a hard requirement rather than a preference.
  if (!context.imageApiConfigured) {
    blockers.push('DeepSeek 没有内置图片生成，必须配置图片 API 后才能在 Noobi 中制作游戏');
  }
  return { provider, ready: blockers.length === 0, blockers };
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
