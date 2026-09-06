/**
 * Hardening tests for fixes shipped after v2.3.0.
 * Covers: destructured methods, serialized saves, structuredClone
 * callbacks, stricter filenames, non-function encryption options,
 * undefined changes, non-array payloads, passphrase warnings,
 * large encrypted payloads, corrupt-file warnings, and rename failures.
 */
import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
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
  open: mock(async () => ({ write: mock(), close: mock(), truncate: mock() })),
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

test('Destructured register/load/save work without `this`', async () => {
  const adapter = createAdapter<TestData>('destructured.json');
  const { register, load, save } = adapter;

  await register(mock());
  const data: TestData[] = [{ id: '1', name: 'detached', value: 7 }];
  await save(data, { added: data, modified: [], removed: [] });

  const result = await load();
  expect(result.items).toEqual(data);
});

// ─── Serialized saves ───

test('Concurrent saves serialize: last queued write wins exactly', async () => {
  const adapter = createAdapter<TestData>('queued.json');
  await adapter.register(mock());

  const a: TestData[] = [{ id: 'a', name: 'first', value: 1 }];
  const b: TestData[] = [{ id: 'b', name: 'second', value: 2 }];
  const c: TestData[] = [{ id: 'c', name: 'third', value: 3 }];

  await Promise.all([
    adapter.save(a, { added: a, modified: [], removed: [] }),
    adapter.save(b, { added: b, modified: [], removed: [] }),
    adapter.save(c, { added: c, modified: [], removed: [] }),
  ]);

  // Queue order is submission order, so the last submission wins intact.
  const result = await adapter.load();
  expect(result.items).toEqual(c);
});

test('A failed save does not break the queue for later saves', async () => {
  const adapter = createAdapter<TestData>('queue-recovery.json', {
    encrypt: async () => { throw new Error('boom'); },
  });
  await adapter.register(mock()).catch(() => {});
  // Register fails (encrypt throws on init), but save queue must still settle.
  const data: TestData[] = [{ id: '1', name: 'x', value: 1 }];
  expect(
    adapter.save(data, { added: data, modified: [], removed: [] })
  ).rejects.toThrow();
  // Second save also rejects instead of hanging on a broken chain.
  expect(
    adapter.save(data, { added: data, modified: [], removed: [] })
  ).rejects.toThrow();
});

// ─── structuredClone callback ───

test('Callback receives Date instances, file stores ISO strings', async () => {
  interface DatedItem {
    id: string;
    at: Date;
  }
  const adapter = createAdapter<DatedItem>('dates.json');
  let callback_data: any = null;
  await adapter.register((data: any) => { callback_data = data; });

  const stamped = new Date('2026-03-15T12:00:00.000Z');
  const items: DatedItem[] = [{ id: '1', at: stamped }];
  await adapter.save(items, { added: items, modified: [], removed: [] });

  expect(callback_data.items[0].at).toBeInstanceOf(Date);
  expect(callback_data.items[0].at.getTime()).toBe(stamped.getTime());

  const raw = new TextDecoder().decode(
    mock_file_system.get(`${BaseDirectory.AppLocalData}/dates.json`)!
  );
  expect(raw).toContain('2026-03-15T12:00:00.000Z');
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
    'control.json',
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

// ─── Undefined changes ───

test('save with undefined changes falls back to full save', async () => {
  const adapter = createAdapter<TestData>('undef.json');
  await adapter.register(mock());

  const data: TestData[] = [{ id: '1', name: 'full', value: 1 }];
  // @ts-expect-error testing runtime hardening
  await adapter.save(data, undefined);

  const result = await adapter.load();
  expect(result.items).toEqual(data);
});

// ─── Non-array encrypted payload ───

test('Builtin decrypt rejects payloads that are not arrays', async () => {
  const { encrypt, decrypt } = createEncryption('long-enough-passphrase');
  const enc = await encrypt('just-a-string' as any);
  expect(decrypt(enc)).rejects.toThrow('not an array');
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

test('Corrupt JSON loads empty and warns loudly', async () => {
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/corrupt.json`,
    new TextEncoder().encode('{not valid json')
  );
  const adapter = createAdapter<TestData>('corrupt.json');

  const result = await adapter.load();

  expect(result.items).toEqual([]);
  expect(warnings.some((w) => w.includes('[DATA]'))).toBe(true);
});

// ─── Rename failure cleanup ───

test('Failed atomic rename throws and leaves no temp files', async () => {
  const adapter = createAdapter<TestData>('rename-fail.json');
  await adapter.register(mock());

  mock_rename_fn.mockImplementationOnce(async () => {
    throw new Error('rename failed');
  });

  const data: TestData[] = [{ id: '1', name: 'x', value: 1 }];
  expect(
    adapter.save(data, { added: data, modified: [], removed: [] })
  ).rejects.toThrow('Failed to save rename-fail.json');

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

  const result = await adapter.load();
  // Cast: validation is off, so the runtime value is intentionally not T[].
  expect(result.items as unknown as { a: number }).toEqual({ a: 1 });
});
