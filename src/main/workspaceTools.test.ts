import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WorkspaceTools, executeWorkspaceTool, commandEnvironment } from './workspaceTools.js';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'noobi-tools-'));
  outside = await mkdtemp(join(tmpdir(), 'noobi-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.js'), 'const a = 1;\nconst b = 2;\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function tools(options: Partial<ConstructorParameters<typeof WorkspaceTools>[0]> = {}) {
  return new WorkspaceTools({ root, ...options });
}

describe('WorkspaceTools path containment', () => {
  it('rejects parent traversal for reads and writes', async () => {
    const workspace = tools();
    for (const path of ['../outside.txt', '../../etc/passwd', 'src/../../nope']) {
      expect((await workspace.readFile(path)).ok).toBe(false);
      expect((await workspace.writeFile(path, 'x')).ok).toBe(false);
    }
  });

  it('rejects absolute paths', async () => {
    const workspace = tools();
    expect((await workspace.readFile(join(outside, 'secret.txt'))).content).toMatch(/workspace-relative/u);
    expect((await workspace.writeFile('/tmp/escape.txt', 'x')).content).toMatch(/workspace-relative/u);
  });

  it('rejects NUL bytes in paths', async () => {
    const workspace = tools();
    expect((await workspace.readFile('src/main.js\0.png')).ok).toBe(false);
  });

  it('refuses to follow a symlink that escapes the workspace', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    const workspace = tools();
    const read = await workspace.readFile('leak.txt');
    expect(read.ok).toBe(false);
    expect(read.content).not.toContain('TOP SECRET');
  });

  it('refuses to write through an escaping symlink', async () => {
    await symlink(join(outside), join(root, 'escape-dir'));
    const workspace = tools();
    const result = await workspace.writeFile('escape-dir/pwned.txt', 'x');
    expect(result.ok).toBe(false);
    await expect(readFile(join(outside, 'pwned.txt'), 'utf8')).rejects.toThrow();
  });

  it('allows a symlink that stays inside the workspace', async () => {
    await symlink(join(root, 'src', 'main.js'), join(root, 'alias.js'));
    const workspace = tools({});
    // Writing through an in-workspace symlink would corrupt the target, so the
    // tool rejects the write but still permits reading the alias.
    const read = await workspace.readFile('alias.js');
    expect(read.ok).toBe(true);
    expect(read.content).toContain('const a = 1;');
  });

  it('enforces host-managed read-only paths', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'host contract');
    const workspace = tools({ readonlyPaths: ['AGENTS.md', '.noobi'] });
    expect((await workspace.writeFile('AGENTS.md', 'tampered')).ok).toBe(false);
    expect((await workspace.writeFile('.noobi/project.json', '{}')).ok).toBe(false);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('host contract');
    // Reading host contracts is allowed: the agent must obey them.
    expect((await workspace.readFile('AGENTS.md')).ok).toBe(true);
  });
});

describe('WorkspaceTools file operations', () => {
  it('lists files while excluding node_modules and .git', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(join(root, '.git', 'HEAD'), 'ref');
    const result = await tools().listFiles();
    expect(result.content).toContain('src/main.js');
    expect(result.content).not.toContain('node_modules');
    expect(result.content).not.toContain('.git');
  });

  it('creates parent directories on write', async () => {
    const workspace = tools();
    expect((await workspace.writeFile('deep/nested/file.txt', 'hello')).ok).toBe(true);
    expect(await readFile(join(root, 'deep/nested/file.txt'), 'utf8')).toBe('hello');
  });

  it('never leaves a partial file behind on an oversized write', async () => {
    const workspace = tools({ limits: { maxWriteBytes: 10 } });
    const result = await workspace.writeFile('big.txt', 'x'.repeat(11));
    expect(result.ok).toBe(false);
    await expect(readFile(join(root, 'big.txt'), 'utf8')).rejects.toThrow();
  });

  it('rejects reads above the size limit instead of truncating silently', async () => {
    await writeFile(join(root, 'big.txt'), 'y'.repeat(64));
    const workspace = tools({ limits: { maxReadBytes: 10 } });
    const result = await workspace.readFile('big.txt');
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/read limit/u);
  });
});

