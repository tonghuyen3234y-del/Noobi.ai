import type { EventEmitter } from 'node:events';
import type {
  LoginStartResult,
  ModelOption,
  RuntimeAccount,
  RuntimeCapabilities,
  RuntimeStatus,
} from '../shared/contracts.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface DynamicToolFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
}

export interface DynamicToolNamespaceSpec {
  type: 'namespace';
  name: string;
  description: string;
  tools: DynamicToolFunctionSpec[];
}

export type DynamicToolSpec = DynamicToolFunctionSpec | DynamicToolNamespaceSpec;

export interface AgentSkillSummary {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin' | string;
  enabled: boolean;
  cwd: string;
}

export interface AgentMcpServerStatus {
  name: string;
  authStatus: string;
  connected: boolean;
  toolCount: number;
}

export interface TurnResult {
  turnId: string;
  status: string;
  text: string;
  raw: unknown;
}

export interface StartThreadOptions {
  cwd: string;
  model?: string | null;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  developerInstructions?: string;
  ephemeral?: boolean;
  dynamicTools?: DynamicToolSpec[];
}

export interface StartTurnOptions {
  threadId: string;
  prompt: string;
  cwd?: string;
  model?: string | null;
  effort?: string | null;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  skills?: Array<{ name: string; path: string }>;
  /** Host-side completion deadline; never sent to App Server. */
  timeoutMs?: number;
}

/** Runtime notification in the shape consumers already parse. */
export interface AgentNotification {
  method: string;
  params?: unknown;
}

/** Server-originated request (approvals, dynamic tool calls) awaiting a host reply. */
export interface AgentServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface AgentRuntimeEvents {
  status: (status: RuntimeStatus) => void;
  notification: (notification: AgentNotification) => void;
  serverRequest: (request: AgentServerRequest) => void;
  diagnostic: (message: string) => void;
}

/**
 * Provider-neutral agent runtime.
 *
 * `CodexAppServer` is one implementation (Codex native binary over JSON-RPC).
 * A future `DeepSeekRuntime` is another (HTTP + host-side tool loop). Consumers
 * such as `GameHarness` must depend on this interface only, never on the
 * concrete transport.
 */
export interface AgentRuntime {
  on<E extends keyof AgentRuntimeEvents>(event: E, listener: AgentRuntimeEvents[E]): this;
  once<E extends keyof AgentRuntimeEvents>(event: E, listener: AgentRuntimeEvents[E]): this;
  removeListener<E extends keyof AgentRuntimeEvents>(event: E, listener: AgentRuntimeEvents[E]): this;
  emit<E extends keyof AgentRuntimeEvents>(
    event: E,
    ...args: Parameters<AgentRuntimeEvents[E]>
  ): boolean;

  readonly status: RuntimeStatus;

  start(): Promise<RuntimeStatus>;
  refresh(): Promise<RuntimeStatus>;
  stop(): Promise<void>;

  readAccount(): Promise<RuntimeAccount | null>;
  listModels(): Promise<ModelOption[]>;
  readModelProviderCapabilities(): Promise<RuntimeCapabilities>;
  startLogin(): Promise<LoginStartResult>;
  logout(): Promise<RuntimeStatus>;

  startThread(options: StartThreadOptions): Promise<string>;
  resumeThread(threadId: string, options: StartThreadOptions): Promise<string>;
  startTurn(options: StartTurnOptions): Promise<string>;
  runTurn(options: StartTurnOptions): Promise<TurnResult>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  unsubscribeThread(threadId: string): Promise<void>;

  respondToServerRequest(requestId: string | number, result: unknown): void;
  rejectServerRequest(requestId: string | number, code: number, message: string): void;

  listSkills(options?: { cwds?: string[]; forceReload?: boolean }): Promise<AgentSkillSummary[]>;
  setSkillEnabled(selector: { path?: string; name?: string }, enabled: boolean): Promise<boolean>;
  listMcpServerStatuses(): Promise<AgentMcpServerStatus[]>;
  readConfig(): Promise<Record<string, unknown>>;
  writeConfigValue(keyPath: string, value: JsonValue): Promise<void>;
  reloadMcpServers(): Promise<void>;
}

/**
 * Capabilities a provider may legitimately lack.
 *
 * Consumers must branch on these instead of probing transport details, so a
 * runtime without (for example) Codex ImageGen degrades explicitly rather than
 * silently pretending the feature exists.
 */
export interface AgentRuntimeFeatureSet {
  /** Provider can author a new thread and drive host-declared dynamic tools. */
  dynamicTools: boolean;
  /** Provider can resume a previously persisted thread across processes. */
  threadResume: boolean;
  /** Provider exposes an in-model image generation fallback (Codex ImageGen). */
  builtInImageGeneration: boolean;
  /** Provider exposes skill toggling through a native config API. */
  nativeSkills: boolean;
  /** Provider exposes MCP config read/write and reload. */
  nativeMcp: boolean;
  /** Provider supports interactive account login. */
  interactiveLogin: boolean;
}

export const CODEX_RUNTIME_FEATURES: AgentRuntimeFeatureSet = {
  dynamicTools: true,
  threadResume: true,
  builtInImageGeneration: true,
  nativeSkills: true,
  nativeMcp: true,
  interactiveLogin: true,
};

/** Type guard for structured-clone-safe event emitters. */
export type EmitterLike = Pick<EventEmitter, 'on' | 'once' | 'removeListener' | 'emit'>;
