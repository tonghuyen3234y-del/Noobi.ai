// Native Codex + local fake upstream: no paid calls and no real API keys.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from '../src/main/codexAppServer.js';
import { startQwenResponsesShim } from '../src/main/qwenResponsesShim.js';

const root = await mkdtemp(join(tmpdir(), 'noobi-custom-tool-'));
let calls = 0;
let returned = false;
let failUpstream = false;
const patch = '*** Begin Patch\n*** Add File: route-probe.txt\n+CUSTOM_PATCH_OK\n*** End Patch';
const shim = await startQwenResponsesShim({
  upstream: 'https://dashscope.aliyuncs.com',
  fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    calls += 1;
    if (failUpstream) return new Response(JSON.stringify({ error: { message: 'PROBE_UPSTREAM_TIMEOUT' } }), { status: 504 });
    if (calls === 1) {
      assert(body.tools.some(tool => tool.function.name === 'apply_patch'), 'native patch tool must be registered');
      return new Response(JSON.stringify({ choices: [{ message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'patch_probe', type: 'function', function: {
          name: 'apply_patch', arguments: JSON.stringify({ input: patch }),
        } }],
      } }] }));
    }
    assert(calls <= 2, 'unexpected tool loop');
    const output = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'patch_probe');
    assert(output?.content?.includes('route-probe.txt'), 'native result must return through the adapter');
    assert.equal(await readFile(join(root, 'route-probe.txt'), 'utf8'), 'CUSTOM_PATCH_OK\n');
    returned = true;
    return new Response(JSON.stringify({ choices: [{ message: {
      role: 'assistant', content: 'CUSTOM_PATCH_ROUTE_OK',
    } }] }));
  },
});
const runtime = new CodexAppServer({
  codexHome: join(root, 'codex-home'),
  provider: {
    id: 'qwen', name: 'Qwen probe', model: 'qwen-plus', envKey: 'DASHSCOPE_API_KEY',
    apiKey: 'test-only-local-upstream', baseUrl: `${shim.baseUrl}/compatible-mode/v1`, wireApi: 'responses',
  },
});
runtime.on('serverRequest', request => runtime.rejectServerRequest(request.id, -32601, 'unexpected request'));
try {
  await runtime.start();
  const threadId = await runtime.startThread({
    cwd: root, model: 'qwen-plus', sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: true,
  });
  const result = await runtime.runTurn({
    threadId, cwd: root, model: 'qwen-plus',
    prompt: 'Use apply_patch to create route-probe.txt, then report completion.', timeoutMs: 30_000,
  });
  assert.equal(result.status, 'completed');
  assert(returned);
  assert.match(result.text, /CUSTOM_PATCH_ROUTE_OK/);
  failUpstream = true;
  const failureThread = await runtime.startThread({ cwd: root, model: 'qwen-plus', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
  const failed = await runtime.runTurn({ threadId: failureThread, cwd: root, model: 'qwen-plus', prompt: 'Reply with OK.', timeoutMs: 8_000 });
  assert.equal(failed.status, 'failed');
  assert.equal(calls, 3, 'a timed-out upstream must not trigger hidden native retry loops');
  console.log(JSON.stringify({ result: 'passed', version: runtime.status.version, calls, actualFileWritten: returned, timeoutFailsWithoutRetries: true }));
} finally {
  await runtime.stop();
  await shim.close();
  await rm(root, { recursive: true, force: true });
}
