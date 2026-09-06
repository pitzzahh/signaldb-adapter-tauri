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
  open: mock(async () => ({ write: mock(), close: mock(), truncate: mock() })),
}));

const { createTauriFileSystemAdapter } = await import('../src/index');

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
  captureWarnings();
});

afterEach(() => {
  restoreWarnings();
});

// ═══════════════════════════════════════════
// Register edge cases
// ═══════════════════════════════════════════

test('Register with non-existent base directory still works (Tauri creates it)', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('fresh.json');
  await adapter.register(mock());
  expect(fileExists('fresh.json')).toBe(true);
});

test('Register twice with same adapter is idempotent', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('double.json');
  await adapter.register(mock());
  const after_first = readFile('double.json');

  await adapter.register(mock());
  const after_second = readFile('double.json');

  expect(after_first).toBe(after_second);
});

test('Register then load immediately returns empty array', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('empty-check.json');
  await adapter.register(mock());
  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

test('Register does not call callback when file is empty', async () => {
  let called = false;
  const adapter = createTauriFileSystemAdapter<TestData>('no-callback.json');
  await adapter.register(() => { called = true; });
  expect(called).toBe(false);
});

// ═══════════════════════════════════════════
// Load edge cases
// ═══════════════════════════════════════════

test('Load without register returns empty array gracefully', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('unregistered.json');
  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

test('Load with only whitespace in file returns empty', async () => {
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/whitespace.json`,
    new TextEncoder().encode('   \n\t  ')
  );
  const adapter = createTauriFileSystemAdapter<TestData>('whitespace.json');
  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

test('Load file with a single item', async () => {
  const item: TestData = { id: 'only', name: 'lonely', value: 1 };
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/single.json`,
    new TextEncoder().encode(JSON.stringify([item]))
  );
  const adapter = createTauriFileSystemAdapter<TestData>('single.json');
  const result = await adapter.load();
  expect(result.items).toEqual([item]);
});

test('Load file with many items', async () => {
  const items: TestData[] = Array.from({ length: 1000 }, (_, i) => ({
    id: `item-${i}`,
    name: `Name ${i}`,
    value: i,
  }));
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/many.json`,
    new TextEncoder().encode(JSON.stringify(items))
  );
  const adapter = createTauriFileSystemAdapter<TestData>('many.json');
  const result = await adapter.load();
  expect(result.items).toEqual(items);
  expect(result.items!.length).toBe(1000);
});

// ═══════════════════════════════════════════
// Save edge cases
// ═══════════════════════════════════════════

test('Save with only modified items (no added/removed)', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('mod-only.json');
  await adapter.register(mock());

  // Seed data
  const initial: TestData[] = [
    { id: '1', name: 'orig', value: 10 },
    { id: '2', name: 'orig2', value: 20 },
  ];
  await adapter.save(initial, { added: initial, modified: [], removed: [] });

  // Modify only
  const modified: TestData[] = [
    { id: '1', name: 'CHANGED', value: 999 },
  ];
  const expected: TestData[] = [
    { id: '1', name: 'CHANGED', value: 999 },
    { id: '2', name: 'orig2', value: 20 },
  ];
  await adapter.save(expected, { added: [], modified, removed: [] });

  const result = await adapter.load();
  expect(result.items).toEqual(expected);
});

test('Save with only removed items (no added/modified)', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('rem-only.json');
  await adapter.register(mock());

  const initial: TestData[] = [
    { id: '1', name: 'keep', value: 1 },
    { id: '2', name: 'gone', value: 2 },
    { id: '3', name: 'keep2', value: 3 },
  ];
  await adapter.save(initial, { added: initial, modified: [], removed: [] });

  const removed: TestData[] = [{ id: '2', name: 'gone', value: 2 }];
  const expected: TestData[] = [
    { id: '1', name: 'keep', value: 1 },
    { id: '3', name: 'keep2', value: 3 },
  ];
  await adapter.save(expected, { added: [], modified: [], removed });

  const result = await adapter.load();
  expect(result.items).toEqual(expected);
});

test('Save all three change types simultaneously', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('all-changes.json');
  await adapter.register(mock());

  const initial: TestData[] = [
    { id: '1', name: 'modify-me', value: 1 },
    { id: '2', name: 'remove-me', value: 2 },
    { id: '3', name: 'keep-me', value: 3 },
  ];
  await adapter.save(initial, { added: initial, modified: [], removed: [] });

  const expected: TestData[] = [
    { id: '1', name: 'MODIFIED', value: 999 },
    { id: '3', name: 'keep-me', value: 3 },
    { id: '4', name: 'NEW', value: 4 },
  ];
  await adapter.save(expected, {
    added: [{ id: '4', name: 'NEW', value: 4 }],
    modified: [{ id: '1', name: 'MODIFIED', value: 999 }],
    removed: [{ id: '2', name: 'remove-me', value: 2 }],
  });

  const result = await adapter.load();
  expect(result.items).toEqual(expected);
});

test('Removing a non-existent item is a no-op', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('remove-non-existent.json');
  await adapter.register(mock());

  const initial: TestData[] = [{ id: '1', name: 'only', value: 1 }];
  await adapter.save(initial, { added: initial, modified: [], removed: [] });

  // Try to remove an item that doesn't exist
  await adapter.save(initial, {
    added: [],
    modified: [],
    removed: [{ id: 'phantom', name: 'ghost', value: -1 }],
  });

  const result = await adapter.load();
  expect(result.items).toEqual(initial);
});

test('Modifying a non-existent item is ignored', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('mod-non-existent.json');
  await adapter.register(mock());

  const initial: TestData[] = [{ id: '1', name: 'only', value: 1 }];
  await adapter.save(initial, { added: initial, modified: [], removed: [] });

  const expected: TestData[] = [
    { id: '1', name: 'only', value: 1 },
    { id: '2', name: 'unexpected', value: 2 },
  ];

  // Try to modify phantom; integrity check should catch mismatch → full save
  await adapter.save(expected, {
    added: [{ id: '2', name: 'unexpected', value: 2 }],
    modified: [{ id: 'phantom', name: 'ghost', value: -1 }],
    removed: [],
  });

  const result = await adapter.load();
  expect(result.items).toEqual(expected);
});

// ═══════════════════════════════════════════
// Data shape edge cases
// ═══════════════════════════════════════════

test('Round-trip data with optional fields', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('optional.json');
  await adapter.register(mock());

  const items: TestData[] = [
    { id: '1', name: 'full', value: 1, extra: 'bonus', nested: { key: 'a', count: 1 }, tags: ['important'] },
    { id: '2', name: 'minimal', value: 2 },
    { id: '3', name: 'partial', value: 3, extra: 'just-extra' },
    { id: '4', name: 'nested', value: 4, nested: { key: 'deep', count: 42 } },
  ];
  await adapter.save(items, { added: items, modified: [], removed: [] });
  const result = await adapter.load();
  expect(result.items).toEqual(items);
});

test('Round-trip data with special characters in strings', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('special.json');
  await adapter.register(mock());

  const items: TestData[] = [
    { id: '1', name: 'new\nline', value: 1 },
    { id: '2', name: 'tab\there', value: 2 },
    { id: '3', name: 'quote"double', value: 3 },
    { id: '4', name: "quote'single", value: 4 },
    { id: '5', name: 'slash/back\\slash', value: 5 },
    { id: '6', name: 'emoji 🎉 fire 🔥', value: 6 },
    { id: '7', name: '日本語 한국어 العربية', value: 7 },
  ];
  await adapter.save(items, { added: items, modified: [], removed: [] });
  const result = await adapter.load();
  expect(result.items).toEqual(items);
});

interface DeepData {
  id: string;
  tree: Record<string, any>;
}

test('Round-trip deeply nested JSON structures', async () => {
  const adapter = createTauriFileSystemAdapter<DeepData>('deep.json');
  await adapter.register(mock());

  const deep: Record<string, any> = {};
  let current: Record<string, any> = deep;
  for (let i = 1; i <= 10; i++) {
    current['l' + i] = {};
    current = current['l' + i];
  }
  current.value = 'bottom';

  const items: DeepData[] = [{ id: 'deep', tree: deep }];

  await adapter.save(items, { added: items, modified: [], removed: [] });
  const result = await adapter.load();
  expect(result.items).toEqual(items);
  expect((result.items![0] as DeepData).tree.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10.value).toBe('bottom');
});

test('Large single item with big string payload', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('big-payload.json');
  await adapter.register(mock());

  const huge_string = 'x'.repeat(100_000);
  const items: TestData[] = [
    { id: 'big', name: huge_string, value: 1 },
    { id: 'small', name: 'tiny', value: 2 },
  ];

  await adapter.save(items, { added: items, modified: [], removed: [] });
  const result = await adapter.load();
  expect(result.items).toEqual(items);
  expect((result.items![0] as TestData).name.length).toBe(100_000);
});

test('Zero items save is valid', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('zero.json');
  await adapter.register(mock());

  await adapter.save([], { added: [], modified: [], removed: [] });
  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

// ═══════════════════════════════════════════
// Encryption edge cases
// ═══════════════════════════════════════════

test('Encryption round-trip with all edge cases', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('enc-edge.json', {
    encrypt: async (data) => btoa(unescape(encodeURIComponent(JSON.stringify(data)))),
    decrypt: async (enc) => JSON.parse(decodeURIComponent(escape(atob(enc)))),
  });
  await adapter.register(mock());

  const items: TestData[] = [
    { id: 'e1', name: 'encrypted 🎉', value: 1 },
    { id: 'e2', name: '日本語', value: 2 },
    { id: 'e3', name: 'special\nchars', value: 3 },
  ];
  await adapter.save(items, { added: items, modified: [], removed: [] });

  // Raw file should be encrypted (base64, not plain JSON)
  const raw = readFile('enc-edge.json');
  expect(() => JSON.parse(raw)).toThrow(); // not valid JSON

  // Load should decrypt correctly
  const result = await adapter.load();
  expect(result.items).toEqual(items);
});

test('Allow plaintext fallback when decrypt fails', async () => {
  const plain_items: TestData[] = [{ id: 'p1', name: 'plain', value: 1 }];
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/fallback.json`,
    new TextEncoder().encode(JSON.stringify(plain_items))
  );

  const adapter = createTauriFileSystemAdapter<TestData>('fallback.json', {
    encrypt: async (data) => 'enc:' + JSON.stringify(data),
    decrypt: async (enc) => {
      if (!enc.startsWith('enc:')) throw new Error('Invalid format');
      return JSON.parse(enc.slice(4));
    },
    security: { allowPlaintextFallback: true },
  });

  const result = await adapter.load();
  expect(result.items).toEqual(plain_items);
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

  const adapter = createTauriFileSystemAdapter<TestData>('validate.json', {
    security: { validateDecryptedData: true, dataValidator: validator },
  });

  expect(adapter.load()).rejects.toThrow('Data failed validation');
});

