import { createServer, type Server } from 'node:http';

/**
 * Responses-API shim for DashScope (Alibaba Bailian / Qwen).
 *
 * Codex App Server speaks the OpenAI Responses protocol and refuses
 * `wire_api = "chat"`. DashScope exposes a `/responses` endpoint, but its own
 * converter rewrites `function_call_output` into `role: "tool"` and then
 * rejects that role:
 *
 *   role Value error, tool must be one of user,assistant,system,function
 *
 * The result is that the first tool call succeeds and every follow-up request
 * fails with HTTP 400, which makes multi-step work impossible.
 *
 * This shim sits between Codex and DashScope: it translates the Responses
 * payload into a plain chat-completions request (DashScope's reliable surface),
 * then rebuilds a Responses-shaped reply — including the SSE event sequence —
 * so Codex cannot tell the difference.
 */

export interface ShimOptions {
  /** Upstream API origin, e.g. https://dashscope.aliyuncs.com */
  upstream: string;
  /** Port to listen on. Defaults to an ephemeral port. */
  port?: number;
  /** Log each translation; for diagnostics only, never logs prompt content. */
  debug?: boolean;
  /** Test hook: overrides global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RunningShim {
  /** Base URL to hand to Codex as the provider `base_url`. */
  baseUrl: string;
  port: number;
  close(): Promise<void>;
}

interface Body {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: unknown;
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface ChatResult {
  choices?: Array<{ message?: ChatMessage }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Start the shim and return the URL to configure as Codex's provider base.
 *
 * The listen port is requested as 0 by default so the OS picks a free one; the
 * app never hard-codes 8xxx ports that another process might already hold.
 */
export async function startQwenResponsesShim(options: ShimOptions): Promise<RunningShim> {
  const upstream = options.upstream.replace(/\/+$/u, '');
  const doFetch = options.fetchImpl ?? fetch;
  let sequence = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: asMessage(error) } }));
    });
  });

  async function handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const authorization = readAuthorization(req.headers.authorization);

    if (!req.url?.includes('/responses')) {
      // Everything else (models, discovery) passes through untouched.
      const upstreamResponse = await doFetch(`${upstream}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers: { 'content-type': 'application/json', authorization },
        ...(raw ? { body: raw } : {}),
      });
      res.writeHead(upstreamResponse.status, { 'content-type': 'application/json' });
      res.end(await upstreamResponse.text());
      return;
    }

    let body: Body;
    try {
      body = JSON.parse(raw) as Body;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'shim: invalid JSON body' } }));
      return;
    }

    const model = body.model ?? 'qwen-plus';
    const payload: Record<string, unknown> = {
      model,
      messages: toChatMessages(body),
      stream: false,
    };
    const tools = toChatTools(body.tools);
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    if (typeof body.temperature === 'number') payload.temperature = body.temperature;
    if (typeof body.max_output_tokens === 'number') payload.max_tokens = body.max_output_tokens;

    if (options.debug) {
      process.stderr.write(
        `[qwen-shim] -> chat model=${model} msgs=${(payload.messages as unknown[]).length}`
        + ` tools=${tools?.length ?? 0}\n`,
      );
    }

    const upstreamResponse = await doFetch(`${upstream}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(payload),
    });
    const text = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      // Surface the provider's own message so the UI can show the real reason.
      res.writeHead(upstreamResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: text.slice(0, 500) } }));
      return;
    }

    let chat: ChatResult;
    try {
      chat = JSON.parse(text) as ChatResult;
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'shim: upstream returned non-JSON' } }));
      return;
    }

    const response = toResponsesObject(chat, model, () => (sequence += 1));
    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(toSseStream(response));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  }

  const port = await new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () => closeServer(server),
  };
}

/** Responses `input[]` (plus `instructions`) -> chat `messages[]`. */
export function toChatMessages(body: Body): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : [];

  for (const item of input) {
    const record = asRecord(item);
    if (!record) continue;
    switch (record.type) {
      case 'message': {
        const text = collectText(record.content);
        if (!text) break;
        // Codex sends developer instructions as `developer`; chat APIs only
        // understand `system`.
        const role = record.role === 'developer' ? 'system' : record.role;
        if (role === 'system' || role === 'user' || role === 'assistant') {
          messages.push({ role, content: text });
        }
        break;
      }
      case 'function_call':
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: readString(record.call_id) ?? readString(record.id) ?? 'call_0',
            type: 'function',
            function: {
              name: readString(record.name) ?? '',
              arguments: readString(record.arguments) ?? '{}',
            },
          }],
        });
        break;
      case 'function_call_output':
        messages.push({
          role: 'tool',
          tool_call_id: readString(record.call_id) ?? '',
          content: typeof record.output === 'string'
            ? record.output
            : JSON.stringify(record.output ?? ''),
        });
        break;
      default:
        break;
    }
  }
  return messages;
}

/** Responses `tools[]` -> chat `tools[]`. */
export function toChatTools(tools: unknown): unknown[] | null {
  if (!Array.isArray(tools)) return null;
  const converted = tools.flatMap((tool) => {
    const record = asRecord(tool);
    if (!record || record.type !== 'function') return [];
    const name = readString(record.name);
    if (!name) return [];
    return [{
      type: 'function',
      function: {
        name,
        description: readString(record.description) ?? '',
        parameters: record.parameters ?? { type: 'object', properties: {} },
      },
    }];
  });
  return converted.length > 0 ? converted : null;
}

/** Chat completion -> Responses object. */
export function toResponsesObject(
  chat: ChatResult,
  model: string,
  nextSequence: () => number,
): Record<string, unknown> {
  const message = chat.choices?.[0]?.message ?? { role: 'assistant', content: null };
  const output: Array<Record<string, unknown>> = [];

  if (message.content) {
    output.push({
      type: 'message',
      id: `msg_${nextSequence()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }
  for (const call of message.tool_calls ?? []) {
    output.push({
      type: 'function_call',
      id: `fc_${nextSequence()}`,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed',
    });
  }

  return {
    id: `resp_${nextSequence()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1_000),
    status: 'completed',
    model,
    output,
    usage: {
      input_tokens: chat.usage?.prompt_tokens ?? 0,
      output_tokens: chat.usage?.completion_tokens ?? 0,
      total_tokens: chat.usage?.total_tokens ?? 0,
    },
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  };
}

/**
 * Build the SSE event sequence Codex consumes.
 *
 * Emitting text as deltas (rather than only a final blob) keeps the workbench
 * streaming the same way it does against the real provider.
 */
export function toSseStream(response: Record<string, unknown>): string {
  const output = (response.output as Array<Record<string, unknown>>) ?? [];
  const events: string[] = [];
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const inProgress = { ...response, output: [], status: 'in_progress' };
  push('response.created', { response: inProgress });
  push('response.in_progress', { response: inProgress });

  output.forEach((item, index) => {
    push('response.output_item.added', {
      output_index: index,
      item: { ...item, status: 'in_progress' },
    });
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part.type !== 'output_text') continue;
        push('response.output_text.delta', {
          item_id: item.id,
          output_index: index,
          content_index: 0,
          delta: String(part.text ?? ''),
        });
      }
    }
    push('response.output_item.done', { output_index: index, item });
  });

  push('response.completed', { response });
  return events.join('');
}

function collectText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : readString(asRecord(part)?.text) ?? ''))
    .join('');
}

function readAuthorization(value: string | undefined): string {
  return typeof value === 'string' && value.startsWith('Bearer ') ? value : '';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}
