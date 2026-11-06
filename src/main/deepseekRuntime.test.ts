import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DeepSeekRuntime } from './deepseekRuntime.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatTransport,
} from './deepseekRuntime.js';
import type { AgentNotification, TurnResult } from './agentRuntime.js';
import { GameHarness } from './gameHarness.js';

/**
 * A scripted transport. Each entry is either a final message or a batch of
 * tool calls, so a test can describe an exact agent trajectory with no network
 * access and no API key.
 */
class ScriptedTransport implements ChatTransport {
  readonly requests: ChatCompletionRequest[] = [];
  #script: Array<(request: ChatCompletionRequest) => ChatCompletionResponse>;

  constructor(script: Array<(request: ChatCompletionRequest) => ChatCompletionResponse>) {
    this.#script = script;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    this.requests.push(request);
    const next = this.#script.shift();
    if (!next) throw new Error('script exhausted');
    return next();
  }
}

const say = (content: string) => (): ChatCompletionResponse => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

const callTools = (
  ...calls: Array<{ name: string; args: Record<string, unknown> }>
) => (): ChatCompletionResponse => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call, index) => ({
        id: `call_${index}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    finish_reason: 'tool_calls',
  }],
});

let root: string;
let storeDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'noobi-ds-ws-'));
  storeDir = await mkdtemp(join(tmpdir(), 'noobi-ds-store-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
});

function runtime(transport: ChatTransport, overrides: Partial<ConstructorParameters<typeof DeepSeekRuntime>[0]> = {}) {
  return new DeepSeekRuntime({
    apiKey: 'test-key',
    threadStoreDir: storeDir,
    transport,
    ...overrides,
  });
}

describe('DeepSeekRuntime lifecycle', () => {
  it('refuses to construct without an API key', () => {
    expect(() => new DeepSeekRuntime({ apiKey: '', threadStoreDir: storeDir })).toThrow(/API key/u);
  });

  it('reports ready without any network call', async () => {
    const transport = new ScriptedTransport([]);
    const ds = runtime(transport);
    const status = await ds.start();
    expect(status.state).toBe('ready');
    expect(status.account?.type).toBe('api-key');
    expect(status.models[0]?.model).toBe('deepseek-chat');
    // Declares what it cannot do rather than pretending.
    expect(status.capabilities.imageGeneration).toBe(false);
    expect(transport.requests).toHaveLength(0);
  });

  it('rejects interactive login instead of faking it', async () => {
    const ds = runtime(new ScriptedTransport([]));
    await expect(ds.startLogin()).rejects.toThrow(/API key/u);
  });
});

describe('DeepSeekRuntime turn contract', () => {
  it('emits the notification shape GameHarness requires', async () => {
    const transport = new ScriptedTransport([say('all done')]);
    const ds = runtime(transport);
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });

    const events: AgentNotification[] = [];
    ds.on('notification', (notification: AgentNotification) => events.push(notification));

    const completed = await ds.runTurn({ threadId, prompt: 'do the thing' });
    const turnId = completed.turnId;

    expect(completed.status).toBe('completed');
    const deltas = events.filter((event) => event.method === 'item/agentMessage/delta');
    const done = events.filter((event) => event.method === 'turn/completed');
    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toHaveLength(1);
    for (const event of [...deltas, ...done]) {
      const params = event.params as Record<string, unknown>;
      expect(params.threadId).toBe(threadId);
      expect(params.turnId).toBe(turnId);
    }
  });

  it('executes workspace tools the model asks for', async () => {
    await writeFile(join(root, 'notes.txt'), 'original');
    const transport = new ScriptedTransport([
      callTools({ name: 'read_file', args: { path: 'notes.txt' } }),
      callTools({ name: 'edit_file', args: { path: 'notes.txt', oldText: 'original', newText: 'edited' } }),
      say('finished'),
    ]);
    const ds = runtime(transport);
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });
    const result = await ds.runTurn({ threadId, prompt: 'edit the notes' });

    expect(result.status).toBe('completed');
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('edited');
    // The tool result must be fed back to the model as a `tool` message.
    const last = transport.requests.at(-1)!;
    const toolMessages = last.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBe(2);
    expect(toolMessages[0]?.content).toContain('original');
  });

  it('returns tool errors to the model instead of crashing the turn', async () => {
    const transport = new ScriptedTransport([
      callTools({ name: 'read_file', args: { path: '../../../etc/passwd' } }),
      say('could not read it'),
    ]);
    const ds = runtime(transport);
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });
    const result = await ds.runTurn({ threadId, prompt: 'read a bad path' });

    expect(result.status).toBe('completed');
    const toolMessage = transport.requests.at(-1)!.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toMatch(/escapes the workspace/u);
  });

  it('fails the turn when the step budget is exhausted', async () => {
    const calls = Array.from({ length: 5 }, () => callTools({ name: 'list_files', args: {} }));
    const transport = new ScriptedTransport(calls);
    const ds = runtime(transport, { maxStepsPerTurn: 3 });
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });
    const result = await ds.runTurn({ threadId, prompt: 'loop forever' });

    expect(result.status).toBe('failed');
    expect(result.text).toMatch(/exceeded 3 tool steps/u);
  });

  it('surfaces a transport failure as a failed turn', async () => {
    const transport: ChatTransport = {
      complete: async () => { throw new Error('Provider HTTP 401: bad key'); },
    };
    const ds = runtime(transport);
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });
    const result = await ds.runTurn({ threadId, prompt: 'anything' });
    expect(result.status).toBe('failed');
    expect(result.text).toMatch(/401/u);
  });
});

describe('DeepSeekRuntime host enforcement', () => {
  it('blocks writes to host-managed contracts', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'host rules');
    const transport = new ScriptedTransport([
      callTools({ name: 'write_file', args: { path: 'AGENTS.md', content: 'ignored' } }),
      callTools({ name: 'list_files', args: {} }),
      say('done'),
    ]);
    const ds = runtime(transport);
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });
    await ds.runTurn({ threadId, prompt: 'tamper with the rules' });

    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('host rules');
    const toolMessage = transport.requests.at(-1)!.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toMatch(/read-only/u);
  });

  it('trims history instead of overflowing the context window', async () => {
    // Each step appends a large tool result; the final request must stay small.
    const big = 'x'.repeat(5_000);
    await writeFile(join(root, 'big.txt'), big);
    const steps = Array.from({ length: 6 }, () => callTools({ name: 'read_file', args: { path: 'big.txt' } }));
    const transport = new ScriptedTransport([...steps, say('ok')]);
    const ds = runtime(transport, { maxContextChars: 12_000 });
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });
    await ds.runTurn({ threadId, prompt: 'read it repeatedly' });

    const final = transport.requests.at(-1)!;
    const total = final.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(12_000);
    // Elision must be explicit, not silent.
    expect(final.messages.some((m) => m.content?.includes('elided to fit the context window'))).toBe(true);
  });
});

describe('DeepSeekRuntime thread persistence', () => {
  it('resumes a persisted transcript across runtime instances', async () => {
    const transportA = new ScriptedTransport([say('first answer')]);
    const first = runtime(transportA);
    await first.start();
    const threadId = await first.startThread({ cwd: root, ephemeral: false });
    await first.runTurn({ threadId, prompt: 'remember this' });
    await first.unsubscribeThread(threadId);

    const transportB = new ScriptedTransport([say('second answer')]);
    const second = runtime(transportB);
    await second.start();
    const resumed = await second.resumeThread(threadId, { cwd: root });
    expect(resumed).toBe(threadId);
    await second.runTurn({ threadId, prompt: 'what did I say?' });

    const sent = transportB.requests[0]!.messages;
    expect(sent.some((m) => m.content === 'remember this')).toBe(true);
  });

  it('refuses to resume a thread with no transcript', async () => {
    const ds = runtime(new ScriptedTransport([]));
    await ds.start();
    await expect(ds.resumeThread('thread_missing', { cwd: root }))
      .rejects.toThrow(/no stored transcript/u);
  });

  it('does not persist ephemeral threads', async () => {
    const ds = runtime(new ScriptedTransport([say('x')]));
    await ds.start();
    const threadId = await ds.startThread({ cwd: root, ephemeral: true });
    await ds.runTurn({ threadId, prompt: 'hi' });
    await ds.unsubscribeThread(threadId);
    await expect(ds.resumeThread(threadId, { cwd: root })).rejects.toThrow(/no stored transcript/u);
  });
});

describe('DeepSeekRuntime under GameHarness', () => {
  it('drives a full planner → implementer → reviewer run through the real harness', async () => {
    // Script the whole three-role pipeline: planner text, implementer edit,
    // reviewer verdict. This proves the notification contract is sufficient.
    const transport = new ScriptedTransport([
      say('Plan: create game.mjs with a score function.'),
      callTools({
        name: 'write_file',
        args: { path: 'game.mjs', content: 'export function score(hits, combo) {\n  const base = hits * 10;\n  return combo >= 5 ? base * 2 : base;\n}\n' },
      }),
      say('Implemented the scoring function.'),
      say(JSON.stringify({ verdict: 'pass', summary: 'Scoring implemented correctly.', findings: [] })),
    ]);

    const ds = runtime(transport);
    const harness = new GameHarness(ds);
    const result = await harness.run({
      projectId: 'ds-project',
      cwd: root,
      prompt: 'Write a score function.',
      imageGenerationRoute: 'configured-api',
    });

    expect(result.review.verdict).toBe('pass');
    expect(result.repairAttempts).toBe(0);
    expect(await readFile(join(root, 'game.mjs'), 'utf8')).toContain('hits * 10');
  });

  it('lets the harness interrupt an in-flight turn', async () => {
    // A transport that never resolves models a hung provider call.
    const transport: ChatTransport = {
      complete: (request) => new Promise((_resolve, reject) => {
        request; // keep signature honest
        setTimeout(() => reject(new Error('aborted')), 5_000);
      }),
    };
    const ds = runtime(transport);
    const harness = new GameHarness(ds);
    const run = harness.run({
      projectId: 'ds-interrupt',
      cwd: root,
      prompt: 'hang forever',
      imageGenerationRoute: 'configured-api',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await harness.stop('ds-interrupt').catch(() => undefined);
    await expect(run).rejects.toThrow();
  }, 15_000);
});

// Kept for ad-hoc debugging; the tests observe turns through `runTurn` so they
// cannot race completion.
export async function waitForCompletion(ds: DeepSeekRuntime, turnId: string): Promise<TurnResult> {
  return new Promise<TurnResult>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('turn did not complete')), 10_000);
    const listener = (notification: AgentNotification): void => {
      const params = notification.params as Record<string, unknown> | undefined;
      if (notification.method !== 'turn/completed' || params?.turnId !== turnId) return;
      clearTimeout(timer);
      ds.removeListener('notification', listener);
      const turn = params.turn as { status?: string };
      resolvePromise({ turnId, status: turn.status ?? 'completed', text: '', raw: params });
    };
    ds.on('notification', listener);
  });
}