// ═══════════════════════════════════════════
// Unregister & callback lifecycle
// ═══════════════════════════════════════════

test('Unregister then save does not call callback', async () => {
  let call_count = 0;
  const adapter = createTauriFileSystemAdapter<TestData>('unreg-callback.json');
  await adapter.register(() => { call_count++; });
  await adapter.unregister?.();

  const data: TestData[] = [{ id: '1', name: 'after', value: 1 }];
  await adapter.save(data, { added: data, modified: [], removed: [] });

  expect(call_count).toBe(0);
});

test('Register with data already on disk fires callback', async () => {
  const existing: TestData[] = [{ id: 'pre', name: 'existing', value: 42 }];
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/pre-existing.json`,
    new TextEncoder().encode(JSON.stringify(existing))
  );

  let callback_data: any = null;
  const adapter = createTauriFileSystemAdapter<TestData>('pre-existing.json');
  await adapter.register((data) => { callback_data = data; });

  expect(callback_data).toEqual({ items: existing });
});

test('Multiple saves only call callback for registered adapter', async () => {
  let a_calls = 0, b_calls = 0;

  const a = createTauriFileSystemAdapter<TestData>('a.json');
  const b = createTauriFileSystemAdapter<TestData>('b.json');

  await a.register(() => { a_calls++; });
  await b.register(() => { b_calls++; });

  const data: TestData[] = [{ id: '1', name: 'test', value: 1 }];
  await a.save(data, { added: data, modified: [], removed: [] });
  await b.save(data, { added: data, modified: [], removed: [] });

  expect(a_calls).toBe(1);
  expect(b_calls).toBe(1);
});

// ═══════════════════════════════════════════
// Save-without-register & lifecycle order
// ═══════════════════════════════════════════

test('Save without register works (relies on load finding the file)', async () => {
  // Pre-populate the file
  const existing: TestData[] = [{ id: 'x', name: 'old', value: 1 }];
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/no-reg.json`,
    new TextEncoder().encode(JSON.stringify(existing))
  );

  const adapter = createTauriFileSystemAdapter<TestData>('no-reg.json');
  const new_item: TestData[] = [
    { id: 'x', name: 'updated', value: 1 },
    { id: 'y', name: 'added', value: 2 },
  ];
  await adapter.save(new_item, { added: [{ id: 'y', name: 'added', value: 2 }], modified: [{ id: 'x', name: 'updated', value: 1 }], removed: [] });

  const result = await adapter.load();
  expect(result.items).toEqual(new_item);
});

