/**
 * DeepSeek capability probe.
 *
 * NOT part of the build. This is a throwaway measurement harness: before
 * committing to a `DeepSeekRuntime`, we need numbers on whether the model can
 * survive the job Noobi.ai's Implementer role actually performs — read files,
 * edit precisely, then iterate until a build passes.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... npx tsx scripts/deepseek-probe.ts
 *   DEEPSEEK_API_KEY=sk-... npx tsx scripts/deepseek-probe.ts --model deepseek-reasoner
 *   DEEPSEEK_API_KEY=sk-... npx tsx scripts/deepseek-probe.ts --tasks patch,iterate
 *
 * It writes into a temporary directory only and never touches the repo.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const API_BASE = process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com';
const MODEL = readFlag('--model') ?? 'deepseek-chat';
const TASKS = (readFlag('--tasks') ?? 'recall,patch,iterate').split(',').map((task) => task.trim());
const MAX_STEPS = Number(readFlag('--max-steps') ?? 30);
const PROJECT_ROOT = process.cwd();

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ProbeResult {
  task: string;
  steps: number;
  completed: boolean;
  durationMs: number;
  failures: string[];
  notes: string[];
}

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Paths are relative to the project root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Overwrite an entire file with new content. Paths are relative to the project root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List all project files (relative paths).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_check',
      description: 'Run the project build check. Returns stdout, stderr and exit code.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    fail('DEEPSEEK_API_KEY is not set. Export a DeepSeek API key and re-run.');
  }

  console.log(`DeepSeek capability probe`);
  console.log(`  model   : ${MODEL}`);
  console.log(`  endpoint: ${API_BASE}`);
  console.log(`  tasks   : ${TASKS.join(', ')}`);
  console.log(`  maxSteps: ${MAX_STEPS}\n`);

  const results: ProbeResult[] = [];
  for (const task of TASKS) {
    if (task === 'recall') results.push(await runTask('recall', apiKey, setupRecall));
    else if (task === 'patch') results.push(await runTask('patch', apiKey, setupPatch));
    else if (task === 'iterate') results.push(await runTask('iterate', apiKey, setupIterate));
    else fail(`Unknown task: ${task}`);
  }

  report(results);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Compression test: the model must report a fact it can only know by having
 * actually read the file. Catches fabricated content, the #1 failure mode when
 * a model is handed a large context.
 */
async function setupRecall(dir: string): Promise<string> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'config.ts'), [
    '// Never edit this file.',
    'export const GAME_TITLE = "Neon Bricks";',
    'export const PADDLE_SPEED = 0.42;',
    'export const BRICK_ROWS = 7;',
    'export const SECRET_TUNING = "KIWI-38";',
    'export const COLORS = ["#ff00aa", "#00ffcc", "#ffee00"];',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'probe', type: 'module' }, null, 2));
  return [
    'Read src/config.ts and report exact values.',
    'Use read_file first. Do not guess.',
    'Then call write_file to create answer.json containing ONLY a JSON object with keys:',
    'gameTitle, paddleSpeed, brickRows, secretTuning.',
    'Values must match the file exactly, preserving case and types.',
  ].join('\n');
}

/**
 * Patch fidelity test: a precise two-line edit inside a file full of decoys.
 * A model that rewrites the whole file from memory usually corrupts the decoys.
 */
async function setupPatch(dir: string): Promise<string> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'physics.ts'), [
    'export interface Body { x: number; y: number; vx: number; vy: number }',
    '',
    'const GRAVITY = 9.81;',
    'const DRAG = 0.985;',
    '',
    'export function step(body: Body, dt: number): Body {',
    '  const vy = body.vy + GRAVITY * dt;',
    '  return {',
    '    x: body.x + body.vx * dt,',
    '    y: body.y + vy * dt,',
    '    vx: body.vx * DRAG,',
    '    vy,',
    '  };',
    '}',
    '',
    'export function bounce(body: Body, restitution: number): Body {',
    '  return { ...body, vy: -body.vy * restitution };',
    '}',
    '',
  ].join('\n'));
  return [
    'In src/physics.ts, change GRAVITY from 9.81 to 4.0 and DRAG from 0.985 to 0.999.',
    'Read the file first. Change ONLY those two constants.',
    'Every other character in the file must remain byte-identical.',
    'Then read the file back and confirm the diff is exactly two lines changed.',
  ].join('\n');
}

