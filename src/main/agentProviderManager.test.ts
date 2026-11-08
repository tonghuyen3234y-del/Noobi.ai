import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentProviderManager, DASHSCOPE_BASE_URL, QWEN_TEXT_MODEL } from './agentProviderManager.js';
import type { ProviderCredentialStore } from './providerCredentialStore.js';
import type { AgentProviderId } from '../shared/contracts.js';
import {
  startQwenResponsesShim,
  toChatMessages,
  toChatTools,
  toResponsesObject,
} from './qwenResponsesShim.js';

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

function manager(options: {
  keys?: Partial<Record<AgentProviderId, string>>;
  imageApi?: boolean;
} = {}) {
  return new AgentProviderManager({
    userDataDir: '/tmp/noobi-provider-test',
    credentials: fakeCredentials(options.keys),
    imageApiConfigured: async () => options.imageApi ?? false,
  });
}

const live: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((shim) => shim.close().catch(() => undefined)));
  vi.restoreAllMocks();
});

describe('AgentProviderManager', () => {
  it('defaults to the ChatGPT provider', () => {
    expect(manager().activeId).toBe('openai');
  });

  it('gives each provider its own Codex home', () => {
    const mgr = manager();
    // Sharing a home would leak ChatGPT tokens into the Qwen session.
    expect(mgr.codexHomeFor('openai')).not.toBe(mgr.codexHomeFor('qwen'));
    expect(mgr.codexHomeFor('qwen')).toContain('codex-home-qwen');
  });

  it('blocks Qwen without a key before spawning Codex', async () => {
    const status = await manager().readiness('qwen');
    expect(status.ready).toBe(false);
    expect(status.blockers.join()).toMatch(/百炼 API Key/u);
  });

  it('reports Qwen as requiring an external image API', async () => {
    const status = await manager({ keys: { qwen: 'sk-a' }, imageApi: true }).readiness('qwen');
    expect(status.requiresImageApi).toBe(true);
  });

  it('pins the Qwen model so a catalog name cannot override it', async () => {
    const mgr = manager({ keys: { qwen: 'sk-a' }, imageApi: true });
    const runtime = await mgr.runtimeOrPlaceholder('qwen');
    // Exposed so main.ts can prefer it over the ChatGPT catalog: forwarding
    // `gpt-5.6-sol` to DashScope fails with "Model not exist".
    expect(runtime.pinnedModel).toBe('qwen-plus');
  });

  it('leaves the OpenAI provider unpinned so its catalog drives model choice', async () => {
    const mgr = manager();
    const runtime = await mgr.runtimeOrPlaceholder('openai');
    expect(runtime.pinnedModel).toBeNull();
  });

  it('returns a placeholder runtime for Qwen without a key, never the OpenAI one', async () => {
    const mgr = manager({ imageApi: true });
    // Returning the OpenAI runtime made the Qwen card display ChatGPT's status.
    const runtime = await mgr.runtimeOrPlaceholder('qwen');
    expect(runtime).toBeTruthy();
    // The choice must stay selectable so the key field can appear at all;
    // gating selection on readiness deadlocked the settings UI.
    mgr.select('qwen');
    expect(mgr.activeId).toBe('qwen');
  });

  it('reports the missing key exactly once', async () => {
    const blockers = (await manager().readiness('qwen')).blockers;
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/百炼 API Key/u);
  });

  it('lists readiness for both providers', async () => {
    const all = await manager().allReadiness();
    expect(all.map((entry) => entry.id)).toEqual(['openai', 'qwen']);
  });

  it('refuses to activate Qwen without a key', async () => {
    await expect(manager().activate('qwen')).rejects.toThrow(/无法启用 qwen/u);
  });
});

describe('Qwen protocol shim', () => {
  it('converts a function_call_output into a tool message', () => {
    const messages = toChatMessages({
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make a file' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'write_file',
          arguments: '{"path":"a.txt"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
    });

    expect(messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(messages[1]).toEqual({ role: 'user', content: 'make a file' });
    expect(messages[2]?.tool_calls?.[0]?.function.name).toBe('write_file');
    // This is the exact shape DashScope rejects upstream: `tool` is only valid
    // in the chat payload, never in a Responses input item.
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ok' });
  });

  it('maps developer messages to system', () => {
    const messages = toChatMessages({
      input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }],
    });
    expect(messages[0]?.role).toBe('system');
  });

  it('flattens Responses tools into chat tools', () => {
    const tools = toChatTools([
      { type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object' } },
    ]);
    expect(tools).toHaveLength(1);
    expect((tools?.[0] as { function: { name: string } }).function.name).toBe('read_file');
  });

  it('returns null when there are no function tools', () => {
    expect(toChatTools(undefined)).toBeNull();
    expect(toChatTools([{ type: 'web_search' }])).toBeNull();
  });

  it('rebuilds tool calls as function_call output items', () => {
    const response = toResponsesObject({
      choices: [{
        message: {
          role: 'assistant',
          content: 'working on it',
          tool_calls: [{
            id: 'call_9',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }, 'qwen-plus', () => 1);

    expect(response.object).toBe('response');
    const output = response.output as Array<Record<string, unknown>>;
    expect(output.map((item) => item.type)).toEqual(['message', 'function_call']);
    expect(output[1]?.call_id).toBe('call_9');
  });

  it('runs end to end against a stubbed upstream', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const shim = await startQwenResponsesShim({
      upstream: DASHSCOPE_BASE_URL,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        seen.push(payload);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'hello there' } }],
            usage: { total_tokens: 7 },
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    live.push(shim);

    const response = await fetch(`${shim.baseUrl}/compatible-mode/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: JSON.stringify({
        model: 'qwen-plus',
        instructions: 'sys',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    });

    expect(response.ok).toBe(true);
    // The shim must call the chat endpoint with system+user messages, never the
    // Responses endpoint that DashScope mishandles.
    expect(seen[0]?.model).toBe('qwen-plus');
    expect((seen[0]?.messages as unknown[]).length).toBe(2);
    const body = await response.json() as Record<string, unknown>;
    expect(body.object).toBe('response');
  });

  it('streams an SSE sequence Codex can consume', async () => {
    const shim = await startQwenResponsesShim({
      upstream: DASHSCOPE_BASE_URL,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'streamed' } }],
        }),
      } as unknown as Response)) as unknown as typeof fetch,
    });
    live.push(shim);

    const response = await fetch(`${shim.baseUrl}/compatible-mode/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: JSON.stringify({ model: QWEN_TEXT_MODEL, input: 'hi', stream: true }),
    });
    const text = await response.text();
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.output_text.delta');
    expect(text).toContain('event: response.completed');
  });

  it('passes through provider errors with their original status', async () => {
    const shim = await startQwenResponsesShim({
      upstream: DASHSCOPE_BASE_URL,
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        text: async () => '{"code":"InvalidApiKey"}',
      } as unknown as Response)) as unknown as typeof fetch,
    });
    live.push(shim);

    const response = await fetch(`${shim.baseUrl}/compatible-mode/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bad' },
      body: JSON.stringify({ model: 'qwen-plus', input: 'hi' }),
    });
    expect(response.status).toBe(401);
  });
});
