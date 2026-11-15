/**
 * Comprehensive edge case and corner scenario tests.
 * Covers scenarios the other test files don't.
 */
import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

interface TestData {
  id: string;
  name: string;
  value: number;
  extra?: string;
  nested?: { key: string; count: number };
  tags?: string[];
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
      const name = full_path.slice(prefix.length);
      entries.push({ name, isDirectory: false, isFile: true, isSymlink: false });
    }
  }
  return entries;
});

const mock_rename_fn = mock(async (oldPath: string, newPath: string, options?: { oldPathBaseDir?: BaseDirectory; newPathBaseDir?: BaseDirectory }) => {
  const old_base = options?.oldPathBaseDir || BaseDirectory.AppLocalData;
  const new_base = options?.newPathBaseDir || BaseDirectory.AppLocalData;
  const old_full = `${old_base}/${oldPath}`;
  const new_full = `${new_base}/${newPath}`;
  const content = mock_file_system.get(old_full);
  if (!content) throw new Error(`File not found: ${oldPath}`);
  mock_file_system.set(new_full, content);
  mock_file_system.delete(old_full);
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

const { adapter: createAdapter } = await import('../src/index');

// Helpers
function readFile(filename: string, baseDir = BaseDirectory.AppLocalData): string {
  const data = mock_file_system.get(`${baseDir}/${filename}`);
  return data ? new TextDecoder().decode(data) : '';
}

function fileExists(filename: string, baseDir = BaseDirectory.AppLocalData): boolean {
  return mock_file_system.has(`${baseDir}/${filename}`);
}

let originalWarn: typeof console.warn;
let warnings: string[] = [];

function captureWarnings() {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    warnings.push(args.join(' '));
    originalWarn(...args);
  };
}

function restoreWarnings() {
  if (originalWarn) console.warn = originalWarn;
}

beforeEach(() => {
  mock_file_system.clear();
  mock_write_file.mockClear();
  mock_rename_fn.mockClear();
  captureWarnings();
});

afterEach(() => {
  restoreWarnings();
});

// ═══════════════════════════════════════════
// Setup edge cases
// ═══════════════════════════════════════════

test('Setup with non-existent base directory still works (Tauri creates it)', async () => {
  const adapter = createAdapter<TestData>('fresh.json');
  await adapter.setup();
  expect(fileExists('fresh.json')).toBe(true);
});

test('Setup twice with same adapter is idempotent', async () => {
  const adapter = createAdapter<TestData>('double.json');
  await adapter.setup();
  const after_first = readFile('double.json');

  await adapter.setup();
  const after_second = readFile('double.json');

  expect(after_first).toBe(after_second);
});

test('Setup then readAll immediately returns empty array', async () => {
  const adapter = createAdapter<TestData>('empty-check.json');
  await adapter.setup();
  expect(await adapter.readAll()).toEqual([]);
});

test('Teardown resolves', async () => {
  const adapter = createAdapter<TestData>('teardown.json');
  await adapter.setup();
  await expect(adapter.teardown()).resolves.toBeUndefined();
});

// ═══════════════════════════════════════════
// Read edge cases
// ═══════════════════════════════════════════

test('readAll without setup returns empty array gracefully', async () => {
  const adapter = createAdapter<TestData>('unregistered.json');
  expect(await adapter.readAll()).toEqual([]);
});

test('readAll with only whitespace in file returns empty', async () => {
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/whitespace.json`,
    new TextEncoder().encode('   \n\t  ')
  );
  const adapter = createAdapter<TestData>('whitespace.json');
  expect(await adapter.readAll()).toEqual([]);
});

test('readAll file with a single item', async () => {
  const item: TestData = { id: 'only', name: 'lonely', value: 1 };
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/single.json`,
    new TextEncoder().encode(JSON.stringify([item]))
  );
  const adapter = createAdapter<TestData>('single.json');
  expect(await adapter.readAll()).toEqual([item]);
});

