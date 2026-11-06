import { describe, expect, it } from 'vitest';

import {
  AGENT_PROVIDERS,
  assessProviderReadiness,
  createRuntimeHolder,
  describeProvider,
  isAgentProviderId,
} from './agentProvider.js';
import type { AgentRuntime } from './agentRuntime.js';
import { CODEX_RUNTIME_FEATURES } from './agentRuntime.js';

describe('agent provider registry', () => {
  it('keeps Codex as the default and marks it self-contained', () => {
    const codex = describeProvider('codex');
    expect(codex.selfContained).toBe(true);
    expect(codex.apiKeyEnvVar).toBeNull();
  });

  it('declares that DeepSeek needs an API key and is not self-contained', () => {
    const deepseek = describeProvider('deepseek');
    expect(deepseek.selfContained).toBe(false);
    expect(deepseek.apiKeyEnvVar).toBe('DEEPSEEK_API_KEY');
  });

  it('rejects unknown provider ids', () => {
    expect(isAgentProviderId('codex')).toBe(true);
    expect(isAgentProviderId('deepseek')).toBe(true);
    expect(isAgentProviderId('openai')).toBe(false);
    expect(isAgentProviderId(null)).toBe(false);
    expect(() => describeProvider('nope' as never)).toThrow(/Unknown agent provider/u);
  });

  it('lists every provider once', () => {
    const ids = AGENT_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('provider readiness', () => {
  const ready = { state: 'ready', error: null };

  it('reports Codex ready when the runtime is up', () => {
    expect(assessProviderReadiness('codex', {
      codex: ready,
      deepseekApiKey: null,
      imageApiConfigured: false,
    })).toMatchObject({ ready: true, blockers: [] });
  });

  it('surfaces the Codex runtime error as a blocker', () => {
    const result = assessProviderReadiness('codex', {
      codex: { state: 'error', error: 'binary missing' },
      deepseekApiKey: null,
      imageApiConfigured: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('binary missing');
  });

  it('blocks DeepSeek without an API key', () => {
    const result = assessProviderReadiness('deepseek', {
      codex: ready,
      deepseekApiKey: '   ',
      imageApiConfigured: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.join()).toMatch(/DEEPSEEK_API_KEY/u);
  });

  it('blocks DeepSeek without an image API, because it has no ImageGen fallback', () => {
    const result = assessProviderReadiness('deepseek', {
      codex: ready,
      deepseekApiKey: 'sk-test',
      imageApiConfigured: false,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.join()).toMatch(/图片 API/u);
  });

  it('reports DeepSeek ready when both the key and image API exist', () => {
    expect(assessProviderReadiness('deepseek', {
      codex: ready,
      deepseekApiKey: 'sk-test',
      imageApiConfigured: true,
    })).toMatchObject({ ready: true, blockers: [] });
  });
});

describe('runtime holder', () => {
  function fakeRuntime(name: string): AgentRuntime {
    return {
      name,
      start: async () => { throw new Error('unused'); },
      stop: async () => undefined,
    } as unknown as AgentRuntime;
  }

  it('forwards method calls to the currently active runtime', async () => {
    const first = fakeRuntime('first');
    const second = fakeRuntime('second');
    const holder = createRuntimeHolder(first);
    const switching = holder.switching();

    expect((switching as unknown as { name: string }).name).toBe('first');
    holder.replace(second);
    expect((switching as unknown as { name: string }).name).toBe('second');
  });

  it('keeps `this` bound to the live runtime after a swap', async () => {
    let called: string | null = null;
    const make = (label: string) => ({
      label,
      async listSkills() {
        called = (this as unknown as { label: string }).label;
        return [];
      },
    }) as unknown as AgentRuntime;

    const holder = createRuntimeHolder(make('alpha'));
    const switching = holder.switching();
    await switching.listSkills();
    expect(called).toBe('alpha');

    holder.replace(make('beta'));
    await switching.listSkills();
    expect(called).toBe('beta');
  });

  it('does not affect an already-captured direct reference', () => {
    const first = fakeRuntime('first');
    const holder = createRuntimeHolder(first);
    holder.replace(fakeRuntime('second'));
    // Documents why consumers must use `switching()`: a raw capture goes stale.
    expect((first as unknown as { name: string }).name).toBe('first');
    expect((holder.current as unknown as { name: string }).name).toBe('second');
  });
});

describe('runtime feature expectations', () => {
  it('records that Codex provides every capability a replacement must restore', () => {
    // If this changes, the DeepSeek migration plan is out of date.
    expect(CODEX_RUNTIME_FEATURES).toEqual({
      dynamicTools: true,
      threadResume: true,
      builtInImageGeneration: true,
      nativeSkills: true,
      nativeMcp: true,
      interactiveLogin: true,
    });
  });
});
