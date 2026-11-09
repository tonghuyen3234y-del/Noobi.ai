import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { locateCodexBinary, readCodexVersion } from './codexLocator.js';
import {
  JsonRpcPeer,
  type JsonRpcServerRequest,
} from './jsonRpcPeer.js';
import type {
  LoginStartResult,
  ModelOption,
  RuntimeAccount,
  RuntimeCapabilities,
  RuntimeStatus,
} from '../shared/contracts.js';
import type {
  AgentMcpServerStatus,
  AgentRuntime,
  AgentSkillSummary,
  DynamicToolFunctionSpec,
  DynamicToolNamespaceSpec,
  DynamicToolSpec,
  JsonValue,
  StartThreadOptions,
  StartTurnOptions,
  TurnResult,
} from './agentRuntime.js';

// Re-exported for existing consumers; the canonical definitions live in agentRuntime.ts.
export type {
  DynamicToolFunctionSpec,
  DynamicToolNamespaceSpec,
  DynamicToolSpec,
  JsonValue,
  StartThreadOptions,
  StartTurnOptions,
  TurnResult,
};

export type CodexSkillSummary = AgentSkillSummary;
export type CodexMcpServerStatus = AgentMcpServerStatus;

interface SkillsListResponse {
  data: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      description: string;
      path: string;
      scope: string;
      enabled: boolean;
    }>;
  }>;
}

interface ListMcpServerStatusResponse {
  data: Array<{
    name: string;
    serverInfo: unknown | null;
    tools: Record<string, unknown>;
    authStatus: string;
  }>;
  nextCursor: string | null;
}

interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

interface AccountReadResponse {
  account: null | {
    type: string;
    email?: string | null;
    planType?: string | null;
  };
  requiresOpenaiAuth: boolean;
}

interface ModelListResponse {
  data: Array<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    isDefault: boolean;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  }>;
  nextCursor: string | null;
}

interface ModelProviderCapabilitiesResponse {
  namespaceTools: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
}

interface ThreadResponse {
  thread: { id: string };
  model: string;
}

interface TurnStartResponse {
  turn: { id: string; status: string };
}

interface EarlyTurnState {
  text: string;
  completed: TurnResult | null;
}

interface TurnWaiter {
  text: string;
  resolve(result: TurnResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerOptions {
  /** Optional app-owned Codex home. Omitted by CLI smoke tests to use the signed-in user runtime. */
  codexHome?: string;
  /**
   * Non-OpenAI model provider to register through `config.toml`.
   *
   * When set, the app-server is launched with this provider as the default
   * model, and the API key is passed through the named environment variable
   * rather than being written into the config file.
   */
  provider?: CodexProviderConfig;
}

export interface CodexProviderConfig {
  /** Key under `[model_providers.<id>]`. */
  id: string;
  /** Display name shown in Codex diagnostics. */
  name: string;
  /** API origin Codex talks to (may point at a local shim). */
  baseUrl: string;
  /** Environment variable Codex reads the bearer token from. */
  envKey: string;
  /** Concrete token injected into that variable for the child process. */
  apiKey: string;
  /** Model id Codex should request. */
  model: string;
  /**
   * Wire protocol. Codex 0.148 removed `chat`; anything other than the default
   * Responses transport must be shimmed by the host.
   */
  wireApi?: 'responses';
}

const TURN_TIMEOUT_MS = 20 * 60 * 1_000;
/** Upper bound for the app-server handshake during launch. */
const START_TIMEOUT_MS = 25_000;

export class CodexAppServer extends EventEmitter implements AgentRuntime {
  readonly #configuredCodexHome: string | null;
  readonly #provider: CodexProviderConfig | null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #peer: JsonRpcPeer | null = null;
  #startPromise: Promise<RuntimeStatus> | null = null;
  #runtime: RuntimeStatus = emptyRuntimeStatus();
  #turnWaiters = new Map<string, TurnWaiter>();
  #earlyTurnStates = new Map<string, EarlyTurnState>();
  #runTurnStartsInFlight = 0;
  #generation = 0;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    if (options.codexHome && !isAbsolute(options.codexHome)) {
      throw new Error('Codex home must be an absolute path');
    }
    this.#configuredCodexHome = options.codexHome ? resolve(options.codexHome) : null;
    this.#provider = options.provider ?? null;
  }

