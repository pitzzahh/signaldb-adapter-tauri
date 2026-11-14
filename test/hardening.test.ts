/**
 * Hardening tests for fixes shipped after v2.3.0.
 * Covers: destructured methods, serialized writes, stricter filenames,
 * non-function encryption options, non-array payloads, passphrase warnings,
 * large encrypted payloads, corrupt-file warnings, rename failures,
 * and backup/verify/cleanup failure warnings.
 */
import { test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import { adapter as createAdapter } from '../src/index';
import { createEncryption } from '../src/encryption';

interface TestData {
  id: string;
  name: string;
  value: number;
}

const mock_file_system = new Map<string, Uint8Array>();

const mock_exists = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<boolean> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  return mock_file_system.has(`${base_dir}/${filename}`);
});

const mock_read_file = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<Uint8Array> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  const content = mock_file_system.get(`${base_dir}/${filename}`);
  if (!content) throw new Error(`File not found: ${filename}`);
  return content;
});

const mock_write_file = mock(async (filename: string, data: Uint8Array, options?: { baseDir?: BaseDirectory }): Promise<void> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  mock_file_system.set(`${base_dir}/${filename}`, data);
});

const mock_remove = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<void> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  mock_file_system.delete(`${base_dir}/${filename}`);
});

const mock_read_dir = mock(async (path: string, options?: { baseDir?: BaseDirectory }) => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  const prefix = `${base_dir}/`;
  const entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }> = [];
  for (const [full_path] of mock_file_system) {
    if (full_path.startsWith(prefix)) {
      entries.push({ name: full_path.slice(prefix.length), isDirectory: false, isFile: true, isSymlink: false });
    }
  }
  return entries;
});

const mock_rename_fn = mock(async (oldPath: string, newPath: string, options?: { oldPathBaseDir?: BaseDirectory; newPathBaseDir?: BaseDirectory }) => {
  const old_base = options?.oldPathBaseDir || BaseDirectory.AppLocalData;
  const new_base = options?.newPathBaseDir || BaseDirectory.AppLocalData;
  const content = mock_file_system.get(`${old_base}/${oldPath}`);
  if (!content) throw new Error(`File not found: ${oldPath}`);
  mock_file_system.set(`${new_base}/${newPath}`, content);
  mock_file_system.delete(`${old_base}/${oldPath}`);
});

mock.module('@tauri-apps/plugin-fs', () => ({
  BaseDirectory,
  exists: mock_exists,
  readFile: mock_read_file,
  readDir: mock_read_dir,
  writeFile: mock_write_file,
  remove: mock_remove,
  rename: mock_rename_fn,
}));

let originalWarn: typeof console.warn;
let warnings: string[];

