import { test, expect } from 'bun:test';
import { createEncryption } from '../src/encryption';

// ─── Basic functionality ─────────────────────────────────────────────────

test('encrypt then decrypt returns original data', async () => {
  const { encrypt, decrypt } = createEncryption('strong-passphrase-12345');

  const original = [
    { id: '1', name: 'Alice', secret: 'my-secret' },
    { id: '2', name: 'Bob', secret: 'another-secret' },
  ];

  const encrypted = await encrypt(original);
  const decrypted = await decrypt(encrypted);

  expect(decrypted).toEqual(original);
});

test('encrypt then decrypt with single-item array', async () => {
  const { encrypt, decrypt } = createEncryption('another-passphrase');

  const original = [{ id: 'x', value: 42 }];
  const encrypted = await encrypt(original);
  const decrypted = await decrypt(encrypted);

  expect(decrypted).toEqual(original);
});

test('encrypt then decrypt empty array', async () => {
  const { encrypt, decrypt } = createEncryption('empty-test-passphrase');

  const encrypted = await encrypt([]);
  const decrypted = await decrypt(encrypted);

  expect(decrypted).toEqual([]);
});

// ─── Format: version prefix ──────────────────────────────────────────────

test('encrypted output starts with version prefix', async () => {
  const { encrypt } = createEncryption('test-passphrase');

  const encrypted = await encrypt([{ id: '1' }]);

  expect(encrypted.startsWith('v1:')).toBe(true);
});

test('encrypted output is unique per call (random salt + IV)', async () => {
  const { encrypt } = createEncryption('test-passphrase');
  const data = [{ id: '1' }];

  const a = await encrypt(data);
  const b = await encrypt(data);
  const c = await encrypt(data);

  // All three should be different
  expect(a).not.toBe(b);
  expect(b).not.toBe(c);
  expect(a).not.toBe(c);
});

// ─── Tampering detection ─────────────────────────────────────────────────

test('decrypt throws on tampered data', async () => {
  const { encrypt, decrypt } = createEncryption('test-passphrase');

  const encrypted = await encrypt([{ id: '1' }]);

  // Tamper: decode the binary payload, flip a byte in the auth tag, re-encode.
  // This guarantees AES-GCM authentication will fail, regardless of atob/btoa quirks.
  const sep = encrypted.indexOf(':');
  const version = encrypted.slice(0, sep);
  const b64 = encrypted.slice(sep + 1);
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  // Flip all bits in the last byte (part of the 16-byte GCM auth tag).
  // Even a single bit flip is enough — this is extreme overkill.
  bytes[bytes.length - 1] ^= 0xff;

  let tamperedBinary = '';
  for (let i = 0; i < bytes.length; i++) tamperedBinary += String.fromCharCode(bytes[i]);
  const tampered = version + ':' + btoa(tamperedBinary);

  await expect(decrypt(tampered)).rejects.toThrow('Decryption failed');
});

test('decrypt throws on truncated payload', async () => {
  const { decrypt } = createEncryption('test-passphrase');

  // A v1: prefix with garbage that's too short
  const truncated = 'v1:' + btoa('short');

  await expect(decrypt(truncated)).rejects.toThrow('too short');
});

test('decrypt throws on non-versioned string', async () => {
  const { decrypt } = createEncryption('test-passphrase');

  await expect(decrypt('plain-json-data')).rejects.toThrow(
    'Invalid encrypted payload',
  );
});

test('decrypt throws on plain base64 without version', async () => {
  const { decrypt } = createEncryption('test-passphrase');

  await expect(decrypt(btoa('some-data'))).rejects.toThrow(
    'Invalid encrypted payload',
  );
});

// ─── Key rotation ────────────────────────────────────────────────────────

test('key rotation: encrypt with new key, decrypt with both versions', async () => {
  const data = [{ id: '1', value: 42 }];

  // Phase 1: encrypt with version 1
  const old = createEncryption({ 1: 'old-passphrase' }, { version: 1 });
  const encryptedV1 = await old.encrypt(data);

  expect(encryptedV1.startsWith('v1:')).toBe(true);

  // Phase 2: encrypt with version 2
  const current = createEncryption(
    { 1: 'old-passphrase', 2: 'new-passphrase' },
    { version: 2 },
  );
  const encryptedV2 = await current.encrypt(data);

  expect(encryptedV2.startsWith('v2:')).toBe(true);

  // Both should decrypt correctly
  const decryptedV1 = await current.decrypt(encryptedV1);
  const decryptedV2 = await current.decrypt(encryptedV2);

  expect(decryptedV1).toEqual(data);
  expect(decryptedV2).toEqual(data);
});

test('key rotation: old passphrase removed — old data fails, new data works', async () => {
  const data = [{ id: '1' }];

  // Encrypt with old passphrase
  const old = createEncryption({ 1: 'old-passphrase' }, { version: 1 });
  const encryptedV1 = await old.encrypt(data);

  // Now configure only the new passphrase
  const current = createEncryption({ 2: 'new-passphrase' }, { version: 2 });

  // Encrypt with new key works
  const encryptedV2 = await current.encrypt(data);
  const decryptedV2 = await current.decrypt(encryptedV2);
  expect(decryptedV2).toEqual(data);

  // Old data should fail
  await expect(current.decrypt(encryptedV1)).rejects.toThrow(
    'Unknown key version 1',
  );
});

// ─── Error cases ─────────────────────────────────────────────────────────

test('throws when no passphrase for active version', () => {
  expect(() =>
    createEncryption({ 2: 'some-passphrase' }, { version: 1 }),
  ).toThrow('No passphrase for version 1');
});

test('throws when version is not a positive integer', () => {
  expect(() => createEncryption('test', { version: 0 })).toThrow(
    'Version must be a positive integer',
  );
  expect(() => createEncryption('test', { version: -1 })).toThrow(
    'Version must be a positive integer',
  );
  expect(() => createEncryption('test', { version: 1.5 })).toThrow(
    'Version must be a positive integer',
  );
});

test('warns on low iteration count', () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warnings.push(msg);

  createEncryption('test', { iterations: 5_000 });

  console.warn = original;

  expect(warnings.some((w) => w.includes('[SECURITY]'))).toBe(true);
  expect(warnings.some((w) => w.includes('PBKDF2'))).toBe(true);
});

test('complex nested data structures survive round-trip', async () => {
  const { encrypt, decrypt } = createEncryption('nested-test');

  const original = [
    {
      id: 'complex-1',
      nested: { a: { b: { c: [1, 2, 3] } } },
      dates: ['2024-01-01T00:00:00Z'],
      flags: [true, false, null],
    },
    {
      id: 'complex-2',
      unicode: '🎉 你好 مرحبا',
      numbers: [1.5, 0, Number.MAX_SAFE_INTEGER],
    },
  ];

  const encrypted = await encrypt(original);
  const decrypted = await decrypt(encrypted);

  expect(decrypted).toEqual(original);
});