  get status(): RuntimeStatus {
    return structuredClone(this.#runtime);
  }

  /**
   * Report the runtime as unavailable without spawning Codex.
   *
   * Used when a provider is selected but cannot run yet (missing key): the
   * settings card needs a runtime whose status carries the real reason, rather
   * than a substitute runtime reporting another provider's health.
   */
  markUnavailable(reason: string): void {
    this.#runtime = {
      ...emptyRuntimeStatus(),
      state: 'error',
      error: reason,
    };
    this.emit('status', this.status);
  }

  /**
   * The model this provider is pinned to, when it is not OpenAI.
   *
   * A configured provider defines its own model in `config.toml`. Passing any
   * other name through a turn overrides it and the upstream rejects the request
   * outright (DashScope: "Model not exist"), so callers must not substitute a
   * model from the ChatGPT catalog.
   */
  get pinnedModel(): string | null {
    return this.#provider?.model ?? null;
  }

  async start(): Promise<RuntimeStatus> {
    if (this.#runtime.state === 'ready' && this.#peer) return this.status;
    if (this.#startPromise) return this.#startPromise;
    const generation = ++this.#generation;
    // Never let a wedged child block the caller forever: bootstrap awaits this.
    this.#startPromise = withTimeout(
      this.#start(generation),
      START_TIMEOUT_MS,
      new Error(`Codex App Server did not start within ${START_TIMEOUT_MS / 1_000}s`),
    );
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async refresh(): Promise<RuntimeStatus> {
    await this.start();
    // A pinned provider (Qwen) has no ChatGPT account. Asking for one makes
    // Codex contact the ChatGPT backend and, with no login, hang forever: that
    // stalled bootstrap and left the window on "connecting" with a blank page.
    const [account, models, capabilities] = await Promise.all([
      this.#provider ? Promise.resolve(null) : this.readAccount().catch(() => null),
      this.listModels().catch(() => []),
      this.readModelProviderCapabilities().catch(() => emptyRuntimeCapabilities()),
    ]);
    this.#runtime = {
      ...this.#runtime,
      account,
      models,
      capabilities,
      state: 'ready',
      error: null,
    };
    this.emit('status', this.status);
    return this.status;
  }

  async readModelProviderCapabilities(): Promise<RuntimeCapabilities> {
    const result = await this.#request<ModelProviderCapabilitiesResponse>(
      'modelProvider/capabilities/read',
      {},
    );
    return {
      namespaceTools: result.namespaceTools === true,
      // Codex can advertise its own ImageGen tool even when inference is routed
      // to a third-party model. Such providers need the host's image API.
      imageGeneration: !this.#provider && result.imageGeneration === true,
      externalImageGeneration: false,
      webSearch: result.webSearch === true,
    };
  }