/**
 * Iteration test: the real Implementer loop. Write code, run the check, read
 * the error, fix it, repeat. State must be tracked across tool calls.
 */
async function setupIterate(dir: string): Promise<string> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'probe',
    type: 'module',
    scripts: { check: 'node src/check.mjs' },
  }, null, 2));
  await writeFile(join(dir, 'src', 'check.mjs'), [
    "import { readFile } from 'node:fs/promises';",
    "const source = await readFile(new URL('./game.mjs', import.meta.url), 'utf8');",
    "const problems = [];",
    "if (!/export function score\\(hits, combo\\)/.test(source)) problems.push('missing export function score(hits, combo)');",
    "if (!/hits \\* 10/.test(source)) problems.push('base score must be hits * 10');",
    "if (!/combo >= 5/.test(source)) problems.push('combo bonus requires combo >= 5');",
    "if (!/\\* 2\\b/.test(source)) problems.push('combo bonus must double the base');",
    "if (problems.length) { console.error('FAIL\\n' + problems.join('\\n')); process.exit(1); }",
    "console.log('OK');",
    '',
  ].join('\n'));
  return [
    'Create src/game.mjs implementing: export function score(hits, combo)',
    'Rules: base = hits * 10. If combo >= 5, the result is doubled.',
    'Then run run_check repeatedly until it exits 0.',
    'Do not stop until the check passes. Report the number of attempts.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function runTask(
  name: string,
  apiKey: string,
  setup: (dir: string) => Promise<string>,
): Promise<ProbeResult> {
  const dir = await mkdtemp(join(tmpdir(), `noobi-ds-${name}-`));
  const prompt = await setup(dir);
  const failures: string[] = [];
  const notes: string[] = [];
  const started = Date.now();
  let steps = 0;
  let completed = false;

  console.log(`━━━ ${name} ━━━`);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a coding agent operating inside a temporary project directory.',
        'You can only act through the provided tools. Never invent file contents.',
        'Always read a file before modifying it.',
        'When the task is done, reply with a short final message and no tool calls.',
      ].join('\n'),
    },
    { role: 'user', content: prompt },
  ];

  try {
    while (steps < MAX_STEPS) {
      steps += 1;
      const response = await chat(apiKey, messages);
      messages.push(response);

      const calls = response.tool_calls ?? [];
      if (calls.length === 0) {
        console.log(`  [step ${steps}] final answer`);
        completed = true;
        break;
      }

      for (const call of calls) {
        const result = await executeTool(dir, call);
        console.log(`  [step ${steps}] ${call.function.name} → ${summarize(result)}`);
        if (result.startsWith('ERROR')) failures.push(`${call.function.name}: ${result}`);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: truncate(result, 12_000),
        });
      }
    }

    if (!completed && steps >= MAX_STEPS) {
      failures.push(`hit max steps (${MAX_STEPS}) without finishing`);
    }

    await verify(name, dir, failures, notes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  return { task: name, steps, completed, durationMs: Date.now() - started, failures, notes };
}

