import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  LoginStartResult,
  ModelOption,
  RuntimeAccount,
  RuntimeCapabilities,
  RuntimeStatus,
} from '../shared/contracts.js';
import type {
  AgentMcpServerStatus,
  AgentNotification,
  AgentRuntime,
  AgentSkillSummary,
  DynamicToolSpec,
  JsonValue,
  StartThreadOptions,
  StartTurnOptions,
  TurnResult,
} from './agentRuntime.js';
import {
  executeWorkspaceTool,
  WORKSPACE_TOOL_SPECS,
  WorkspaceTools,
} from './workspaceTools.js';

/**
 * Agent runtime backed by a plain chat-completions API (DeepSeek).
 *
 * The Codex binary supplies an agent loop, tool execution, session storage and
 * approvals. None of that exists behind an HTTP chat API, so this class
 * reimplements each piece and translates the result into the exact notification
 * shape `GameHarness` already consumes.
 */

export interface ChatToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: ChatMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Injected transport. Tests supply a fake; production uses `fetchTransport`.
 * Keeping it behind an interface means the runtime is testable without a key.
 */
export interface ChatTransport {
  complete(request: ChatCompletionRequest, signal: AbortSignal): Promise<ChatCompletionResponse>;
}

export interface DeepSeekRuntimeOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Absolute directory for persisted thread transcripts. */
  threadStoreDir: string;
  /** Extra host tools (media generation) merged with the workspace tools. */
  buildHostTools?: (context: { cwd: string }) => DynamicToolSpec[];
  /** Execute a host tool declared through `buildHostTools`. */
  executeHostTool?: (
    name: string,
    args: Record<string, unknown>,
    context: { cwd: string; threadId: string; turnId: string },
  ) => Promise<{ ok: boolean; content: string }>;
  /** Workspace-relative paths the agent may read but never write. */
  readonlyPaths?: string[];
  maxStepsPerTurn?: number;
  maxContextChars?: number;
  transport?: ChatTransport;
  temperature?: number;
}

interface ThreadState {
  id: string;
  cwd: string;
  ephemeral: boolean;
  model: string | null;
  messages: ChatMessage[];
  developerInstructions: string | null;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  controller: AbortController;
  text: string;
  settled: boolean;
  /** Set once the turn reaches a terminal state. */
  result: TurnResult | null;
}

const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MAX_CONTEXT_CHARS = 180_000;
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const TURN_TIMEOUT_MS = 20 * 60 * 1_000;

export class DeepSeekRuntime extends EventEmitter implements AgentRuntime {
  readonly #options: DeepSeekRuntimeOptions;
  readonly #transport: ChatTransport;
  readonly #threads = new Map<string, ThreadState>();
  readonly #turns = new Map<string, ActiveTurn>();
  /** Completed turns retained briefly so `runTurn` never races completion. */
  readonly #finished = new Map<string, TurnResult>();
  readonly #toolsByRoot = new Map<string, WorkspaceTools>();
  #runtime: RuntimeStatus = emptyRuntimeStatus();
  #startPromise: Promise<RuntimeStatus> | null = null;

