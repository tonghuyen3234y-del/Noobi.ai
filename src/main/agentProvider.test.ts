import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_PROVIDERS,
  assessProviderReadiness,
  createRuntimeHolder,
  DEFAULT_AGENT_PROVIDER,
  describeProvider,
  isAgentProviderId,
} from './agentProvider.js';
import type { AgentRuntime } from './agentRuntime.js';

const ready = { state: 'ready', error: null };

describe('agent provider registry', () => {
  it('defaults to ChatGPT login', () => {
    expect(DEFAULT_AGENT_PROVIDER).toBe('openai');
    expect(AGENT_PROVIDERS[0]?.id).toBe('openai');
  });

  it('describes OpenAI as interactive login with built-in image generation', () => {
    const openai = describeProvider('openai');
    expect(openai.credentialKind).toBe('chatgpt-login');
    expect(openai.apiKeyEnvVar).toBeNull();
    expect(openai.builtInImageGeneration).toBe(true);
  });

  it('describes Qwen as a single DashScope key without built-in image generation', () => {
    const qwen = describeProvider('qwen');
    expect(qwen.credentialKind).toBe('api-key');
    expect(qwen.apiKeyEnvVar).toBe('DASHSCOPE_API_KEY');
    // Qwen needs an external image service; this drives the UI warning.
    expect(qwen.builtInImageGeneration).toBe(false);
  });

  it('rejects ids from the retired harness architecture', () => {
    expect(isAgentProviderId('openai')).toBe(true);
    expect(isAgentProviderId('qwen')).toBe(true);
    expect(isAgentProviderId('codex')).toBe(false);
    expect(isAgentProviderId('deepseek')).toBe(false);
    expect(() => describeProvider('deepseek' as never)).toThrow(/Unknown agent provider/u);
  });

  it('lists every provider once', () => {
    const ids = AGENT_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['openai', 'qwen']);
  });
});

describe('provider readiness', () => {
  it('reports OpenAI ready when Codex is up', () => {
    expect(assessProviderReadiness('openai', {
      codex: ready,
      qwenApiKey: null,
      imageApiConfigured: false,
    })).toMatchObject({ ready: true, blockers: [] });
  });

  it('surfaces the Codex runtime error as a blocker', () => {
    const result = assessProviderReadiness('openai', {
      codex: { state: 'error', error: 'binary missing' },
      qwenApiKey: null,
      imageApiConfigured: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('binary missing');
  });

  it('does not treat an unstarted provider as a failure', () => {
    // `stopped` is the normal state before a provider has ever been spawned;
    // calling it a blocker made a valid Qwen setup look broken.
    const result = assessProviderReadiness('qwen', {
      codex: { state: 'stopped', error: null },
      qwenApiKey: 'sk-test',
      imageApiConfigured: true,
    });
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('blocks Qwen without a DashScope key', () => {
    const result = assessProviderReadiness('qwen', {
      codex: ready,
      qwenApiKey: '   ',
      imageApiConfigured: true,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.join()).toMatch(/百炼 API Key/u);
  });

  it('warns rather than blocks Qwen when no image service is configured', () => {
    const result = assessProviderReadiness('qwen', {
      codex: ready,
      qwenApiKey: 'sk-test',
      imageApiConfigured: false,
    });
    // A run that needs no new art must still be possible.
    expect(result.ready).toBe(true);
    expect(result.warnings.join()).toMatch(/图片服务/u);
  });

  it('reports Qwen ready with no warnings when the key and image service exist', () => {
    expect(assessProviderReadiness('qwen', {
      codex: ready,
      qwenApiKey: 'sk-test',
      imageApiConfigured: true,
    })).toMatchObject({ ready: true, blockers: [], warnings: [] });
  });
});

describe('runtime holder', () => {
  it('moves host events to the selected provider without duplicate or stale notifications', () => {
    const first = new EventEmitter() as AgentRuntime;
    const second = new EventEmitter() as AgentRuntime;
    const holder = createRuntimeHolder(first);
    const switching = holder.switching();
    const notification = vi.fn();
    const request = vi.fn();
    const status = vi.fn();
    switching.on('notification', notification);
    switching.on('serverRequest', request);
    switching.once('status', status);

    holder.replace(second);
    holder.replace(second);
    first.emit('notification', { method: 'stale' });
    first.emit('serverRequest', { id: 1, method: 'stale' });
    second.emit('notification', { method: 'item/started' });
    second.emit('serverRequest', { id: 2, method: 'item/tool/call' });
    second.emit('status', { state: 'ready' });
    second.emit('status', { state: 'stopped' });

    expect(notification).toHaveBeenCalledExactlyOnceWith({ method: 'item/started' });
    expect(request).toHaveBeenCalledExactlyOnceWith({ id: 2, method: 'item/tool/call' });
    expect(status).toHaveBeenCalledOnce();
    expect(first.listenerCount('serverRequest')).toBe(0);
    expect(second.listenerCount('serverRequest')).toBe(1);

    switching.removeListener('notification', notification);
    holder.replace(first);
    first.emit('notification', { method: 'unsubscribed' });
    expect(notification).toHaveBeenCalledOnce();
    expect(second.listenerCount('serverRequest')).toBe(0);
  });

  function fakeRuntime(name: string): AgentRuntime {
    return {
      name,
      start: async () => { throw new Error('unused'); },
      stop: async () => undefined,
    } as unknown as AgentRuntime;
  }

  it('forwards method calls to the currently active runtime', () => {
    const holder = createRuntimeHolder(fakeRuntime('first'));
    const switching = holder.switching();
    expect((switching as unknown as { name: string }).name).toBe('first');
    holder.replace(fakeRuntime('second'));
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