beforeEach(() => {
  mock_file_system.clear();
  mock_exists.mockClear();
  mock_read_file.mockClear();
  mock_write_file.mockClear();
  mock_remove.mockClear();
  mock_read_dir.mockClear();
  mock_rename_fn.mockClear();
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    warnings.push(args.join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

// ─── Destructured methods (no `this` dependency) ───

test('Destructured setup/readAll/insert work without `this`', async () => {
  const adapter = createAdapter<TestData>('destructured.json');
  const { setup, readAll, insert } = adapter;

  await setup();
  await insert([{ id: '1', name: 'detached', value: 7 }]);

  expect(await readAll()).toEqual([{ id: '1', name: 'detached', value: 7 }]);
});

// ─── Serialized writes ───

test('Concurrent inserts serialize: nothing is lost', async () => {
  const adapter = createAdapter<TestData>('queued.json');
  await adapter.setup();

  // insertMany fans out over Promise.all, so this is the normal path, not an edge.
  await Promise.all([
    adapter.insert([{ id: 'a', name: 'first', value: 1 }]),
    adapter.insert([{ id: 'b', name: 'second', value: 2 }]),
    adapter.insert([{ id: 'c', name: 'third', value: 3 }]),
  ]);

  expect(await adapter.readAll()).toEqual([
    { id: 'a', name: 'first', value: 1 },
    { id: 'b', name: 'second', value: 2 },
    { id: 'c', name: 'third', value: 3 },
  ]);
});

test('Same-tick writes batch into one file rewrite', async () => {
  const adapter = createAdapter<TestData>('batched.json');
  await adapter.setup();

  mock_write_file.mockClear();
  await Promise.all([
    adapter.insert([{ id: 'a', name: 'first', value: 1 }]),
    adapter.insert([{ id: 'b', name: 'second', value: 2 }]),
    adapter.insert([{ id: 'c', name: 'third', value: 3 }]),
  ]);

  expect(await adapter.readAll()).toEqual([
    { id: 'a', name: 'first', value: 1 },
    { id: 'b', name: 'second', value: 2 },
    { id: 'c', name: 'third', value: 3 },
  ]);
  const temp_writes = mock_write_file.mock.calls.filter(([name]) =>
    (name as string).includes('.tmp.')
  );
  expect(temp_writes.length).toBe(1);
});

test('Mixed ops in one batch apply in order and keep item positions', async () => {
  const adapter = createAdapter<TestData>('batched-mixed.json');
  await adapter.setup();
  await adapter.insert([
    { id: 'a', name: 'first', value: 1 },
    { id: 'b', name: 'second', value: 2 },
    { id: 'c', name: 'third', value: 3 },
  ]);

  mock_write_file.mockClear();
  await Promise.all([
    adapter.replace([{ id: 'b', name: 'second-v2', value: 20 }]),
    adapter.remove([{ id: 'a', name: 'first', value: 1 }]),
    adapter.insert([{ id: 'd', name: 'fourth', value: 4 }]),
    adapter.remove([{ id: 'd', name: 'fourth', value: 4 }]),
    adapter.insert([{ id: 'e', name: 'fifth', value: 5 }]),
    adapter.remove([{ id: 'missing', name: 'x', value: 0 }]),
  ]);

  expect(await adapter.readAll()).toEqual([
    { id: 'b', name: 'second-v2', value: 20 },
    { id: 'c', name: 'third', value: 3 },
    { id: 'e', name: 'fifth', value: 5 },
  ]);
  const temp_writes = mock_write_file.mock.calls.filter(([name]) =>
    (name as string).includes('.tmp.')
  );
  expect(temp_writes.length).toBe(1);
});

test('Sequential awaits stay in separate batches', async () => {
  const adapter = createAdapter<TestData>('unbatched.json');
  await adapter.setup();

  mock_write_file.mockClear();
  await adapter.insert([{ id: 'a', name: 'first', value: 1 }]);
  await adapter.insert([{ id: 'b', name: 'second', value: 2 }]);
  await adapter.insert([{ id: 'c', name: 'third', value: 3 }]);

  const temp_writes = mock_write_file.mock.calls.filter(([name]) =>
    (name as string).includes('.tmp.')
  );
  expect(temp_writes.length).toBe(3);
});

test('A failing batch rejects every op with the same error', async () => {
  const adapter = createAdapter<TestData>('batch-fail.json', {
    encrypt: async () => { throw new Error('boom'); },
    decrypt: async (encrypted) => JSON.parse(encrypted),
  });
  await adapter.setup().catch(() => {});

  const results = await Promise.allSettled([
    adapter.insert([{ id: 'a', name: 'first', value: 1 }]),
    adapter.insert([{ id: 'b', name: 'second', value: 2 }]),
    adapter.insert([{ id: 'c', name: 'third', value: 3 }]),
  ]);

  expect(results.length).toBe(3);
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect((result.reason as Error).message).toBe('Failed to encrypt data for batch-fail.json');
    }
  }
});

test('Mixed concurrent writes serialize without losing updates', async () => {
  const adapter = createAdapter<TestData>('queued-mixed.json');
  await adapter.setup();
  await adapter.insert([
    { id: 'keep', name: 'keep', value: 0 },
    { id: 'drop', name: 'drop', value: 0 },
  ]);

  await Promise.all([
    adapter.insert([{ id: 'new', name: 'new', value: 1 }]),
    adapter.replace([{ id: 'keep', name: 'kept', value: 2 }]),
    adapter.remove([{ id: 'drop', name: 'drop', value: 0 }]),
  ]);

  expect(await adapter.readAll()).toEqual([
    { id: 'keep', name: 'kept', value: 2 },
    { id: 'new', name: 'new', value: 1 },
  ]);
});

test('A failed write does not break the queue for later writes', async () => {
  let should_fail = true;
  const adapter = createAdapter<TestData>('queue-recovery.json', {
    encrypt: async (data) => {
      if (should_fail) throw new Error('boom');
      return JSON.stringify(data);
    },
    decrypt: async (encrypted) => JSON.parse(encrypted),
  });
  await adapter.setup().catch(() => {});
  // Setup fails (encrypt throws on init), but the write queue must still settle.
  const data: TestData[] = [{ id: '1', name: 'x', value: 1 }];
  await expect(adapter.insert(data)).rejects.toThrow('Failed to encrypt data for queue-recovery.json');
  // Second write also rejects instead of hanging on a broken chain.
  await expect(adapter.insert(data)).rejects.toThrow('Failed to encrypt data for queue-recovery.json');

  // And the queue recovers once the failure clears.
  should_fail = false;
  await adapter.setup();
  await adapter.insert(data);
  expect(await adapter.readAll()).toEqual(data);
});

// ─── Stricter filenames ───

test('Strict filenames are rejected', () => {
  const bad = [
    'CON',
    'nul.txt',
    'COM1',
    'lpt9.json',
    'file?.json',
    'file*.json',
    'file:name.json',
    'file"quote.json',
    'file|pipe.json',
    'file<less.json',
    'trailingdot.',
    'trailingspace ',
    '.',
    'file\x01control.json',
  ];
  for (const filename of bad) {
    expect(() => createAdapter<TestData>(filename), filename).toThrow();
  }
});

test('Dotfiles are still allowed', () => {
  expect(() => createAdapter<TestData>('.hidden.json')).not.toThrow();
});

// ─── Encryption option checks ───

test('enforceEncryption rejects non-function encrypt/decrypt', () => {
  expect(() => createAdapter<TestData>('e1.json', {
    encrypt: 'not-a-function' as any,
    decrypt: async (s: string) => JSON.parse(s),
    security: { enforceEncryption: true },
  })).toThrow('Encryption enforced but encrypt/decrypt not provided.');

  expect(() => createAdapter<TestData>('e2.json', {
    security: { enforceEncryption: true, allowPlaintextFallback: true },
  })).toThrow('Encryption enforced but encrypt/decrypt not provided.');
});

// ─── Non-array encrypted payload ───

test('Builtin decrypt rejects payloads that are not arrays', async () => {
  const { encrypt, decrypt } = createEncryption('long-enough-passphrase');
  const enc = await encrypt('just-a-string' as any);
  await expect(decrypt(enc)).rejects.toThrow('not an array');
});

// ─── Passphrase warnings ───

test('Short passphrase warns', () => {
  createEncryption('short');
  expect(warnings.some((w) => w.includes('short'))).toBe(true);
});

test('Empty passphrase throws instead of silently deriving', () => {
  expect(() => createEncryption('')).toThrow('No passphrase');
});

// ─── Large payload round-trip (chunked base64 path) ───

test('200KB payload survives encryption round-trip', async () => {
  const { encrypt, decrypt } = createEncryption('long-enough-passphrase-for-big-data');
  const original = [{ id: 'big', blob: 'z'.repeat(200_000) }];

  const enc = await encrypt(original);
  const dec = await decrypt(enc);

  expect(dec).toEqual(original);
});

// ─── Corrupt file warning ───

test('Corrupt JSON reads empty and warns loudly', async () => {
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/corrupt.json`,
    new TextEncoder().encode('{not valid json')
  );
  const adapter = createAdapter<TestData>('corrupt.json');

  expect(await adapter.readAll()).toEqual([]);
  expect(warnings.some((w) => w.includes('[DATA]'))).toBe(true);
});

// ─── Rename failure cleanup ───

test('Failed atomic rename throws and leaves no temp files', async () => {
  const adapter = createAdapter<TestData>('rename-fail.json');
  await adapter.setup();

  mock_rename_fn.mockImplementationOnce(async () => {
    throw new Error('rename failed');
  });

  await expect(
    adapter.insert([{ id: '1', name: 'x', value: 1 }])
  ).rejects.toThrow('Failed to write rename-fail.json');

  const leftovers = Array.from(mock_file_system.keys()).filter((k) => k.includes('.tmp.'));
  expect(leftovers).toEqual([]);
});

// ─── Validation escape hatch ───

test('validateDecryptedData false returns raw JSON as-is', async () => {
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/raw.json`,
    new TextEncoder().encode(JSON.stringify({ a: 1 }))
  );
  const adapter = createAdapter<TestData>('raw.json', {
    security: { validateDecryptedData: false },
  });

  // Cast: validation is off, so the runtime value is intentionally not T[].
  expect((await adapter.readAll()) as unknown as { a: number }).toEqual({ a: 1 });
});