  constructor(options: DeepSeekRuntimeOptions) {
    super();
    if (!options.apiKey?.trim()) throw new Error('DeepSeek API key is required');
    if (!options.threadStoreDir) throw new Error('threadStoreDir is required');
    this.#options = options;
    this.#transport = options.transport ?? fetchTransport({
      baseUrl: options.baseUrl?.trim() || DEFAULT_BASE_URL,
      apiKey: options.apiKey.trim(),
    });
  }

  get status(): RuntimeStatus {
    return structuredClone(this.#runtime);
  }

  get model(): string {
    return this.#options.model?.trim() || DEFAULT_MODEL;
  }

  async start(): Promise<RuntimeStatus> {
    if (this.#runtime.state === 'ready') return this.status;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async #start(): Promise<RuntimeStatus> {
    this.#runtime = { ...emptyRuntimeStatus(), state: 'starting' };
    this.emit('status', this.status);
    try {
      await mkdir(this.#options.threadStoreDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.#runtime = { ...this.#runtime, state: 'error', error: asMessage(error) };
      this.emit('status', this.status);
      throw error;
    }
    // Unlike Codex, there is no account or model catalog to introspect: the
    // provider is configured, not discovered.
    this.#runtime = {
      ...this.#runtime,
      state: 'ready',
      error: null,
      account: { type: 'api-key', email: null, planType: null },
      models: [this.#modelOption()],
      capabilities: {
        namespaceTools: false,
        imageGeneration: false,
        externalImageGeneration: false,
        webSearch: false,
      },
    };
    this.emit('status', this.status);
    return this.status;
  }

  async refresh(): Promise<RuntimeStatus> {
    return this.start();
  }

  async stop(): Promise<void> {
    for (const turn of this.#turns.values()) {
      if (!turn.settled) {
        turn.settled = true;
        turn.controller.abort();
      }
    }
    this.#turns.clear();
    this.#finished.clear();
    this.#toolsByRoot.clear();
    this.#runtime = { ...emptyRuntimeStatus() };
    this.emit('status', this.status);
  }

  async readAccount(): Promise<RuntimeAccount | null> {
    return (await this.start()).account;
  }

  async listModels(): Promise<ModelOption[]> {
    return (await this.start()).models;
  }

  async readModelProviderCapabilities(): Promise<RuntimeCapabilities> {
    return (await this.start()).capabilities;
  }

  async startLogin(): Promise<LoginStartResult> {
    throw new Error('This runtime authenticates with an API key; interactive login is unavailable.');
  }

  async logout(): Promise<RuntimeStatus> {
    this.#runtime = { ...this.#runtime, account: null };
    this.emit('status', this.status);
    return this.status;
  }

  async startThread(options: StartThreadOptions): Promise<string> {
    await this.start();
    const thread: ThreadState = {
      id: `thread_${randomUUID()}`,
      cwd: options.cwd,
      ephemeral: options.ephemeral ?? false,
      model: options.model ?? null,
      messages: [],
      developerInstructions: options.developerInstructions ?? null,
    };
    this.#threads.set(thread.id, thread);
    // Ephemeral threads are scratch space: persisting them would make a later
    // `resumeThread` succeed on a session the caller asked not to keep.
    if (!thread.ephemeral) await this.#persist(thread);
    return thread.id;
  }

  async resumeThread(threadId: string, options: StartThreadOptions): Promise<string> {
    await this.start();
    const existing = this.#threads.get(threadId) ?? await this.#load(threadId);
    if (!existing) {
      // Never fabricate a resumed session: a missing transcript is an error the
      // host must see, otherwise "remember the last run" silently becomes a lie.
      throw new Error(`Thread ${threadId} has no stored transcript and cannot be resumed`);
    }
    const thread: ThreadState = {
      ...existing,
      cwd: options.cwd,
      ephemeral: options.ephemeral ?? existing.ephemeral,
      model: options.model ?? existing.model,
      developerInstructions: options.developerInstructions ?? existing.developerInstructions,
    };
    this.#threads.set(threadId, thread);
    return threadId;
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    await this.start();
    const thread = this.#requireThread(options.threadId);
    const turnId = `turn_${randomUUID()}`;
    const turn: ActiveTurn = {
      threadId: thread.id,
      turnId,
      controller: new AbortController(),
      text: '',
      settled: false,
      result: null,
    };
    this.#turns.set(turnId, turn);

    // Drive the loop asynchronously and report exclusively through
    // `notification` events, matching what GameHarness listens for.
    void this.#runTurnLoop(thread, turn, options).catch((error) => {
      this.#complete(turn, 'failed', asMessage(error));
    });

    return turnId;
  }

  async runTurn(options: StartTurnOptions): Promise<TurnResult> {
    // Register the listener before starting so a fast transport cannot finish
    // the turn before anyone is listening.
    const turnId = await this.startTurn(options);
    return this.#waitForTurn(turnId);
  }

  async interruptTurn(_threadId: string, turnId: string): Promise<void> {
    const turn = this.#turns.get(turnId);
    if (!turn) return;
    turn.controller.abort();
    this.#complete(turn, 'interrupted', turn.text);
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    const thread = this.#threads.get(threadId);
    if (!thread) return;
    if (thread.ephemeral) {
      this.#threads.delete(threadId);
      return;
    }
    await this.#persist(thread);
    this.#threads.delete(threadId);
  }

  respondToServerRequest(): void {
    // This runtime has no server-request channel: host tools are dispatched
    // inline by the loop below. Present for interface compatibility only.
  }

  rejectServerRequest(): void {}

  async listSkills(): Promise<AgentSkillSummary[]> {
    // Skills are injected as prompt text rather than discovered by the runtime.
    return [];
  }

  async setSkillEnabled(): Promise<boolean> {
    return false;
  }

  async listMcpServerStatuses(): Promise<AgentMcpServerStatus[]> {
    return [];
  }

  async readConfig(): Promise<Record<string, unknown>> {
    return {};
  }

  async writeConfigValue(): Promise<void> {}

  async reloadMcpServers(): Promise<void> {}

  async dispose(): Promise<void> {
    await this.stop();
  }

  // -------------------------------------------------------------------------
  // Turn loop
  // -------------------------------------------------------------------------

  async #runTurnLoop(thread: ThreadState, turn: ActiveTurn, options: StartTurnOptions): Promise<void> {
    const timeout = setTimeout(() => {
      turn.controller.abort();
      this.#complete(turn, 'failed', `turn timed out after ${TURN_TIMEOUT_MS}ms`);
    }, TURN_TIMEOUT_MS);
    timeout.unref?.();

    try {
      const tools = this.#toolsFor(thread.cwd);
      const hostTools = this.#options.buildHostTools?.({ cwd: thread.cwd }) ?? [];
      const toolSpecs = [...WORKSPACE_TOOL_SPECS, ...flattenDynamicTools(hostTools)];

      thread.messages.push({ role: 'user', content: options.prompt });
      const maxSteps = this.#options.maxStepsPerTurn ?? DEFAULT_MAX_STEPS;

      for (let step = 1; step <= maxSteps; step += 1) {
        if (turn.controller.signal.aborted) return;

        const request: ChatCompletionRequest = {
          model: options.model ?? this.model,
          messages: this.#buildMessages(thread, options),
          tools: toolSpecs,
          temperature: this.#options.temperature ?? 0,
        };
        const response = await this.#transport.complete(request, turn.controller.signal);
        const message = response.choices[0]?.message;
        if (!message) throw new Error('Provider returned no message');

        const calls = message.tool_calls ?? [];
        thread.messages.push({
          role: 'assistant',
          content: message.content ?? null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });

        if (message.content) this.#emitDelta(turn, message.content);

        if (calls.length === 0) {
          this.#complete(turn, 'completed', turn.text);
          return;
        }

        for (const call of calls) {
          if (turn.controller.signal.aborted) return;
          const result = await this.#executeToolCall(toolSpecs, tools, thread, turn, call);
          thread.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result,
          });
        }
      }

      this.#complete(
        turn,
        'failed',
        `Agent exceeded ${maxSteps} tool steps without finishing. `
        + 'The task was left incomplete; the host will treat it as a failed turn.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async #executeToolCall(
    toolSpecs: ChatCompletionRequest['tools'],
    tools: WorkspaceTools,
    thread: ThreadState,
    turn: ActiveTurn,
    call: ChatToolCall,
  ): Promise<string> {
    const name = call.function?.name ?? '';
    let args: Record<string, unknown>;
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {};
    } catch {
      return `ERROR invalid JSON arguments for ${name}: ${call.function?.arguments ?? ''}`;
    }

    const isHostTool = (toolSpecs ?? []).some(
      (spec) => (spec as { function?: { name?: string } }).function?.name === name,
    ) && !WORKSPACE_TOOL_SPECS.some((spec) => spec.function.name === name);

    try {
      if (isHostTool && this.#options.executeHostTool) {
        const result = await this.#options.executeHostTool(name, args, {
          cwd: thread.cwd,
          threadId: thread.id,
          turnId: turn.turnId,
        });
        return result.content;
      }
      const result = await executeWorkspaceTool(tools, name, args);
      return result.content;
    } catch (error) {
      return `ERROR ${asMessage(error)}`;
    }
  }

  #buildMessages(thread: ThreadState, options: StartTurnOptions): ChatMessage[] {
    const system = [
      thread.developerInstructions,
      ...(options.skills ?? []).map((skill) => `# Skill: ${skill.name}\nLoaded from ${skill.path}.`),
      [
        'You operate inside a project workspace through tools only.',
        'Never invent file contents: read a file before you modify it.',
        'Prefer edit_file over write_file so unrelated code is preserved.',
        'When the task is complete, reply with a short summary and no tool calls.',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');

    const history = this.#trimHistory([
      { role: 'system', content: system },
      ...thread.messages,
    ]);

    return history;
  }

  /**
   * Keep the system message plus the most recent exchanges, replacing dropped
   * history with a marker so the model knows context was elided rather than
   * silently believing it saw everything.
   */
  #trimHistory(messages: ChatMessage[]): ChatMessage[] {
    const limit = this.#options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
    const size = (list: ChatMessage[]): number =>
      list.reduce((total, message) => total + (message.content?.length ?? 0)
        + (message.tool_calls?.reduce((sum, call) => sum + call.function.arguments.length, 0) ?? 0), 0);
    if (size(messages) <= limit) return messages;

    const [system, ...rest] = messages;
    const kept: ChatMessage[] = [];
    let total = system ? (system.content?.length ?? 0) : 0;
    for (let index = rest.length - 1; index >= 0; index -= 1) {
      const message = rest[index]!;
      const cost = (message.content?.length ?? 0)
        + (message.tool_calls?.reduce((sum, call) => sum + call.function.arguments.length, 0) ?? 0);
      if (total + cost > limit && kept.length > 0) break;
      kept.unshift(message);
      total += cost;
    }
    const dropped = rest.length - kept.length;
    const marker: ChatMessage = {
      role: 'user',
      content: `[host] ${dropped} earlier message(s) were elided to fit the context window. `
        + 'Re-read any file you are unsure about before editing it.',
    };
    return system ? [system, marker, ...kept] : [marker, ...kept];
  }

  // -------------------------------------------------------------------------
  // Turn plumbing
  // -------------------------------------------------------------------------

  #emitDelta(turn: ActiveTurn, delta: string): void {
    turn.text += delta;
    this.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId: turn.threadId, turnId: turn.turnId, delta },
    } satisfies AgentNotification);
  }

  #complete(turn: ActiveTurn, status: string, text: string): void {
    if (turn.settled) return;
    turn.settled = true;
    const result: TurnResult = {
      turnId: turn.turnId,
      status,
      text,
      raw: { threadId: turn.threadId, turnId: turn.turnId, turn: { id: turn.turnId, status } },
    };
    turn.result = result;
    this.#finished.set(turn.turnId, result);
    this.#turns.delete(turn.turnId);
    const thread = this.#threads.get(turn.threadId);
    if (thread) {
      thread.messages.push({ role: 'assistant', content: text || null });
      if (!thread.ephemeral) void this.#persist(thread).catch(() => undefined);
    }
    this.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        turn: { id: turn.turnId, status },
      },
    } satisfies AgentNotification);
    // Bound retention so a long session does not grow without limit.
    if (this.#finished.size > 64) {
      const oldest = this.#finished.keys().next().value;
      if (oldest) this.#finished.delete(oldest);
    }
  }

  async #waitForTurn(turnId: string): Promise<TurnResult> {
    const finished = this.#finished.get(turnId);
    if (finished) return finished;
    if (!this.#turns.has(turnId)) throw new Error(`Turn ${turnId} is not active`);

    return new Promise<TurnResult>((resolvePromise) => {
      const listener = (notification: AgentNotification): void => {
        const params = notification.params as Record<string, unknown> | undefined;
        if (params?.turnId !== turnId) return;
        if (notification.method !== 'turn/completed') return;
        this.removeListener('notification', listener);
        resolvePromise(this.#finished.get(turnId) ?? {
          turnId,
          status: (params.turn as { status?: string } | undefined)?.status ?? 'completed',
          text: '',
          raw: params,
        });
      };
      this.on('notification', listener);
    });
  }

  #requireThread(threadId: string): ThreadState {
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error(`Unknown thread ${threadId}`);
    return thread;
  }

  #toolsFor(cwd: string): WorkspaceTools {
    let tools = this.#toolsByRoot.get(cwd);
    if (!tools) {
      tools = new WorkspaceTools({
        root: cwd,
        readonlyPaths: this.#options.readonlyPaths ?? ['AGENTS.md', '.noobi', '.codex', 'GAME_DESIGN.md'],
      });
      this.#toolsByRoot.set(cwd, tools);
    }
    return tools;
  }

  #modelOption(): ModelOption {
    const model = this.model;
    return {
      id: model,
      model,
      displayName: model,
      description: 'API-key provider',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: ['low', 'medium', 'high'],
    };
  }

  // -------------------------------------------------------------------------
  // Transcript persistence (replaces Codex's built-in thread storage)
  // -------------------------------------------------------------------------

  #transcriptPath(threadId: string): string {
    return join(this.#options.threadStoreDir, `${threadId.replace(/[^a-zA-Z0-9_-]/gu, '_')}.json`);
  }

  async #persist(thread: ThreadState): Promise<void> {
    await mkdir(this.#options.threadStoreDir, { recursive: true, mode: 0o700 });
    await writeFile(this.#transcriptPath(thread.id), JSON.stringify(thread), { mode: 0o600 });
  }

  async #load(threadId: string): Promise<ThreadState | null> {
    const raw = await readFile(this.#transcriptPath(threadId), 'utf8').catch(() => null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ThreadState;
      if (!parsed?.id || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function fetchTransport(options: { baseUrl: string; apiKey: string }): ChatTransport {
  return {
    async complete(request, signal) {
      const response = await fetch(`${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          ...request,
          tool_choice: request.tools?.length ? 'auto' : undefined,
        }),
        signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Provider HTTP ${response.status}: ${body.slice(0, 400)}`);
      }
      return await response.json() as ChatCompletionResponse;
    },
  };
}

/**
 * Flatten a host tool spec into an OpenAI-compatible function tool.
 *
 * Namespaced specs are expanded by the caller; a bare namespace has no callable
 * argument schema, so it degrades to a no-argument function rather than
 * silently claiming parameters it does not have.
 */
function toChatToolSpec(spec: DynamicToolSpec): unknown {
  if (spec.type === 'function') {
    return {
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema,
      },
    };
  }
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: { type: 'object', properties: {} },
    },
  };
}

/** Expand namespaced dynamic tools into flat function specs for chat APIs. */
export function flattenDynamicTools(specs: DynamicToolSpec[]): unknown[] {
  return specs.flatMap((spec) => (spec.type === 'function'
    ? [toChatToolSpec(spec)]
    : spec.tools.map((tool) => toChatToolSpec(tool))));
}

function emptyRuntimeStatus(): RuntimeStatus {
  return {
    state: 'stopped',
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
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exported for tests. */
export const __testing = { toChatToolSpec, emptyRuntimeStatus };
export type { JsonValue };