async function chat(apiKey: string, messages: ChatMessage[]): Promise<ChatMessage> {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      temperature: 0,
      max_tokens: 4_096,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`DeepSeek API ${response.status}: ${body.slice(0, 500)}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: ChatMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = payload.choices?.[0]?.message;
  if (!message) fail('DeepSeek returned no message');
  if (payload.usage) {
    process.stdout.write(
      `        tokens: in ${payload.usage.prompt_tokens ?? '?'} out ${payload.usage.completion_tokens ?? '?'}\n`,
    );
  }
  return { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls };
}

async function executeTool(dir: string, call: ToolCall): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
  } catch {
    return `ERROR invalid JSON arguments: ${call.function.arguments}`;
  }

  const resolvePath = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null;
    const target = join(dir, value);
    const rel = relative(dir, target);
    if (rel.startsWith('..') || rel.includes(`..${'/'}`)) return null;
    return target;
  };

  switch (call.function.name) {
    case 'list_files': {
      return (await listFiles(dir)).join('\n') || '(empty)';
    }
    case 'read_file': {
      const path = resolvePath(args.path);
      if (!path || !existsSync(path)) return `ERROR cannot read ${String(args.path)}`;
      return (await readFile(path, 'utf8'));
    }
    case 'write_file': {
      const path = resolvePath(args.path);
      if (!path || typeof args.content !== 'string') return 'ERROR write_file requires path and content';
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, args.content);
      return `wrote ${relative(dir, path)} (${args.content.length} bytes)`;
    }
    case 'run_check': {
      return await runCommand(dir, 'npm', ['run', '--silent', 'check']);
    }
    default:
      return `ERROR unknown tool ${call.function.name}`;
  }
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, rel));
    else files.push(rel);
  }
  return files.sort();
}

async function runCommand(cwd: string, command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, env: { ...process.env } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.once('error', (error) => resolve(`ERROR ${error.message}`));
    child.once('exit', (code) => {
      resolve(`exit ${code ?? 'signal'}\n${truncate(out, 8_000)}`);
    });
  });
}

async function verify(
  task: string,
  dir: string,
  failures: string[],
  notes: string[],
): Promise<void> {
  if (task === 'recall') {
    const path = join(dir, 'answer.json');
    if (!existsSync(path)) { failures.push('answer.json was never created'); return; }
    const raw = await readFile(path, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      failures.push(`answer.json is not valid JSON: ${raw.slice(0, 200)}`);
      return;
    }
    const expected: Record<string, unknown> = {
      gameTitle: 'Neon Bricks',
      paddleSpeed: 0.42,
      brickRows: 7,
      secretTuning: 'KIWI-38',
    };
    for (const [key, want] of Object.entries(expected)) {
      if (parsed[key] !== want) failures.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(parsed[key])}`);
    }
    notes.push(`fabricated ${countFabrications(parsed, expected)} field(s)`);
  }

  if (task === 'patch') {
    const text = await readFile(join(dir, 'src', 'physics.ts'), 'utf8');
    if (!text.includes('const GRAVITY = 4.0;')) failures.push('GRAVITY was not changed to 4.0');
    if (!text.includes('const DRAG = 0.999;')) failures.push('DRAG was not changed to 0.999');
    const decoys = [
      'export interface Body { x: number; y: number; vx: number; vy: number }',
      'export function step(body: Body, dt: number): Body {',
      '    vx: body.vx * DRAG,',
      'export function bounce(body: Body, restitution: number): Body {',
      '  return { ...body, vy: -body.vy * restitution };',
    ];
    for (const decoy of decoys) {
      if (!text.includes(decoy)) failures.push(`collateral damage, lost line: ${decoy}`);
    }
  }

  if (task === 'iterate') {
    const path = join(dir, 'src', 'game.mjs');
    if (!existsSync(path)) { failures.push('src/game.mjs was never created'); return; }
    const check = await runCommand(dir, 'npm', ['run', '--silent', 'check']);
    if (!check.startsWith('exit 0')) failures.push(`final check did not pass:\n${check}`);
  }
}

function countFabrications(actual: Record<string, unknown>, expected: Record<string, unknown>): number {
  return Object.keys(expected).filter((key) => actual[key] !== expected[key]).length;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(results: ProbeResult[]): void {
  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  VERDICT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const result of results) {
    const badge = result.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`\n[${badge}] ${result.task}`);
    console.log(`  steps   : ${result.steps}`);
    console.log(`  finished: ${result.completed}`);
    console.log(`  elapsed : ${(result.durationMs / 1000).toFixed(1)}s`);
    for (const note of result.notes) console.log(`  note    : ${note}`);
    for (const failure of result.failures) console.log(`  problem : ${failure}`);
  }

  const allPassed = results.every((result) => result.failures.length === 0);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (allPassed) {
    console.log('  All tasks passed. A DeepSeekRuntime is worth building.');
  } else {
    console.log('  Some tasks failed. Read the problems above before committing');
    console.log('  a week to a DeepSeekRuntime.');
  }
  console.log(`  project root (unused): ${PROJECT_ROOT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function summarize(value: string): string {
  const first = value.split('\n')[0] ?? '';
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]`;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

await main();