// ─── Failure-path warnings (backup, verify, cleanup) ───

test('Backup pruning failure warns but write succeeds', async () => {
  const adapter = createAdapter<TestData>('prune-fail.json', {
    security: { createBackups: true, maxBackups: 1 },
  });
  await adapter.setup();

  // Seed two backups so pruning must remove the oldest.
  const base = BaseDirectory.AppLocalData;
  mock_file_system.set(`${base}/prune-fail.json.backup.b-new`, new TextEncoder().encode('x'));
  mock_file_system.set(`${base}/prune-fail.json.backup.a-old`, new TextEncoder().encode('x'));

  mock_remove.mockImplementationOnce(async () => {
    throw new Error('remove failed');
  });

  await adapter.insert([{ id: '1', name: 'x', value: 1 }]);

  expect(warnings.some((w) => w.includes('Failed to remove old backup'))).toBe(true);
});

test('Backup listing failure warns but write succeeds', async () => {
  const adapter = createAdapter<TestData>('backup-list-fail.json', {
    security: { createBackups: true },
  });
  await adapter.setup();

  mock_read_dir.mockImplementationOnce(async () => {
    throw new Error('readDir failed');
  });

  await adapter.insert([{ id: '1', name: 'x', value: 1 }]);

  expect(warnings.some((w) => w.includes('Failed to cleanup old backups'))).toBe(true);
});

