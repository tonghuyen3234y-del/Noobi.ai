import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Host-side tool executor for agent runtimes that do not ship their own.
 *
 * The Codex binary supplies read/write/shell tools internally. A runtime built
 * on a plain chat API (e.g. DeepSeek) must reimplement them, and that code is
 * security-critical: the model decides the arguments. Everything here is
 * closed by construction — no arbitrary shell strings, no escaping the project
 * workspace, no unbounded reads.
 */

export const TOOL_LIMITS = {
  maxReadBytes: 512 * 1024,
  maxWriteBytes: 2 * 1024 * 1024,
  maxListedFiles: 2_000,
  maxOutputBytes: 64 * 1024,
  defaultCommandTimeoutMs: 300_000,
} as const;

/** Commands the agent may run. Closed union: extend deliberately, never dynamically. */
export const ALLOWED_COMMANDS = ['npm', 'node', 'npx', 'godot', 'godot4'] as const;
export type AllowedCommand = typeof ALLOWED_COMMANDS[number];

export interface ToolExecutionResult {
  ok: boolean;
  /** Text returned to the model. Bounded. */
  content: string;
}

export interface CommandTask {
  /** Non-shell command from `ALLOWED_COMMANDS`. */
  command: AllowedCommand;
  args: string[];
  timeoutMs?: number;
}

export interface WorkspaceToolsOptions {
  /** Absolute project workspace root. Every path is resolved against it. */
  root: string;
  /** Workspace-relative paths the agent may never write. */
  readonlyPaths?: string[];
  /** Extra argv guard applied before spawn. Return an error string to block. */
  commandGuard?: (task: CommandTask) => string | null;
  /** Overrides for tests. */
  limits?: Partial<typeof TOOL_LIMITS>;
}

interface ResolvedLimits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListedFiles: number;
  maxOutputBytes: number;
  defaultCommandTimeoutMs: number;
}

export class WorkspaceTools {
  readonly #root: string;
  readonly #readonlyPaths: Set<string>;
  readonly #commandGuard: ((task: CommandTask) => string | null) | null;
  readonly #limits: ResolvedLimits;
  #canonicalRoot: string | null = null;