test('readAll file with many items', async () => {
  const items: TestData[] = Array.from({ length: 1000 }, (_, i) => ({
    id: `item-${i}`,
    name: `Name ${i}`,
    value: i,
  }));
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/many.json`,
    new TextEncoder().encode(JSON.stringify(items))
  );
  const adapter = createAdapter<TestData>('many.json');
  const result = await adapter.readAll();
  expect(result).toEqual(items);
  expect(result.length).toBe(1000);
});

// ═══════════════════════════════════════════
// Write edge cases
// ═══════════════════════════════════════════

test('Replace-only update keeps other items', async () => {
  const adapter = createAdapter<TestData>('mod-only.json');
  await adapter.setup();

  // Seed data
  const initial: TestData[] = [
    { id: '1', name: 'orig', value: 10 },
    { id: '2', name: 'orig2', value: 20 },
  ];
  await adapter.insert(initial);

  // Modify only
  await adapter.replace([{ id: '1', name: 'CHANGED', value: 999 }]);

  expect(await adapter.readAll()).toEqual([
    { id: '1', name: 'CHANGED', value: 999 },
    { id: '2', name: 'orig2', value: 20 },
  ]);
});

test('Remove-only update keeps other items', async () => {
  const adapter = createAdapter<TestData>('rem-only.json');
  await adapter.setup();

  const initial: TestData[] = [
    { id: '1', name: 'keep', value: 1 },
    { id: '2', name: 'gone', value: 2 },
    { id: '3', name: 'keep2', value: 3 },
  ];
  await adapter.insert(initial);

  await adapter.remove([{ id: '2', name: 'gone', value: 2 }]);

  expect(await adapter.readAll()).toEqual([
    { id: '1', name: 'keep', value: 1 },
    { id: '3', name: 'keep2', value: 3 },
  ]);
});

test('Insert, replace and remove in sequence', async () => {
  const adapter = createAdapter<TestData>('all-changes.json');
  await adapter.setup();

  const initial: TestData[] = [
    { id: '1', name: 'modify-me', value: 1 },
    { id: '2', name: 'remove-me', value: 2 },
    { id: '3', name: 'keep-me', value: 3 },
  ];
  await adapter.insert(initial);

  await adapter.insert([{ id: '4', name: 'NEW', value: 4 }]);
  await adapter.replace([{ id: '1', name: 'MODIFIED', value: 999 }]);
  await adapter.remove([{ id: '2', name: 'remove-me', value: 2 }]);

  expect(await adapter.readAll()).toEqual([
    { id: '1', name: 'MODIFIED', value: 999 },
    { id: '3', name: 'keep-me', value: 3 },
    { id: '4', name: 'NEW', value: 4 },
  ]);
});

test('Removing a non-existent item skips the rewrite', async () => {
  const adapter = createAdapter<TestData>('remove-non-existent.json');
  await adapter.setup();

  const initial: TestData[] = [{ id: '1', name: 'only', value: 1 }];
  await adapter.insert(initial);

  mock_write_file.mockClear();
  // Try to remove an item that doesn't exist
  await adapter.remove([{ id: 'phantom', name: 'ghost', value: -1 }]);

  expect(mock_write_file).not.toHaveBeenCalled();
  expect(await adapter.readAll()).toEqual(initial);
});

test('Replacing a non-existent item upserts it', async () => {
  const adapter = createAdapter<TestData>('mod-non-existent.json');
  await adapter.setup();

  const initial: TestData[] = [{ id: '1', name: 'only', value: 1 }];
  await adapter.insert(initial);

  await adapter.replace([{ id: '2', name: 'upserted', value: 2 }]);

  expect(await adapter.readAll()).toEqual([
    { id: '1', name: 'only', value: 1 },
    { id: '2', name: 'upserted', value: 2 },
  ]);
});

test('Inserting an existing id overwrites instead of duplicating', async () => {
  const adapter = createAdapter<TestData>('insert-upsert.json');
  await adapter.setup();

  await adapter.insert([{ id: '1', name: 'orig', value: 1 }]);
  await adapter.insert([{ id: '1', name: 'overwritten', value: 2 }]);

  expect(await adapter.readAll()).toEqual([
    { id: '1', name: 'overwritten', value: 2 },
  ]);
});

// ═══════════════════════════════════════════
// Data shape edge cases
// ═══════════════════════════════════════════

test('Round-trip data with optional fields', async () => {
  const adapter = createAdapter<TestData>('optional.json');
  await adapter.setup();

  const items: TestData[] = [
    { id: '1', name: 'full', value: 1, extra: 'bonus', nested: { key: 'a', count: 1 }, tags: ['important'] },
    { id: '2', name: 'minimal', value: 2 },
    { id: '3', name: 'partial', value: 3, extra: 'just-extra' },
    { id: '4', name: 'nested', value: 4, nested: { key: 'deep', count: 42 } },
  ];
  await adapter.insert(items);
  expect(await adapter.readAll()).toEqual(items);
});

test('Round-trip data with special characters in strings', async () => {
  const adapter = createAdapter<TestData>('special.json');
  await adapter.setup();

  const items: TestData[] = [
    { id: '1', name: 'new\nline', value: 1 },
    { id: '2', name: 'tab\there', value: 2 },
    { id: '3', name: 'quote"double', value: 3 },
    { id: '4', name: "quote'single", value: 4 },
    { id: '5', name: 'slash/back\\slash', value: 5 },
    { id: '6', name: 'emoji 🎉 fire 🔥', value: 6 },
    { id: '7', name: '日本語 한국어 العربية', value: 7 },
  ];
  await adapter.insert(items);
  expect(await adapter.readAll()).toEqual(items);
});

interface DeepData {
  id: string;
  tree: Record<string, any>;
}

test('Round-trip deeply nested JSON structures', async () => {
  const adapter = createAdapter<DeepData>('deep.json');
  await adapter.setup();

  const deep: Record<string, any> = {};
  let current: Record<string, any> = deep;
  for (let i = 1; i <= 10; i++) {
    current['l' + i] = {};
    current = current['l' + i];
  }
  current.value = 'bottom';

  const items: DeepData[] = [{ id: 'deep', tree: deep }];

  await adapter.insert(items);
  const result = await adapter.readAll();
  expect(result).toEqual(items);
  expect((result[0] as DeepData).tree.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10.value).toBe('bottom');
});

test('Large single item with big string payload', async () => {
  const adapter = createAdapter<TestData>('big-payload.json');
  await adapter.setup();

  const huge_string = 'x'.repeat(100_000);
  const items: TestData[] = [
    { id: 'big', name: huge_string, value: 1 },
    { id: 'small', name: 'tiny', value: 2 },
  ];

  await adapter.insert(items);
  const result = await adapter.readAll();
  expect(result).toEqual(items);
  expect((result[0] as TestData).name.length).toBe(100_000);
});

test('Empty insert is a valid no-op', async () => {
  const adapter = createAdapter<TestData>('zero.json');
  await adapter.setup();

  await adapter.insert([]);
  expect(await adapter.readAll()).toEqual([]);
});

// ═══════════════════════════════════════════
// Encryption edge cases
// ═══════════════════════════════════════════

test('Encryption round-trip with all edge cases', async () => {
  const adapter = createAdapter<TestData>('enc-edge.json', {
    encrypt: async (data) => btoa(unescape(encodeURIComponent(JSON.stringify(data)))),
    decrypt: async (enc) => JSON.parse(decodeURIComponent(escape(atob(enc)))),
  });
  await adapter.setup();

  const items: TestData[] = [
    { id: 'e1', name: 'encrypted 🎉', value: 1 },
    { id: 'e2', name: '日本語', value: 2 },
    { id: 'e3', name: 'special\nchars', value: 3 },
  ];
  await adapter.insert(items);

  // Raw file should be encrypted (base64, not plain JSON)
  const raw = readFile('enc-edge.json');
  expect(() => JSON.parse(raw)).toThrow(); // not valid JSON

  // Read should decrypt correctly
  expect(await adapter.readAll()).toEqual(items);
});

test('Allow plaintext fallback when decrypt fails', async () => {
  const plain_items: TestData[] = [{ id: 'p1', name: 'plain', value: 1 }];
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/fallback.json`,
    new TextEncoder().encode(JSON.stringify(plain_items))
  );

  const adapter = createAdapter<TestData>('fallback.json', {
    encrypt: async (data) => 'enc:' + JSON.stringify(data),
    decrypt: async (enc) => {
      if (!enc.startsWith('enc:')) throw new Error('Invalid format');
      return JSON.parse(enc.slice(4));
    },
    security: { allowPlaintextFallback: true },
  });

  expect(await adapter.readAll()).toEqual(plain_items);
});