test('Decrypted data failing validation propagates without wrapping', async () => {
  const codec = {
    encrypt: async (data: TestData[]) => JSON.stringify(data),
    decrypt: async () => ({ not: 'an-array' }) as any,
  };
  await createAdapter<TestData>('decrypt-invalid.json', codec).setup();
  // A fresh instance has no cached snapshot, so it must decrypt the file.
  const adapter = createAdapter<TestData>('decrypt-invalid.json', codec);

  // Anchored: a 'Failed to load' prefix would mean the error got wrapped.
  await expect(adapter.readAll()).rejects.toThrow(/^Decryption failed, plaintext fallback disabled/);
});

test('Fallback plaintext failing validation reports both failures', async () => {
  const adapter = createAdapter<TestData>('fallback-invalid.json', {
    encrypt: async (data) => JSON.stringify(data),
    decrypt: async () => {
      throw new Error('bad key');
    },
    security: { allowPlaintextFallback: true },
  });
  await adapter.setup();

  // Valid JSON, but not an array: parses, then fails validation.
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/fallback-invalid.json`,
    new TextEncoder().encode(JSON.stringify({ a: 1 }))
  );

  await expect(adapter.readAll()).rejects.toThrow('Decryption and plaintext parse both failed');
});

test('Backup creation failure warns but write succeeds', async () => {
  const adapter = createAdapter<TestData>('backup-create-fail.json', {
    security: { createBackups: true },
  });
  await adapter.setup();

  // First write in the write flow is the backup write.
  mock_write_file.mockImplementationOnce(async () => {
    throw new Error('disk full');
  });

  await adapter.insert([{ id: '1', name: 'x', value: 1 }]);

  expect(warnings.some((w) => w.includes('Failed to create backup'))).toBe(true);
});

test('Temp file verification mismatch warns and fails the write', async () => {
  const adapter = createAdapter<TestData>('verify-fail.json');
  await adapter.setup();

  // Simulate disk corruption: the temp write lands with different bytes,
  // so the verify read does not match what was written.
  mock_write_file.mockImplementationOnce(async (filename: string, _data: Uint8Array, options?: { baseDir?: BaseDirectory }) => {
    const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
    mock_file_system.set(`${base_dir}/${filename}`, new TextEncoder().encode('tampered'));
  });

  await expect(
    adapter.insert([{ id: '1', name: 'x', value: 1 }])
  ).rejects.toThrow('Failed to write verify-fail.json');

  expect(warnings.some((w) => w.includes('Failed to verify temporary file'))).toBe(true);
  // No temp leftovers, and the original file is untouched.
  const leftovers = Array.from(mock_file_system.keys()).filter((k) => k.includes('.tmp.'));
  expect(leftovers).toEqual([]);
  const raw = new TextDecoder().decode(
    mock_file_system.get(`${BaseDirectory.AppLocalData}/verify-fail.json`)!
  );
  expect(raw).toBe('[]');
});

test('Temp cleanup failure after write error warns', async () => {
  const adapter = createAdapter<TestData>('cleanup-fail.json');
  await adapter.setup();

  mock_rename_fn.mockImplementationOnce(async () => {
    throw new Error('rename failed');
  });
  mock_remove.mockImplementationOnce(async () => {
    throw new Error('remove failed');
  });

  await expect(
    adapter.insert([{ id: '1', name: 'x', value: 1 }])
  ).rejects.toThrow('Failed to write cleanup-fail.json');

  expect(warnings.some((w) => w.includes('Failed to cleanup temp file'))).toBe(true);
});

// ─── Audit fixes: fail-closed writes ───

test('Writes refuse to overwrite a corrupt file', async () => {
  const corrupt = '{truncated-partial-data';
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/corrupt-save.json`,
    new TextEncoder().encode(corrupt)
  );
  const adapter = createAdapter<TestData>('corrupt-save.json');

  // readAll still returns empty for backwards compat...
  expect(await adapter.readAll()).toEqual([]);

  // ...but every mutating op refuses instead of destroying the corrupt bytes.
  const data: TestData[] = [{ id: '1', name: 'new', value: 1 }];
  await expect(adapter.insert(data)).rejects.toThrow('refusing to write');
  await expect(adapter.replace(data)).rejects.toThrow('refusing to write');
  await expect(adapter.remove(data)).rejects.toThrow('refusing to write');
  await expect(adapter.removeAll()).rejects.toThrow('refusing to write');

  const raw = new TextDecoder().decode(
    mock_file_system.get(`${BaseDirectory.AppLocalData}/corrupt-save.json`)!
  );
  expect(raw).toBe(corrupt);
});

