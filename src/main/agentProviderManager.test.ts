import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentProviderManager } from './agentProviderManager.js';
import type { CodexAppServer } from './codexAppServer.js';
import type { ProviderCredentialStore } from './providerCredentialStore.js';
import type { AgentProviderId } from '../shared/contracts.js';

function fakeCodex(state: 'ready' | 'error' = 'ready'): CodexAppServer {
  return {
    status: {
      state,
      binaryPath: '/usr/local/bin/codex',
      version: '0.148.0',
      codexHome: '/tmp/codex-home',
      account: null,
      models: [],
      capabilities: {
        namespaceTools: true,
        imageGeneration: true,
        externalImageGeneration: false,
        webSearch: true,
      },
      error: state === 'error' ? 'binary missing' : null,
    },
    stop: vi.fn(async () => undefined),
  } as unknown as CodexAppServer;
}

function fakeCredentials(keys: Partial<Record<AgentProviderId, string>> = {}) {
  const store = new Map<AgentProviderId, string>(Object.entries(keys) as never);
  return {
    reveal: vi.fn(async (provider: AgentProviderId) => store.get(provider) ?? null),
    has: vi.fn(async (provider: AgentProviderId) => store.has(provider)),
    status: vi.fn(async () => []),
    set: vi.fn(async (provider: AgentProviderId, key: string) => {
      if (key.trim()) store.set(provider, key.trim());
      else store.delete(provider);
    }),
  } as unknown as ProviderCredentialStore;
}

let userDataDir: string;

beforeEach(() => {
  userDataDir = '/tmp/noobi-provider-test';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function manager(options: {
  codexState?: 'ready' | 'error';
  keys?: Partial<Record<AgentProviderId, string>>;
  imageApi?: boolean;
}) {
  return new AgentProviderManager({
    userDataDir,
    credentials: fakeCredentials(options.keys),
    codex: fakeCodex(options.codexState ?? 'ready'),
    imageApiConfigured: async () => options.imageApi ?? false,
  });
}

describe('AgentProviderManager readiness', () => {
  it('starts on Codex and reports it ready', async () => {
    const mgr = manager({});
    expect(mgr.activeId).toBe('codex');
    expect(await mgr.readiness('codex')).toMatchObject({ active: true, ready: true, blockers: [] });
  });

  it('propagates a Codex runtime error as a blocker', async () => {
    const status = await manager({ codexState: 'error' }).readiness('codex');
    expect(status.ready).toBe(false);
    expect(status.blockers).toContain('binary missing');
  });

  it('marks DeepSeek as requiring an image API', async () => {
    const status = await manager({ keys: { deepseek: 'sk-a' }, imageApi: true }).readiness('deepseek');
    expect(status.requiresImageApi).toBe(true);
    expect(status.active).toBe(false);
  });

  it('reports both blockers when a DeepSeek key and an image API are missing', async () => {
    const status = await manager({}).readiness('deepseek');
    expect(status.ready).toBe(false);
    expect(status.blockers).toHaveLength(2);
    expect(status.blockers.join()).toMatch(/DEEPSEEK_API_KEY/u);
    expect(status.blockers.join()).toMatch(/图片 API/u);
  });

  it('lists readiness for every registered provider', async () => {
    const all = await manager({}).allReadiness();
    expect(all.map((entry) => entry.id)).toEqual(['codex', 'deepseek']);
  });
});

describe('AgentProviderManager activation', () => {
  it('refuses to activate DeepSeek without a key instead of failing later', async () => {
    const mgr = manager({});
    await expect(mgr.activate('deepseek')).rejects.toThrow(/无法启用 deepseek/u);
    // Refusal must not change the active provider.
    expect(mgr.activeId).toBe('codex');
  });

  it('refuses to activate DeepSeek without an image API', async () => {
    const mgr = manager({ keys: { deepseek: 'sk-a' }, imageApi: false });
    await expect(mgr.activate('deepseek')).rejects.toThrow(/图片 API/u);
    expect(mgr.activeId).toBe('codex');
  });

  it('activates DeepSeek when both prerequisites hold', async () => {
    const mgr = manager({ keys: { deepseek: 'sk-a' }, imageApi: true });
    const runtime = await mgr.activate('deepseek');
    expect(runtime).toBeTruthy();
    expect(mgr.activeId).toBe('deepseek');
    expect((await mgr.readiness('deepseek')).active).toBe(true);
    await mgr.dispose();
  });

  it('returns the same Codex instance for the codex provider', async () => {
    const codex = fakeCodex();
    const mgr = new AgentProviderManager({
      userDataDir,
      credentials: fakeCredentials(),
      codex,
      imageApiConfigured: async () => false,
    });
    expect(await mgr.runtimeFor('codex')).toBe(codex);
  });

  it('invalidates a cached DeepSeek runtime so a new key takes effect', async () => {
    const mgr = manager({ keys: { deepseek: 'sk-a' }, imageApi: true });
    const first = await mgr.activate('deepseek');
    mgr.invalidate();
    const second = await mgr.runtimeFor('deepseek');
    // After invalidation the manager must build a fresh runtime, not reuse one
    // holding the previous credential.
    expect(second).not.toBe(first);
    await mgr.dispose();
  });

  it('stops the outgoing provider when switching away', async () => {
    const codex = fakeCodex();
    const mgr = new AgentProviderManager({
      userDataDir,
      credentials: fakeCredentials({ deepseek: 'sk-a' }),
      codex,
      imageApiConfigured: async () => true,
    });
    await mgr.activate('deepseek');
    const deepseek = await mgr.runtimeFor('deepseek');
    const stop = vi.spyOn(deepseek, 'stop');
    await mgr.activate('codex');
    expect(stop).toHaveBeenCalled();
    expect(mgr.activeId).toBe('codex');
  });
});