  constructor(options: WorkspaceToolsOptions) {
    if (!isAbsolute(options.root)) throw new Error('Workspace root must be absolute');
    this.#root = resolve(options.root);
    this.#readonlyPaths = new Set(
      (options.readonlyPaths ?? []).map(normalizeRelative),
    );
    this.#commandGuard = options.commandGuard ?? null;
    this.#limits = { ...TOOL_LIMITS, ...options.limits };
  }

  /** Canonical workspace root, after realpath. */
  async root(): Promise<string> {
    if (!this.#canonicalRoot) {
      const canonical = await realpath(this.#root);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error('Workspace root must be a directory');
      this.#canonicalRoot = canonical;
    }
    return this.#canonicalRoot;
  }

  async listFiles(): Promise<ToolExecutionResult> {
    const root = await this.root();
    const files: string[] = [];
    const walk = async (prefix: string): Promise<void> => {
      if (files.length >= this.#limits.maxListedFiles) return;
      const entries = await readdir(join(root, prefix), { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= this.#limits.maxListedFiles) return;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    await walk('');
    files.sort();
    const truncated = files.length >= this.#limits.maxListedFiles;
    return {
      ok: true,
      content: [
        files.join('\n') || '(empty workspace)',
        ...(truncated ? [`[truncated at ${this.#limits.maxListedFiles} files]`] : []),
      ].join('\n'),
    };
  }

  async readFile(relativePath: unknown): Promise<ToolExecutionResult> {
    const target = await this.#resolveForRead(relativePath);
    if (typeof target !== 'string') return target;

    const info = await lstat(target).catch(() => null);
    if (!info?.isFile()) return fail(`not a readable file: ${String(relativePath)}`);
    if (info.size > this.#limits.maxReadBytes) {
      return fail(
        `file is ${info.size} bytes; the read limit is ${this.#limits.maxReadBytes}. `
        + 'Read a smaller region or ask the host for a summary.',
      );
    }
    const text = await readFile(target, 'utf8');
    return { ok: true, content: bound(text, this.#limits.maxOutputBytes) };
  }

  async writeFile(relativePath: unknown, content: unknown): Promise<ToolExecutionResult> {
    const target = await this.#resolveForWrite(relativePath);
    if (typeof target !== 'string') return target;
    if (typeof content !== 'string') return fail('write_file requires string content');
    if (Buffer.byteLength(content, 'utf8') > this.#limits.maxWriteBytes) {
      return fail(`content exceeds the ${this.#limits.maxWriteBytes} byte write limit`);
    }

    await mkdir(join(target, '..'), { recursive: true });
    // Atomic replace: a partially written file must never be observable.
    const temporary = join(join(target, '..'), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      return fail(`could not write ${normalizeRelative(String(relativePath))}: ${asMessage(error)}`);
    }
    return {
      ok: true,
      content: `wrote ${normalizeRelative(String(relativePath))} (${Buffer.byteLength(content, 'utf8')} bytes)`,
    };
  }

  /**
   * Replace an exact snippet. Preferred over `write_file` for edits: it cannot
   * silently drop unrelated code, and a non-unique match is rejected rather
   * than guessed at.
   */
  async editFile(
    relativePath: unknown,
    oldText: unknown,
    newText: unknown,
  ): Promise<ToolExecutionResult> {
    if (typeof oldText !== 'string' || oldText.length === 0) {
      return fail('edit_file requires a non-empty oldText');
    }
    if (typeof newText !== 'string') return fail('edit_file requires string newText');

    const read = await this.readFile(relativePath);
    if (!read.ok) return read;

    const occurrences = countOccurrences(read.content, oldText);
    if (occurrences === 0) {
      return fail(
        `oldText was not found in ${normalizeRelative(String(relativePath))}. `
        + 'Read the file again and copy the exact snippet.',
      );
    }
    if (occurrences > 1) {
      return fail(
        `oldText appears ${occurrences} times in ${normalizeRelative(String(relativePath))}. `
        + 'Include more surrounding context so the match is unique.',
      );
    }

    const updated = read.content.replace(oldText, newText);
    return this.writeFile(relativePath, updated);
  }

  /**
   * Run a pre-approved command with an argv array and `shell: false`.
   * There is no path by which a model-supplied string reaches a shell.
   */
  async runCommand(task: unknown): Promise<ToolExecutionResult> {
    const parsed = this.#parseCommand(task);
    if (typeof parsed === 'string') return fail(parsed);
    if (this.#commandGuard) {
      const blocked = this.#commandGuard(parsed);
      if (blocked) return fail(blocked);
    }

    const root = await this.root();
    const timeoutMs = parsed.timeoutMs ?? this.#limits.defaultCommandTimeoutMs;
    return new Promise<ToolExecutionResult>((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(parsed.command, parsed.args, {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: commandEnvironment(process.env),
      });
      const finish = (label: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        resolvePromise({
          ok: label === 'exited 0',
          content: bound(`${label}\n${combined}`.trim(), this.#limits.maxOutputBytes),
        });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(`timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout = bound(stdout + String(chunk), this.#limits.maxOutputBytes);
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = bound(stderr + String(chunk), this.#limits.maxOutputBytes);
      });
      child.once('error', (error) => {
        stderr = `${stderr}\n${error.message}`;
        finish('failed to start');
      });
      child.once('close', (code) => finish(`exited ${code ?? 'signal'}`));
    });
  }

  #parseCommand(value: unknown): CommandTask | string {
    if (!value || typeof value !== 'object') return 'run_command requires an object';
    const record = value as Record<string, unknown>;
    if (typeof record.command !== 'string') return 'run_command requires a command name';
    if (!(ALLOWED_COMMANDS as readonly string[]).includes(record.command)) {
      return `command "${record.command}" is not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}`;
    }
    const args = record.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      return 'run_command requires args to be an array of strings';
    }
    for (const arg of args as string[]) {
      if (arg.includes('\0')) return 'command arguments may not contain NUL';
      if (arg.length > 2_000) return 'command argument is too long';
    }
    const timeoutMs = record.timeoutMs;
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return 'timeoutMs must be a positive number';
      }
    }
    return {
      command: record.command as AllowedCommand,
      args: args as string[],
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    };
  }

  async #resolveForRead(value: unknown): Promise<string | ToolExecutionResult> {
    const checked = await this.#resolveRelative(value);
    if (typeof checked !== 'string') return checked;

    const root = await this.root();
    const candidate = resolve(root, checked);
    if (!isContained(root, candidate)) return fail('path escapes the workspace');
    const symlinkEscape = await this.#escapingSymlink(checked);
    if (symlinkEscape) return fail(symlinkEscape);
    const canonical = await realpath(candidate).catch(() => null);
    if (!canonical) return fail(`file does not exist: ${checked}`);
    if (!isContained(root, canonical)) return fail('path escapes the workspace');
    return canonical;
  }

  async #resolveForWrite(value: unknown): Promise<string | ToolExecutionResult> {
    const checked = await this.#resolveRelative(value);
    if (typeof checked !== 'string') return checked;
    if (this.#readonlyPaths.has(checked)) {
      return fail(`${checked} is host-managed and read-only for the agent`);
    }
    for (const reserved of this.#readonlyPaths) {
      if (checked.startsWith(`${reserved}/`)) {
        return fail(`${checked} is inside host-managed path ${reserved} and is read-only for the agent`);
      }
    }

    const root = await this.root();
    const candidate = resolve(root, checked);
    if (!isContained(root, candidate)) return fail('path escapes the workspace');
    // Reject symlinked ancestors even when the leaf does not exist yet.
    const symlinkEscape = await this.#escapingSymlink(checked);
    if (symlinkEscape) return fail(symlinkEscape);

    // If the leaf exists, it must not be a symlink pointing outside.
    const info = await lstat(candidate).catch(() => null);
    if (info?.isSymbolicLink()) {
      const canonical = await realpath(candidate).catch(() => null);
      if (!canonical || !isContained(root, canonical)) {
        return fail('refusing to write through a symlink that escapes the workspace');
      }
    }
    return candidate;
  }

  async #resolveRelative(value: unknown): Promise<string | ToolExecutionResult> {
    if (typeof value !== 'string' || value.length === 0) return fail('path must be a non-empty string');
    if (value.includes('\0')) return fail('path may not contain NUL');
    if (isAbsolute(value)) return fail('path must be workspace-relative, not absolute');
    const normalized = normalizeRelative(value);
    if (normalized === '' || normalized === '.') return fail('path must name a file');
    if (normalized === '..' || normalized.startsWith('../')) {
      return fail('path escapes the workspace');
    }
    return normalized;
  }

  /** Returns an error message when a symlinked component escapes the workspace. */
  async #escapingSymlink(relativePath: string): Promise<string | null> {
    const root = await this.root();
    let current = root;
    for (const segment of relativePath.split('/')) {
      current = join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (!info) return null;
      if (info.isSymbolicLink()) {
        const canonical = await realpath(current).catch(() => null);
        if (!canonical || !isContained(root, canonical)) {
          return `symlinked path escapes the workspace: ${relativePath}`;
        }
      }
    }
    return null;
  }
}

/** OpenAI-compatible `tools` array describing the workspace tools above. */
export const WORKSPACE_TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List every file in the project workspace as relative paths.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the workspace. Read before editing.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        'Create or fully overwrite a file. Prefer edit_file for changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description:
        'Replace one exact snippet in a file. oldText must appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description:
        'Run an allowed build/test command. No shell. Allowed commands: '
        + `${ALLOWED_COMMANDS.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: [...ALLOWED_COMMANDS] },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
] as const;

export type WorkspaceToolName =
  | 'list_files'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'run_command';

/** Dispatch a model tool call. Unknown tools fail closed. */
export async function executeWorkspaceTool(
  tools: WorkspaceTools,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  switch (name) {
    case 'list_files':
      return tools.listFiles();
    case 'read_file':
      return tools.readFile(args.path);
    case 'write_file':
      return tools.writeFile(args.path, args.content);
    case 'edit_file':
      return tools.editFile(args.path, args.oldText, args.newText);
    case 'run_command':
      return tools.runCommand(args);
    default:
      return fail(`unknown tool "${name}"`);
  }
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
}

function isContained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  if (value === '') return true;
  return !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function bound(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  const truncated = Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8');
  return `${truncated}\n[truncated to ${limit} bytes]`;
}

function fail(message: string): ToolExecutionResult {
  return { ok: false, content: `ERROR ${message}` };
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Minimal environment allowlist; provider credentials never reach a child. */
export function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'NODE_ENV', 'SHELL',
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Exposed for tests: verifies a path would be accepted without touching disk. */
export const __testing = { isContained, normalizeRelative, countOccurrences, constants };