  async readAccount(): Promise<RuntimeAccount | null> {
    const result = await this.#request<AccountReadResponse>('account/read', {
      refreshToken: false,
    });
    if (!result.account) return null;
    return {
      type: result.account.type,
      email: result.account.email ?? null,
      planType: result.account.planType ?? null,
    };
  }

  async listModels(): Promise<ModelOption[]> {
    // A pinned provider serves exactly one model. Codex's `model/list` always
    // returns the ChatGPT catalog regardless of provider, which showed Qwen
    // users a list of GPT models that the upstream rejects when selected.
    if (this.#provider) {
      return [{
        id: this.#provider.model,
        model: this.#provider.model,
        displayName: this.#provider.model,
        description: `${this.#provider.name}（当前引擎唯一可用模型）`,
        isDefault: true,
        defaultEffort: 'high',
        efforts: ['low', 'high', 'max'],
      }];
    }
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: ModelListResponse = await this.#request<ModelListResponse>('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      models.push(
        ...result.data.map((model) => ({
          id: model.id,
          model: model.model,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.isDefault,
          defaultEffort: model.defaultReasoningEffort,
          efforts: model.supportedReasoningEfforts.map((item) => item.reasoningEffort),
        })),
      );
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return models;
  }

  async listSkills(options: { cwds?: string[]; forceReload?: boolean } = {}): Promise<CodexSkillSummary[]> {
    await this.start();
    const result = await this.#request<SkillsListResponse>('skills/list', {
      ...(options.cwds?.length ? { cwds: options.cwds } : {}),
      forceReload: options.forceReload ?? false,
    });
    return result.data.flatMap((entry) => entry.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      scope: skill.scope,
      enabled: skill.enabled,
      cwd: entry.cwd,
    })));
  }

  async setSkillEnabled(selector: { path?: string; name?: string }, enabled: boolean): Promise<boolean> {
    await this.start();
    const result = await this.#request<{ effectiveEnabled: boolean }>('skills/config/write', {
      ...(selector.path ? { path: selector.path } : {}),
      ...(!selector.path && selector.name ? { name: selector.name } : {}),
      enabled,
    });
    return result.effectiveEnabled;
  }

  async listMcpServerStatuses(): Promise<CodexMcpServerStatus[]> {
    await this.start();
    const statuses: CodexMcpServerStatus[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result: ListMcpServerStatusResponse = await this.#request<ListMcpServerStatusResponse>('mcpServerStatus/list', {
        cursor,
        limit: 100,
        detail: 'toolsAndAuthOnly',
      });
      statuses.push(...result.data.map((server) => ({
        name: server.name,
        authStatus: server.authStatus,
        connected: server.serverInfo !== null,
        toolCount: Object.keys(server.tools ?? {}).length,
      })));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return statuses;
  }

  async readConfig(): Promise<Record<string, unknown>> {
    await this.start();
    const result = await this.#request<{ config: Record<string, unknown> }>('config/read', {
      includeLayers: false,
    });
    return structuredClone(result.config);
  }

  async writeConfigValue(keyPath: string, value: JsonValue): Promise<void> {
    await this.start();
    await this.#request<unknown>('config/value/write', {
      keyPath,
      value,
      mergeStrategy: 'replace',
    });
  }

  async reloadMcpServers(): Promise<void> {
    await this.start();
    await this.#request<unknown>('config/mcpServer/reload');
  }

  async startLogin(): Promise<LoginStartResult> {
    await this.start();
    return this.#request<LoginStartResult>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    });
  }

  async logout(): Promise<RuntimeStatus> {
    await this.start();
    await this.#request<Record<string, never>>('account/logout');
    return this.refresh();
  }

  async startThread(options: StartThreadOptions): Promise<string> {
    await this.start();
    const result = await this.#request<ThreadResponse>('thread/start', {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      sandbox: options.sandbox ?? 'workspace-write',
      approvalPolicy: options.approvalPolicy ?? 'on-request',
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
      experimentalRawEvents: false,
    });
    return result.thread.id;
  }

  async resumeThread(threadId: string, options: StartThreadOptions): Promise<string> {
    await this.start();
    const result = await this.#request<ThreadResponse>('thread/resume', {
      threadId,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      sandbox: options.sandbox ?? 'workspace-write',
      approvalPolicy: options.approvalPolicy ?? 'on-request',
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
      // Re-post the dynamic tool set on resume. A durable thread is reused
      // across runs, and without this the resumed turn had no host tools at
      // all: the Implementer never saw noobi_image_generate and every run
      // failed the image attestation after exhausting repairs.
      ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
      excludeTurns: true,
    });
    return result.thread.id;
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    await this.start();
    const result = await this.#request<TurnStartResponse>('turn/start', {
      threadId: options.threadId,
      input: [
        { type: 'text', text: options.prompt, text_elements: [] },
        ...(options.skills ?? []).map((skill) => ({
          type: 'skill' as const,
          name: skill.name,
          path: skill.path,
        })),
      ],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    });
    return result.turn.id;
  }

  async runTurn(options: StartTurnOptions): Promise<TurnResult> {
    this.#runTurnStartsInFlight += 1;
    let turnId: string;
    try {
      turnId = await this.startTurn(options);
    } catch (error) {
      this.#releaseRunTurnStart();
      throw error;
    }

    const early = this.#earlyTurnStates.get(turnId);
    this.#earlyTurnStates.delete(turnId);
    if (early?.completed) {
      this.#releaseRunTurnStart();
      return early.completed;
    }

    return new Promise<TurnResult>((resolve, reject) => {
      const timeoutMs = options.timeoutMs === undefined
        ? TURN_TIMEOUT_MS
        : Math.min(TURN_TIMEOUT_MS, Math.max(1_000, Math.trunc(options.timeoutMs)));
      const timer = setTimeout(() => {
        this.#turnWaiters.delete(turnId);
        void this.interruptTurn(options.threadId, turnId).catch(() => undefined);
        reject(new Error(`Codex turn ${turnId} timed out`));
      }, timeoutMs);
      timer.unref();
      this.#turnWaiters.set(turnId, { text: early?.text ?? '', resolve, reject, timer });
      this.#releaseRunTurnStart();
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#request<Record<string, never>>('turn/interrupt', { threadId, turnId });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.#request<{ status: string }>('thread/unsubscribe', { threadId });
  }

  respondToServerRequest(requestId: string | number, result: unknown): void {
    if (!this.#peer) throw new Error('Codex App Server is not running');
    this.#peer.respond(requestId, result);
  }

  rejectServerRequest(requestId: string | number, code: number, message: string): void {
    if (!this.#peer) throw new Error('Codex App Server is not running');
    this.#peer.respondError(requestId, { code, message });
  }

  async stop(): Promise<void> {
    this.#generation += 1;
    const child = this.#child;
    const peer = this.#peer;
    this.#child = null;
    this.#peer = null;
    for (const waiter of this.#turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Codex App Server stopped during the turn'));
    }
    this.#turnWaiters.clear();
    this.#earlyTurnStates.clear();
    this.#runTurnStartsInFlight = 0;
    if (child && child.exitCode === null) {
      peer?.endOutput();
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
      ]);
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => child.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    peer?.close(new Error('Codex App Server stopped'));
    this.#runtime = emptyRuntimeStatus();
    this.emit('status', this.status);
  }

  async #start(generation: number): Promise<RuntimeStatus> {
    this.#runtime = { ...emptyRuntimeStatus(), state: 'starting' };
    this.emit('status', this.status);
    let child: ChildProcessWithoutNullStreams | null = null;
    let peer: JsonRpcPeer | null = null;
    try {
      if (this.#configuredCodexHome) {
        await mkdir(this.#configuredCodexHome, { recursive: true, mode: 0o700 });
      }
      const binaryPath = await locateCodexBinary();
      this.#assertGeneration(generation);
      const version = readCodexVersion(binaryPath);
      this.#assertGeneration(generation);
      // Register a non-OpenAI provider before launch: Codex refuses to start with
      // --strict-config when the configured provider is unknown.
      if (this.#provider && this.#configuredCodexHome) {
        await writeProviderConfig(this.#configuredCodexHome, this.#provider);
      }
      child = spawn(binaryPath, ['app-server', '--listen', 'stdio://', '--strict-config'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RUST_LOG: process.env.RUST_LOG ?? 'warn',
          LOG_FORMAT: 'json',
          ...(this.#configuredCodexHome ? { CODEX_HOME: this.#configuredCodexHome } : {}),
          // The key travels only through the environment, never through disk
          // config or the command line.
          ...(this.#provider ? { [this.#provider.envKey]: this.#provider.apiKey } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.#child = child;
      peer = new JsonRpcPeer(child.stdout, child.stdin);
      this.#peer = peer;
      peer.on('notification', (notification) => this.#handleNotification(notification));
      peer.on('serverRequest', (request: JsonRpcServerRequest) => this.emit('serverRequest', request));
      peer.on('protocolError', (error) => this.emit('diagnostic', asError(error).message));
      peer.once('closed', (error) => {
        if (this.#peer !== peer || this.#child !== child) return;
        if (child?.exitCode === null) child.kill('SIGTERM');
        this.#handleExit(child!, asError(error));
      });
      peer.start();
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/u).filter(Boolean)) {
          this.emit('diagnostic', sanitizeDiagnostic(line));
        }
      });
      child.once('error', (error) => this.#handleExit(child!, error));
      child.once('exit', (code, signal) => {
        this.#handleExit(
          child!,
          new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`),
        );
      });

      const initialized = await peer.request<InitializeResponse>('initialize', {
        clientInfo: {
          name: 'noobi_ai',
          title: 'XiuPlay.ai Game Agent',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.#assertGeneration(generation);
      peer.notify('initialized');
      this.#runtime = {
        state: 'ready',
        binaryPath,
        version,
        codexHome: initialized.codexHome,
        account: null,
        models: [],
        capabilities: emptyRuntimeCapabilities(),
        error: null,
      };
      return await this.refresh();
    } catch (error) {
      const message = asError(error).message;
      peer?.close(asError(error));
      if (this.#peer === peer) this.#peer = null;
      if (this.#child === child) this.#child = null;
      if (child && child.exitCode === null) child.kill('SIGTERM');
      if (generation === this.#generation) {
        this.#runtime = { ...this.#runtime, state: 'error', error: message };
        this.emit('status', this.status);
      }
      throw error;
    }
  }

  #request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.#peer) throw new Error('Codex App Server is not running');
    return this.#peer.request<T>(method, params);
  }

  #handleNotification(notification: { method: string; params?: unknown }): void {
    const params = asRecord(notification.params);
    const turnId = readString(params?.turnId) ?? readString(asRecord(params?.turn)?.id);
    if (turnId) {
      const waiter = this.#turnWaiters.get(turnId);
      if (waiter && notification.method === 'item/agentMessage/delta') {
        waiter.text += readString(params?.delta) ?? '';
      }
      if (waiter && notification.method === 'item/completed') {
        const item = asRecord(params?.item);
        if (item?.type === 'agentMessage' && typeof item.text === 'string') {
          waiter.text = item.text;
        }
      }
      if (waiter && notification.method === 'turn/completed') {
        clearTimeout(waiter.timer);
        this.#turnWaiters.delete(turnId);
        const turn = asRecord(params?.turn);
        waiter.resolve({
          turnId,
          status: readString(turn?.status) ?? 'completed',
          text: waiter.text,
          raw: params,
        });
      }
      if (!waiter && this.#runTurnStartsInFlight > 0) {
        const early = this.#earlyTurnStates.get(turnId) ?? { text: '', completed: null };
        if (notification.method === 'item/agentMessage/delta') {
          early.text += readString(params?.delta) ?? '';
        }
        if (notification.method === 'item/completed') {
          const item = asRecord(params?.item);
          if (item?.type === 'agentMessage' && typeof item.text === 'string') {
            early.text = item.text;
          }
        }
        if (notification.method === 'turn/completed') {
          const turn = asRecord(params?.turn);
          early.completed = {
            turnId,
            status: readString(turn?.status) ?? 'completed',
            text: early.text,
            raw: params,
          };
        }
        this.#earlyTurnStates.set(turnId, early);
      }
    }

    if (notification.method === 'account/updated' || notification.method === 'account/login/completed') {
      void this.refresh().catch((error) => this.emit('diagnostic', asError(error).message));
    }
    this.emit('notification', notification);
  }

  #handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child) return;
    this.#peer?.close(error);
    this.#peer = null;
    this.#child = null;
    this.#runtime = { ...this.#runtime, state: 'error', error: error.message };
    for (const waiter of this.#turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#turnWaiters.clear();
    this.#earlyTurnStates.clear();
    this.#runTurnStartsInFlight = 0;
    this.emit('status', this.status);
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#generation) throw new Error('Codex App Server start was cancelled');
  }

  #releaseRunTurnStart(): void {
    this.#runTurnStartsInFlight = Math.max(0, this.#runTurnStartsInFlight - 1);
    if (this.#runTurnStartsInFlight === 0) this.#earlyTurnStates.clear();
  }
}

function emptyRuntimeStatus(): RuntimeStatus {
  return {
    state: 'stopped',
    binaryPath: null,
    version: null,
    codexHome: null,
    account: null,
    models: [],
    capabilities: emptyRuntimeCapabilities(),
    error: null,
  };
}

function emptyRuntimeCapabilities(): RuntimeCapabilities {
  return {
    namespaceTools: false,
    imageGeneration: false,
    externalImageGeneration: false,
    webSearch: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]')
    .slice(0, 4_000);
}

/**
 * Write `config.toml` describing a non-OpenAI provider.
 *
 * The API key is deliberately absent: Codex reads it from the environment
 * variable named by `env_key`, so the secret never lands on disk.
 */
async function writeProviderConfig(home: string, provider: CodexProviderConfig): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const catalogPath = provider.id === 'qwen' ? join(home, 'xiuplay-model-catalog.json') : null;
  if (catalogPath) {
    const { buildQwenModelCatalog } = await import('./codexProviderCatalog.js');
    await writeFile(catalogPath, JSON.stringify(buildQwenModelCatalog(provider.model)), { encoding: 'utf8', mode: 0o600 });
  }
  const toml = [
    '# Generated by XiuPlay.ai. Rewritten on every launch.',
    `model = ${tomlString(provider.model)}`,
    `model_provider = ${tomlString(provider.id)}`,
    ...(catalogPath ? [`model_catalog_json = ${tomlString(catalogPath)}`] : []),
    '',
    `[model_providers.${provider.id}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
    `env_key = ${tomlString(provider.envKey)}`,
    `wire_api = ${tomlString(provider.wireApi ?? 'responses')}`,
    // The adapter already bounds individual requests. Layering the native
    // default HTTP and stream retries can hide that timeout for many minutes.
    ...(provider.id === 'qwen' ? ['request_max_retries = 0', 'stream_max_retries = 0'] : []),
    '',
    ...(provider.id === 'qwen' ? ['[features]', 'unbounded_connection_retries = false', ''] : []),
  ].join('\n');
  await writeFile(join(home, 'config.toml'), toml, { encoding: 'utf8', mode: 0o600 });
}

/** Minimal TOML string encoder; provider ids and URLs contain no escapes. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/** Reject a promise that outlives its deadline. */
function withTimeout<T>(promise: Promise<T>, ms: number, error: Error): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(error), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (reason) => { clearTimeout(timer); reject(reason); },
    );
  });
}