test('Custom dataValidator rejects invalid shapes', async () => {
  const validator = <T>(data: unknown): data is T[] => {
    if (!Array.isArray(data)) return false;
    return data.every((item: any) =>
      typeof item === 'object' && item !== null &&
      typeof item.id === 'string' && item.id.length > 0 &&
      typeof item.name === 'string' &&
      typeof item.value === 'number'
    );
  };

  const bad_data = [{ id: '1', name: 'ok' }]; // missing value
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/validate.json`,
    new TextEncoder().encode(JSON.stringify(bad_data))
  );

  const adapter = createAdapter<TestData>('validate.json', {
    security: { validateDecryptedData: true, dataValidator: validator },
  });

  await expect(adapter.readAll()).rejects.toThrow('Data failed validation');
});

// ═══════════════════════════════════════════
// Write-without-setup & lifecycle order
// ═══════════════════════════════════════════

test('Insert without setup works (finds the existing file)', async () => {
  // Pre-populate the file
  const existing: TestData[] = [{ id: 'x', name: 'old', value: 1 }];
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/no-reg.json`,
    new TextEncoder().encode(JSON.stringify(existing))
  );

  const adapter = createAdapter<TestData>('no-reg.json');
  await adapter.insert([{ id: 'y', name: 'added', value: 2 }]);
  await adapter.replace([{ id: 'x', name: 'updated', value: 1 }]);

  expect(await adapter.readAll()).toEqual([
    { id: 'x', name: 'updated', value: 1 },
    { id: 'y', name: 'added', value: 2 },
  ]);
});

