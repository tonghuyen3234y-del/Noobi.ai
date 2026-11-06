import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import { GameHarness } from './gameHarness.js';
import { GameEngineAdvisor } from './gameEngineAdvisor.js';
import { CODEX_RUNTIME_FEATURES } from './agentRuntime.js';
import type {
  AgentRuntime,
  AgentRuntimeFeatureSet,
  StartThreadOptions,
  StartTurnOptions,
  TurnResult,
} from './agentRuntime.js';

/**
 * Contract tests for the provider-neutral `AgentRuntime` boundary.
 *
 * These pin down what a non-Codex runtime (e.g. a future DeepSeekRuntime) must
 * satisfy for `GameHarness` to keep working unmodified. They deliberately use a
 * minimal fake so the contract is expressed by behaviour, not by transport.
 */

interface FakeRuntimeOptions {
  /** Reply per phase, derived from the role instructions in the prompt. */
  reply?: (options: StartTurnOptions, turnIndex: number) => string;
  turnStatus?: string;
  /** Set false to model a runtime that returns a turn id but never notifies. */
  autoEmit?: boolean;
}

class FakeAgentRuntime extends EventEmitter implements AgentRuntime {
  readonly startedThreads: StartThreadOptions[] = [];
  readonly turns: StartTurnOptions[] = [];
  readonly interrupted: string[] = [];
  readonly unsubscribed: string[] = [];
  stopCalls = 0;