test('Half-configured encryption throws at construction', () => {
  expect(() => createAdapter<TestData>('half-enc.json', {
    encrypt: async (data) => JSON.stringify(data),
  })).toThrow('encrypt and decrypt must be provided together.');

  expect(() => createAdapter<TestData>('half-dec.json', {
    decrypt: async (encrypted) => JSON.parse(encrypted),
  })).toThrow('encrypt and decrypt must be provided together.');
});

test('maxBackups:0 keeps no backups', async () => {
  const adapter = createAdapter<TestData>('no-backups.json', {
    security: { createBackups: true, maxBackups: 0 },
  });
  await adapter.setup();

  const base = BaseDirectory.AppLocalData;
  mock_file_system.set(`${base}/no-backups.json.backup.old-1`, new TextEncoder().encode('x'));
  mock_file_system.set(`${base}/no-backups.json.backup.old-2`, new TextEncoder().encode('x'));

  await adapter.insert([{ id: '1', name: 'x', value: 1 }]);

  const backups = Array.from(mock_file_system.keys()).filter((k) =>
    k.includes('no-backups.json.backup.')
  );
  expect(backups).toEqual([]);
});

test('replace overwrites stale same-id disk data', async () => {
  const stale: TestData[] = [{ id: '1', name: 'OLD', value: 1 }];
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/stale.json`,
    new TextEncoder().encode(JSON.stringify(stale))
  );
  const adapter = createAdapter<TestData>('stale.json');

  const fresh: TestData[] = [{ id: '1', name: 'NEW', value: 2 }];
  await adapter.replace(fresh);

  expect(await adapter.readAll()).toEqual(fresh);
});

test('Batch insert upserts same-id entries instead of duplicating', async () => {
  const adapter = createAdapter<TestData>('upsert.json');
  await adapter.setup();

  const initial: TestData[] = [{ id: '1', name: 'one', value: 1 }];
  await adapter.insert(initial);

  // 'insert' re-states an existing id: must replace, not duplicate.
  const next: TestData[] = [
    { id: '1', name: 'one-updated', value: 10 },
    { id: '2', name: 'two', value: 2 },
  ];
  await adapter.insert(next);

  expect(await adapter.readAll()).toEqual(next);
});

// ─── Decoded snapshot cache ───

const countingCodec = () => {
  const codec = {
    decrypts: 0,
    encrypt: async (data: unknown[]) => btoa(JSON.stringify(data)),
    decrypt: async (text: string) => {
      codec.decrypts++;
      return JSON.parse(atob(text));
    },
  };
  return codec;
};

// Counts AES-GCM decrypts done by the real createEncryption codec.
const countAesDecrypts = () => spyOn(crypto.subtle, 'decrypt');

test('createEncryption stores skip decrypt while the file is unchanged', async () => {
  const codec = createEncryption('long-enough-passphrase');
  const adapter = createAdapter<TestData>('snap-hit.json', codec);
  const decrypts = countAesDecrypts();
  try {
    await adapter.setup();
    await adapter.insert([{ id: '1', name: 'a', value: 1 }]);
    await adapter.insert([{ id: '2', name: 'b', value: 2 }]);
    await adapter.readIds(['1']);
    await adapter.createIndex('value');
    await adapter.readIndex('value');
    expect(await adapter.readAll()).toHaveLength(2);
    expect(decrypts).toHaveBeenCalledTimes(0);
  } finally {
    decrypts.mockRestore();
  }
});

test('An external edit to the file is decoded, not served from cache', async () => {
  const codec = createEncryption('long-enough-passphrase');
  const adapter = createAdapter<TestData>('snap-external.json', codec);
  await adapter.setup();
  await adapter.insert([{ id: '1', name: 'a', value: 1 }]);

  const path = `${BaseDirectory.AppLocalData}/snap-external.json`;
  mock_file_system.set(path, new TextEncoder().encode(
    await codec.encrypt([{ id: 'x', name: 'external', value: 9 }])
  ));

  const decrypts = countAesDecrypts();
  try {
    expect(await adapter.readAll()).toEqual([{ id: 'x', name: 'external', value: 9 }]);
    await adapter.insert([{ id: '2', name: 'b', value: 2 }]);
    expect((await adapter.readAll()).map((item) => item.id)).toEqual(['x', '2']);
    expect(decrypts).toHaveBeenCalledTimes(1);
  } finally {
    decrypts.mockRestore();
  }
});

test('Cached writes read back the same as a fresh instance', async () => {
  for (const codec of [undefined, createEncryption('long-enough-passphrase')]) {
    const name = codec ? 'snap-json-enc.json' : 'snap-json.json';
    const adapter = createAdapter<any>(name, codec);
    const fresh = () => createAdapter<any>(name, codec).readAll();
    await adapter.setup();

    await adapter.insert([{ id: '1', at: new Date(0), gone: undefined, nan: NaN }]);
    expect(await fresh()).toEqual([{ id: '1', at: '1970-01-01T00:00:00.000Z', nan: null }]);
    expect(await adapter.readAll()).toEqual(await fresh());

    await adapter.insert([{ id: '2', fn: () => 1 }]);
    expect(await adapter.readAll()).toEqual(await fresh());
    expect((await fresh())[1]).toEqual({ id: '2' });
  }
});

test('A custom codec is decoded after each write, not cached from the input', async () => {
  const codec = countingCodec();
  // Revives a field on the way out, so decrypt(encrypt(x)) differs from x.
  const reviving = {
    encrypt: codec.encrypt,
    decrypt: async (text: string) =>
      (await codec.decrypt(text)).map((item: any) => ({ ...item, revived: true })),
  };
  const adapter = createAdapter<any>('snap-custom.json', reviving);
  await adapter.setup();
  await adapter.insert([{ id: '1' }]);

  expect(await adapter.readAll()).toEqual([{ id: '1', revived: true }]);
  await adapter.readAll();
  // setup's file on the first guard read, then the written file once.
  expect(codec.decrypts).toBe(2);
});

test('Two instances on one file never lose each other\'s writes', async () => {
  const first = createAdapter<TestData>('snap-shared.json', countingCodec());
  const second = createAdapter<TestData>('snap-shared.json', countingCodec());
  await first.setup();
  await first.insert([{ id: '1', name: 'a', value: 1 }]);
  await second.insert([{ id: '2', name: 'b', value: 2 }]);
  await first.insert([{ id: '3', name: 'c', value: 3 }]);

  expect((await second.readAll()).map((item) => item.id)).toEqual(['1', '2', '3']);
});

test('Mutating read results or written inputs cannot leak into the file', async () => {
  const codecs = [undefined, countingCodec(), createEncryption('long-enough-passphrase')];
  for (const [i, codec] of codecs.entries()) {
    const name = `snap-clone-${i}.json`;
    const adapter = createAdapter<TestData>(name, codec);
    await adapter.setup();
    const input = { id: '1', name: 'a', value: 1 };
    await adapter.insert([input]);
    input.value = 100;

    const [read] = await adapter.readAll();
    read.value = 200;
    const [byId] = await adapter.readIds(['1']);
    byId.value = 300;

    await adapter.insert([{ id: '2', name: 'b', value: 2 }]);
    expect(await adapter.readAll()).toEqual([
      { id: '1', name: 'a', value: 1 },
      { id: '2', name: 'b', value: 2 },
    ]);
  }
});

test('readIndex racing a write never caches a stale index', async () => {
  const adapter = createAdapter<TestData>('snap-index-race.json', countingCodec());
  await adapter.setup();
  await adapter.insert([{ id: '1', name: 'a', value: 1 }]);
  await adapter.createIndex('value');

  // Hold readIndex's file read until the write has landed, then hand it
  // the old bytes: the read-modify-write interleaving that went stale.
  const path = `${BaseDirectory.AppLocalData}/snap-index-race.json`;
  const old_bytes = mock_file_system.get(path)!;
  let release!: () => void;
  const written = new Promise<void>((resolve) => { release = resolve; });
  mock_read_file.mockImplementationOnce(async () => {
    await written;
    return old_bytes;
  });

  const stale_read = adapter.readIndex('value');
  await adapter.insert([{ id: '2', name: 'b', value: 1 }]);
  release();
  expect((await stale_read).get('1')).toEqual(new Set(['1']));

  const fresh = await adapter.readIndex('value');
  expect(fresh.get('1')).toEqual(new Set(['1', '2']));
});

// ─── Backups reuse the guard read ───

test('Backups hold the exact pre-write bytes without an extra file read', async () => {
  const adapter = createAdapter<TestData>('backup-bytes.json', {
    security: { createBackups: true },
  });
  const path = `${BaseDirectory.AppLocalData}/backup-bytes.json`;
  // A BOM survives JSON.parse but not a decode/encode round trip.
  const original = new TextEncoder().encode('[{"id":"1","name":"a","value":1}]');
  const bom_bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...original]);
  mock_file_system.set(path, bom_bytes);

  mock_read_file.mockClear();
  await adapter.insert([{ id: '2', name: 'b', value: 2 }]);

  const backups = [...mock_file_system.keys()].filter((key) => key.includes('backup-bytes.json.backup.'));
  expect(backups).toHaveLength(1);
  expect(mock_file_system.get(backups[0])).toEqual(bom_bytes);
  // Guard read plus temp-file verification; the backup costs no read.
  const reads = mock_read_file.mock.calls.map(([name]) => name as string);
  expect(reads.filter((name) => name === 'backup-bytes.json')).toHaveLength(1);
});

test('A missing file is not backed up and does not warn', async () => {
  const adapter = createAdapter<TestData>('backup-missing.json', {
    security: { createBackups: true },
  });
  await adapter.insert([{ id: '1', name: 'a', value: 1 }]);

  const backups = [...mock_file_system.keys()].filter((key) => key.includes('.backup.'));
  expect(backups).toHaveLength(0);
  expect(warnings.some((w) => w.includes('Failed to create backup'))).toBe(false);
  expect(await adapter.readAll()).toEqual([{ id: '1', name: 'a', value: 1 }]);
});