test('Insert without setup on non-existent file creates data', async () => {
  const adapter = createAdapter<TestData>('orphan.json');
  const data: TestData[] = [{ id: 'o', name: 'orphan', value: 1 }];

  // Guard read returns empty since the file doesn't exist, then upsert adds it.
  await adapter.insert(data);

  expect(await adapter.readAll()).toEqual(data);
});

// ═══════════════════════════════════════════
// Base directory isolation
// ═══════════════════════════════════════════

test('Adapters with different filenames are fully isolated', async () => {
  const a = createAdapter<TestData>('alpha.json');
  const b = createAdapter<TestData>('beta.json');

  await a.setup();
  await b.setup();

  const data_a: TestData[] = [{ id: 'a', name: 'alpha', value: 1 }];
  const data_b: TestData[] = [{ id: 'b', name: 'beta', value: 2 }];

  await a.insert(data_a);
  await b.insert(data_b);

  expect(await a.readAll()).toEqual(data_a);
  expect(await b.readAll()).toEqual(data_b);

  // Verify files exist separately in mock filesystem
  expect(fileExists('alpha.json')).toBe(true);
  expect(fileExists('beta.json')).toBe(true);
  expect(readFile('alpha.json')).not.toBe(readFile('beta.json'));
});

// ═══════════════════════════════════════════
// Stress: rapid sequential writes
// ═══════════════════════════════════════════

test('Rapid sequential inserts maintain data integrity', async () => {
  const adapter = createAdapter<TestData>('rapid.json');
  await adapter.setup();

  for (let i = 0; i < 50; i++) {
    await adapter.insert([{ id: `${i}`, name: `iter-${i}`, value: i }]);
  }

  const result = await adapter.readAll();
  expect(result.length).toBe(50);
  expect(result[49].name).toBe('iter-49');
});

test('Rapid sequential replaces of one id: last write wins', async () => {
  const adapter = createAdapter<TestData>('rapid-replace.json');
  await adapter.setup();

  await adapter.insert([{ id: 'one', name: 'iter-0', value: 0 }]);
  for (let i = 1; i < 50; i++) {
    await adapter.replace([{ id: 'one', name: `iter-${i}`, value: i }]);
  }

  const result = await adapter.readAll();
  expect(result.length).toBe(1);
  expect(result[0].name).toBe('iter-49');
});

// ═══════════════════════════════════════════
// File overwrite behavior
// ═══════════════════════════════════════════

test('removeAll then insert replaces file completely, not appends', async () => {
  const adapter = createAdapter<TestData>('overwrite.json');
  await adapter.setup();

  // First insert with 3 items
  const first: TestData[] = [
    { id: '1', name: 'a', value: 1 },
    { id: '2', name: 'b', value: 2 },
    { id: '3', name: 'c', value: 3 },
  ];
  await adapter.insert(first);

  // Clear and insert 1 completely different item
  await adapter.removeAll();
  await adapter.insert([{ id: 'x', name: 'different', value: 99 }]);

  const result = await adapter.readAll();
  expect(result.length).toBe(1);
  expect(result[0].id).toBe('x');
});