test('Save without register on non-existent file creates data', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('orphan.json');
  const data: TestData[] = [{ id: 'o', name: 'orphan', value: 1 }];

  // load() will return empty since file doesn't exist
  // then changes.added adds the item → integrity check passes → save works
  await adapter.save(data, { added: data, modified: [], removed: [] });

  const result = await adapter.load();
  expect(result.items).toEqual(data);
});

// ═══════════════════════════════════════════
// Incremental update integrity checks
// ═══════════════════════════════════════════

test('Fallback to full save when changes result in wrong item count', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('count-mismatch.json');
  await adapter.register(mock());

  const initial: TestData[] = [
    { id: '1', name: 'a', value: 1 },
    { id: '2', name: 'b', value: 2 },
  ];
  await adapter.save(initial, { added: initial, modified: [], removed: [] });

  // Provide changes that would result in 3 items but items array says 2
  const items: TestData[] = [
    { id: '1', name: 'a', value: 1 },
    { id: '3', name: 'c', value: 3 },
  ];
  // change says add item 3 and remove item 2 resulting in {1,3} = 2 items
  // but if we claim to remove id '2' AND not add '3'... mismatch
  await adapter.save(items, {
    added: [{ id: '3', name: 'c', value: 3 }],
    modified: [],
    removed: [{ id: '2', name: 'b', value: 2 }],
  });

  const result = await adapter.load();
  expect(result.items).toEqual(items);
});

