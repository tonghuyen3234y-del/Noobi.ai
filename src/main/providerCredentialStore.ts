import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentProviderId, ProviderCredentialStatus } from '../shared/contracts.js';

/**
 * App-private API-key storage for providers that authenticate by key.
 *
 * Mirrors `MediaProviderStore`: only ciphertext is written to disk, the key is
 * decrypted for the duration of a single call, and it is never returned over
 * IPC, logged, written to a project, or forwarded to a child process.
 */

export interface SecretCipher {
  isAvailable(): boolean;
  seal(plaintext: string): string;
  open(sealed: string): string;
}

interface CredentialFile {
  version: 1;
  keys: Partial<Record<AgentProviderId, string>>;
}

const PREFIX = 'electron-safe-storage:v1:';

export class ProviderCredentialStore {
  readonly #storageFile: string;
  readonly #cipher: SecretCipher;
  #loaded: CredentialFile | null = null;

  constructor(storageFile: string, cipher: SecretCipher) {
    this.#storageFile = storageFile;
    this.#cipher = cipher;
  }

  /** Whether the OS grants a real encryption backend. */
  encryptionAvailable(): boolean {
    return this.#cipher.isAvailable();
  }

  async status(providers: readonly AgentProviderId[]): Promise<ProviderCredentialStatus[]> {
    const file = await this.#load();
    return providers.map((provider) => ({
      provider,
      hasApiKey: Boolean(file.keys[provider]),
      encryptionAvailable: this.#cipher.isAvailable(),
    }));
  }

  /**
   * Store a key. An empty or whitespace-only value clears it, which is how the
   * UI removes a credential without a separate delete verb.
   */
  async set(provider: AgentProviderId, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    const file = await this.#load();

    if (!trimmed) {
      delete file.keys[provider];
      await this.#save(file);
      return;
    }
    if (!this.#cipher.isAvailable()) {
      throw new Error('系统密钥加密不可用，无法安全保存 API Key。');
    }
    if (trimmed.length > 512 || /\s/u.test(trimmed)) {
      throw new Error('API Key 格式无效。');
    }
    file.keys[provider] = this.#cipher.seal(trimmed);
    await this.#save(file);
  }

  /**
   * Decrypt a key for immediate use.
   *
   * The caller must not retain the result beyond the operation that needs it.
   */
  async reveal(provider: AgentProviderId): Promise<string | null> {
    const file = await this.#load();
    const sealed = file.keys[provider];
    if (!sealed) return null;
    if (!this.#cipher.isAvailable()) {
      throw new Error('系统密钥加密不可用，无法读取已保存的 API Key。');
    }
    try {
      const value = this.#cipher.open(sealed);
      return value.trim() ? value : null;
    } catch {
      // A key sealed on another machine or user account cannot be opened.
      return null;
    }
  }

  async has(provider: AgentProviderId): Promise<boolean> {
    const file = await this.#load();
    return Boolean(file.keys[provider]);
  }

  async #load(): Promise<CredentialFile> {
    if (this.#loaded) return this.#loaded;
    const raw = await readFile(this.#storageFile, 'utf8').catch(() => null);
    if (!raw) {
      this.#loaded = { version: 1, keys: {} };
      return this.#loaded;
    }
    try {
      const parsed = JSON.parse(raw) as CredentialFile;
      if (parsed?.version !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) {
        this.#loaded = { version: 1, keys: {} };
        return this.#loaded;
      }
      const keys: Partial<Record<AgentProviderId, string>> = {};
      for (const provider of ['codex', 'deepseek'] as const) {
        const value = parsed.keys[provider];
        if (typeof value === 'string' && value.startsWith(PREFIX)) keys[provider] = value;
      }
      this.#loaded = { version: 1, keys };
      return this.#loaded;
    } catch {
      this.#loaded = { version: 1, keys: {} };
      return this.#loaded;
    }
  }

  async #save(file: CredentialFile): Promise<void> {
    await mkdir(dirname(this.#storageFile), { recursive: true, mode: 0o700 });
    await writeFile(this.#storageFile, JSON.stringify(file, null, 2), { mode: 0o600 });
    this.#loaded = file;
  }
}

/** Reject values that look like a leaked multi-line secret or junk input. */
export function isValidApiKeyShape(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 512 && !/\s/u.test(trimmed);
}