describe('WorkspaceTools edit_file', () => {
  it('replaces a unique snippet and preserves everything else', async () => {
    const workspace = tools();
    const result = await workspace.editFile('src/main.js', 'const a = 1;', 'const a = 42;');
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'src', 'main.js'), 'utf8'))
      .toBe('const a = 42;\nconst b = 2;\n');
  });

  it('refuses an ambiguous match rather than guessing', async () => {
    await writeFile(join(root, 'src', 'dup.js'), 'let x = 1;\nlet x = 1;\n');
    const result = await tools().editFile('src/dup.js', 'let x = 1;', 'let x = 2;');
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/appears 2 times/u);
    expect(await readFile(join(root, 'src', 'dup.js'), 'utf8')).toBe('let x = 1;\nlet x = 1;\n');
  });

  it('reports a missing snippet without touching the file', async () => {
    const before = await readFile(join(root, 'src', 'main.js'), 'utf8');
    const result = await tools().editFile('src/main.js', 'const z = 9;', 'const z = 0;');
    expect(result.ok).toBe(false);
    expect(await readFile(join(root, 'src', 'main.js'), 'utf8')).toBe(before);
  });
});

describe('WorkspaceTools run_command', () => {
  it('runs an allowed command and captures output', async () => {
    const workspace = tools();
    const result = await workspace.runCommand({
      command: 'node',
      args: ['-e', 'console.log("hello from node")'],
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello from node');
    expect(result.content).toContain('exited 0');
  });

  it('reports a non-zero exit without throwing', async () => {
    const result = await tools().runCommand({
      command: 'node',
      args: ['-e', 'process.exit(3)'],
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('exited 3');
  });

  it('blocks commands outside the allowlist', async () => {
    const workspace = tools();
    for (const command of ['sh', 'bash', 'rm', 'curl', 'python3']) {
      const result = await workspace.runCommand({ command, args: ['-c', 'echo pwned'] });
      expect(result.ok).toBe(false);
      expect(result.content).toMatch(/not allowed/u);
    }
  });

  it('never routes arguments through a shell', async () => {
    const workspace = tools();
    const result = await workspace.runCommand({
      command: 'node',
      args: ['-e', 'console.log(process.argv[1])', '$(whoami)'],
    });
    // Command substitution must arrive verbatim, proving no shell parsing.
    expect(result.content).toContain('$(whoami)');
  });

  it('rejects malformed command payloads', async () => {
    const workspace = tools();
    for (const payload of [null, {}, { command: 'node', args: 'not-an-array' }, { command: 'node', args: [1] }]) {
      expect((await workspace.runCommand(payload)).ok).toBe(false);
    }
    expect((await workspace.runCommand({ command: 'node', args: ['a\0b'] })).ok).toBe(false);
  });

  it('applies a host command guard before spawning', async () => {
    const workspace = tools({
      commandGuard: (task) => (task.args.includes('install') ? 'dependency installation is host-managed' : null),
    });
    const blocked = await workspace.runCommand({ command: 'npm', args: ['install', 'left-pad'] });
    expect(blocked.ok).toBe(false);
    expect(blocked.content).toMatch(/host-managed/u);
  });

  it('kills a command that exceeds its timeout', async () => {
    const result = await tools().runCommand({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/timed out/u);
  });
});

describe('executeWorkspaceTool dispatch', () => {
  it('routes known tools and fails closed on unknown ones', async () => {
    const workspace = tools();
    expect((await executeWorkspaceTool(workspace, 'read_file', { path: 'src/main.js' })).ok).toBe(true);
    const unknown = await executeWorkspaceTool(workspace, 'delete_everything', {});
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toMatch(/unknown tool/u);
  });
});

describe('commandEnvironment', () => {
  it('never forwards provider credentials to a child process', () => {
    const env = commandEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/u',
      DEEPSEEK_API_KEY: 'sk-secret',
      MINIMAX_API_KEY: 'mm-secret',
      OPENAI_API_KEY: 'oa-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.MINIMAX_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