test('Fallback to full save when changes produce wrong IDs', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('id-mismatch.json');
  await adapter.register(mock());

  const initial: TestData[] = [
    { id: '1', name: 'a', value: 1 },
    { id: '2', name: 'b', value: 2 },
  ];
  await adapter.save(initial, { added: initial, modified: [], removed: [] });

  // Changes would produce IDs {2, 3} but items say {1, 3}
  const expected: TestData[] = [
    { id: '1', name: 'a', value: 1 },
    { id: '3', name: 'c', value: 3 },
  ];
  // These changes would produce {2, 3}, a mismatch, so it falls back
  await adapter.save(expected, {
    added: [{ id: '3', name: 'c', value: 3 }],
    modified: [],
    removed: [{ id: '1', name: 'a', value: 1 }],
  });

  const result = await adapter.load();
  expect(result.items).toEqual(expected);
});

// ═══════════════════════════════════════════
// Base directory isolation
// ═══════════════════════════════════════════

test('Adapters with different filenames are fully isolated', async () => {
  const a = createTauriFileSystemAdapter<TestData>('alpha.json');
  const b = createTauriFileSystemAdapter<TestData>('beta.json');

  await a.register(mock());
  await b.register(mock());

  const data_a: TestData[] = [{ id: 'a', name: 'alpha', value: 1 }];
  const data_b: TestData[] = [{ id: 'b', name: 'beta', value: 2 }];

  await a.save(data_a, { added: data_a, modified: [], removed: [] });
  await b.save(data_b, { added: data_b, modified: [], removed: [] });

  expect((await a.load()).items).toEqual(data_a);
  expect((await b.load()).items).toEqual(data_b);

  // Verify files exist separately in mock filesystem
  expect(fileExists('alpha.json')).toBe(true);
  expect(fileExists('beta.json')).toBe(true);
  expect(readFile('alpha.json')).not.toBe(readFile('beta.json'));
});

// ═══════════════════════════════════════════
// Stress: rapid sequential saves
// ═══════════════════════════════════════════

test('Rapid sequential saves maintain data integrity', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('rapid.json');
  await adapter.register(mock());

  for (let i = 0; i < 50; i++) {
    const data: TestData[] = [{ id: `${i}`, name: `iter-${i}`, value: i }];
    await adapter.save(data, { added: data, modified: [], removed: [] });
  }

  const result = await adapter.load();
  expect(result.items!.length).toBe(1);
  expect(result.items![0].name).toBe('iter-49'); // last save wins
});

// ═══════════════════════════════════════════
// Empty changes handling
// ═══════════════════════════════════════════

test('Save with undefined changes array works', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('undef-changes.json');
  await adapter.register(mock());

  const data: TestData[] = [{ id: '1', name: 'test', value: 1 }];
  // @ts-expect-error testing edge case
  await adapter.save(data, { added: undefined, modified: undefined, removed: undefined });

  const result = await adapter.load();
  expect(result.items).toEqual(data);
});

test('Save with null changes array works', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('null-changes.json');
  await adapter.register(mock());

  const data: TestData[] = [{ id: '1', name: 'test', value: 1 }];
  // @ts-expect-error testing edge case
  await adapter.save(data, { added: null, modified: null, removed: null });

  const result = await adapter.load();
  expect(result.items).toEqual(data);
});

// ═══════════════════════════════════════════
// File overwrite behavior
// ═══════════════════════════════════════════

test('Saving replaces file completely, not appends', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('overwrite.json');
  await adapter.register(mock());

  // First save with 3 items
  const first: TestData[] = [
    { id: '1', name: 'a', value: 1 },
    { id: '2', name: 'b', value: 2 },
    { id: '3', name: 'c', value: 3 },
  ];
  await adapter.save(first, { added: first, modified: [], removed: [] });

  // Second save with 1 completely different item
  const second: TestData[] = [{ id: 'x', name: 'different', value: 99 }];
  await adapter.save(second, { added: second, modified: [], removed: first });

  const result = await adapter.load();
  expect(result.items!.length).toBe(1);
  expect(result.items![0].id).toBe('x');
});