  #status = {
    state: 'stopped' as const,
    binaryPath: null,
    version: null,
    codexHome: null,
    account: null,
    models: [],
    capabilities: {
      namespaceTools: false,
      imageGeneration: false,
      externalImageGeneration: false,
      webSearch: false,
    },
    error: null,
  };
  #threadSeq = 0;
  #turnSeq = 0;
  readonly #options: FakeRuntimeOptions;
  readonly #autoEmit: boolean;

  constructor(options: FakeRuntimeOptions = {}) {
    super();
    this.#options = options;
    this.#autoEmit = options.autoEmit ?? true;
  }

  get status() {
    return structuredClone(this.#status) as AgentRuntime['status'];
  }

  async start() {
    this.#status = { ...this.#status, state: 'ready' };
    return this.status;
  }

  async refresh() {
    return this.status;
  }

  async stop() {
    this.stopCalls += 1;
    this.#status = { ...this.#status, state: 'stopped' };
  }

  async readAccount() { return null; }
  async listModels() { return []; }
  async readModelProviderCapabilities() { return this.#status.capabilities; }
  async startLogin() { throw new Error('login is not supported by this runtime'); }
  async logout() { return this.status; }

  async startThread(options: StartThreadOptions) {
    this.startedThreads.push(options);
    this.#threadSeq += 1;
    return `thread-${this.#threadSeq}`;
  }

  async resumeThread(threadId: string, options: StartThreadOptions) {
    this.startedThreads.push(options);
    return threadId;
  }

  /**
   * A replacement runtime is responsible for emitting the same notification
   * shape the Codex transport produces, because `GameHarness` observes turns
   * through `notification` events and never reads this return value.
   */
  async startTurn(options: StartTurnOptions) {
    this.turns.push(options);
    this.#turnSeq += 1;
    const turnId = `turn-${this.#turnSeq}`;
    if (this.#autoEmit) {
      const text = this.#options.reply?.(options, this.turns.length - 1) ?? 'ok';
      setImmediate(() => {
        this.emit('notification', {
          method: 'item/agentMessage/delta',
          params: { threadId: options.threadId, turnId, delta: text },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: options.threadId,
            turnId,
            turn: { id: turnId, status: this.#options.turnStatus ?? 'completed' },
          },
        });
      });
    }
    return turnId;
  }

  async runTurn(options: StartTurnOptions): Promise<TurnResult> {
    const turnId = await this.startTurn(options);
    const turnIndex = this.turns.length - 1;
    return {
      turnId,
      status: this.#options.turnStatus ?? 'completed',
      text: this.#options.reply?.(options, turnIndex) ?? 'ok',
      raw: { turn: { status: this.#options.turnStatus ?? 'completed' } },
    };
  }

  async interruptTurn(_threadId: string, turnId: string) {
    this.interrupted.push(turnId);
  }

  async unsubscribeThread(threadId: string) {
    this.unsubscribed.push(threadId);
  }

  respondToServerRequest() {}
  rejectServerRequest() {}

  async listSkills() { return []; }
  async setSkillEnabled() { return false; }
  async listMcpServerStatuses() { return []; }
  async readConfig() { return {}; }
  async writeConfigValue() {}
  async reloadMcpServers() {}
}

describe('AgentRuntime contract', () => {
  it('lets GameHarness drive a full planner → implementer → reviewer run', async () => {
    const runtime = new FakeAgentRuntime({
      reply: (_options, turnIndex) => (turnIndex === 2
        ? '{"verdict":"pass","summary":"looks good","findings":[]}'
        : 'done'),
    });
    const harness = new GameHarness(runtime);
    const result = await harness.run({
      projectId: 'p1',
      cwd: '/tmp/p1',
      prompt: 'build a game',
      imageGenerationRoute: 'configured-api',
    });

    expect(result.review.verdict).toBe('pass');
    expect(result.repairAttempts).toBe(0);
    // Planner and Reviewer are ephemeral read-only threads; only the
    // Implementer is durable and workspace-writable.
    expect(runtime.startedThreads.map((thread) => thread.ephemeral)).toEqual([true, false, true]);
    expect(runtime.startedThreads.map((thread) => thread.sandbox)).toEqual([
      'read-only',
      'workspace-write',
      'read-only',
    ]);
    expect(runtime.turns).toHaveLength(3);
    expect(result.threadId).toBe('thread-2');
  });

  it('requires the turn/completed notification contract from any runtime', async () => {
    // A runtime that only returns a turn id and never notifies leaves the
    // harness waiting until its 20-minute per-turn deadline. This pins the
    // hardest contract for a non-Codex transport: it must emit
    // `item/agentMessage/delta` and `turn/completed` itself, because the
    // harness never reads the value returned by `startTurn`.
    const runtime = new FakeAgentRuntime({ autoEmit: false });
    const harness = new GameHarness(runtime);
    const settled = harness.run({
      projectId: 'p2',
      cwd: '/tmp/p2',
      prompt: 'ship it',
      imageGenerationRoute: 'configured-api',
    });
    const raced = await Promise.race([
      settled.then(() => 'finished' as const, () => 'failed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 150)),
    ]);
    expect(raced).toBe('hung');
    // Detach without awaiting: `stop()` itself waits on the pending turn.
    void harness.stop('p2').catch(() => undefined);
    void settled.catch(() => undefined);
  });

  it('surfaces a non-completed turn status as a failure instead of a pass', async () => {
    const runtime = new FakeAgentRuntime({ turnStatus: 'failed' });
    const harness = new GameHarness(runtime);
    await expect(
      harness.run({
        projectId: 'p3',
        cwd: '/tmp/p3',
        prompt: 'anything',
        imageGenerationRoute: 'configured-api',
      }),
    ).rejects.toThrow(/status failed/u);
  });

  it('drives GameEngineAdvisor through the same interface', async () => {
    const runtime = new FakeAgentRuntime({
      reply: () => '{"engine":"web","confidence":"high","reasonCode":"browser-2d","rationale":"2D card game"}',
    });
    const advisor = new GameEngineAdvisor(runtime);
    const decision = await advisor.decide({
      cwd: '/tmp/p4',
      idea: 'a card game',
      attachments: [],
      model: null,
      godot: { canCreateProjects: true },
    } as never);
    expect(decision.engine).toBe('web');
    expect(runtime.startedThreads[0]?.sandbox).toBe('read-only');
    expect(runtime.startedThreads[0]?.ephemeral).toBe(true);
    expect(runtime.unsubscribed).toHaveLength(1);
  });
});

describe('AgentRuntime feature flags', () => {
  it('declares which capabilities a replacement runtime must reimplement', () => {
    const required: Array<keyof AgentRuntimeFeatureSet> = [
      'dynamicTools',
      'threadResume',
      'builtInImageGeneration',
      'nativeSkills',
      'nativeMcp',
      'interactiveLogin',
    ];
    // Codex provides all of them; a DeepSeek replacement must explicitly
    // declare the ones it lacks rather than silently no-op.
    for (const key of required) {
      expect(CODEX_RUNTIME_FEATURES[key]).toBe(true);
    }
  });
});
