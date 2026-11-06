import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProviderCredentialStore, isValidApiKeyShape } from './providerCredentialStore.js';
import type { SecretCipher } from './providerCredentialStore.js';

/** Reversible stand-in for Electron safeStorage; proves nothing is written in clear. */
const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  seal: (plaintext) => `electron-safe-storage:v1:${Buffer.from(`enc:${plaintext}`).toString('base64')}`,
  open: (sealed) => {
    const prefix = 'electron-safe-storage:v1:';
    if (!sealed.startsWith(prefix)) throw new Error('bad envelope');
    return Buffer.from(sealed.slice(prefix.length), 'base64').toString('utf8').slice(4);
  },
};

const unavailableCipher: SecretCipher = {
  isAvailable: () => false,
  seal: () => { throw new Error('unavailable'); },
  open: () => { throw new Error('unavailable'); },
};

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'noobi-creds-'));
  file = join(dir, 'credentials.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ProviderCredentialStore', () => {
  it('stores a key as ciphertext, never as plaintext', async () => {
    const store = new ProviderCredentialStore(file, fakeCipher);
    await store.set('deepseek', 'sk-super-secret');

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('sk-super-secret');
    expect(raw).toContain('electron-safe-storage:v1:');
  });

  it('round-trips a key through reveal', async () => {
    const store = new ProviderCredentialStore(file, fakeCipher);
    await store.set('deepseek', 'sk-round-trip');
    expect(await store.reveal('deepseek')).toBe('sk-round-trip');
    expect(await store.has('deepseek')).toBe(true);
  });

  it('reports status without exposing key material', async () => {
    const store = new ProviderCredentialStore(file, fakeCipher);
    await store.set('deepseek', 'sk-a');
    const status = await store.status(['codex', 'deepseek']);
    expect(status).toEqual([
      { provider: 'codex', hasApiKey: false, encryptionAvailable: true },
      { provider: 'deepseek', hasApiKey: true, encryptionAvailable: true },
    ]);
    expect(JSON.stringify(status)).not.toContain('sk-a');
  });

  it('clears a key when set to an empty value', async () => {
    const store = new ProviderCredentialStore(file, fakeCipher);
    await store.set('deepseek', 'sk-gone');
    await store.set('deepseek', '   ');
    expect(await store.reveal('deepseek')).toBeNull();
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('deepseek');
  });

  it('refuses to store when OS encryption is unavailable rather than writing plaintext', async () => {
    const store = new ProviderCredentialStore(file, unavailableCipher);
    await expect(store.set('deepseek', 'sk-nope')).rejects.toThrow(/加密不可用/u);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('returns null instead of throwing when a stored key cannot be decrypted', async () => {
    const writer = new ProviderCredentialStore(file, fakeCipher);
    await writer.set('deepseek', 'sk-other-machine');
    // A different cipher models another machine or user account.
    const reader = new ProviderCredentialStore(file, {
      isAvailable: () => true,
      seal: (value) => `electron-safe-storage:v1:${Buffer.from(value).toString('base64')}`,
      open: () => { throw new Error('cannot decrypt'); },
    });
    expect(await reader.reveal('deepseek')).toBeNull();
  });

  it('rejects malformed keys and ignores junk files', async () => {
    const store = new ProviderCredentialStore(file, fakeCipher);
    await expect(store.set('deepseek', 'has space')).rejects.toThrow(/格式无效/u);
    await expect(store.set('deepseek', 'x'.repeat(513))).rejects.toThrow(/格式无效/u);

    await rm(dir, { recursive: true, force: true });
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(file, 'not json');
    expect(await store.has('deepseek')).toBe(false);
  });

  it('drops values that do not carry the expected envelope prefix', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, keys: { deepseek: 'plain-text-key' } }));
    const store = new ProviderCredentialStore(file, fakeCipher);
    expect(await store.has('deepseek')).toBe(false);
  });
});

describe('isValidApiKeyShape', () => {
  it('accepts a normal key and rejects whitespace or emptiness', () => {
    expect(isValidApiKeyShape('sk-abc123')).toBe(true);
    expect(isValidApiKeyShape('  sk-abc123  ')).toBe(true);
    expect(isValidApiKeyShape('   ')).toBe(false);
    expect(isValidApiKeyShape('sk abc')).toBe(false);
    expect(isValidApiKeyShape(`sk-${'z'.repeat(600)}`)).toBe(false);
  });
});
