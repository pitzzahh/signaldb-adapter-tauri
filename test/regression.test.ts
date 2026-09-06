/**
 * Regression tests for known adapter issues.
 * Tests that were failing before the fixes and now verify correct behavior.
 */
import { test, expect, beforeEach, mock } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

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

const { adapter } = await import('../src/index');

// Suppress warnings and reset mock state for cleaner output
beforeEach(() => {
  mock_file_system.clear();
  console.warn = () => {};
  // Reset mock implementations to defaults
  mock_read_file.mockImplementation(async (filename: string, options?: { baseDir?: BaseDirectory }) => {
    const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
    const content = mock_file_system.get(`${base_dir}/${filename}`);
    if (!content) throw new Error(`File not found: ${filename}`);
    return content;
  });
});

test('Backup cleanup respects maxBackups limit', async () => {
  const adapter = adapter<TestData>('test.json', {
    security: { createBackups: true, maxBackups: 2 }
  });
  await adapter.register(mock());

  for (let i = 0; i < 5; i++) {
    const data: TestData[] = [{ id: `${i}`, name: `save${i}`, value: i }];
    mock_file_system.set(
      `${BaseDirectory.AppLocalData}/test.json`,
      new TextEncoder().encode(JSON.stringify(data))
    );
    await adapter.save(data, { added: data, modified: [], removed: [] });
    await new Promise(r => setTimeout(r, 2)); // ensure unique backup filenames
  }

  const backup_count = Array.from(mock_file_system.keys())
    .filter(k => k.includes('.backup.')).length;

  expect(backup_count).toBeLessThanOrEqual(2);
});

test('Save throws instead of silently destroying data when load fails', async () => {
  const adapter = adapter<TestData>('test.json');
  await adapter.register(mock());

  // Pre-populate with valuable data
  const existing: TestData[] = [
    { id: 'a', name: 'keep1', value: 1 },
    { id: 'b', name: 'keep2', value: 2 },
    { id: 'c', name: 'keep3', value: 3 },
  ];
  await adapter.save(existing, { added: existing, modified: [], removed: [] });

  // Simulate a transient read failure when loading the main data file during save
  mock_read_file.mockImplementation(async (filename: string, options?: { baseDir?: BaseDirectory }) => {
    // Throw only when reading the main data file, not temp files
    if (filename === 'test.json') {
      throw new Error('EIO: transient filesystem error');
    }
    const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
    const content = mock_file_system.get(`${base_dir}/${filename}`);
    if (!content) throw new Error(`File not found: ${filename}`);
    return content;
  });

  // Save should throw rather than silently destroy data
  const new_item: TestData[] = [{ id: 'd', name: 'new', value: 4 }];

  let save_threw = false;
  try {
    await adapter.save(new_item, { added: new_item, modified: [], removed: [] });
  } catch (err: any) {
    save_threw = true;
    expect(err.message).toContain('Refusing to save to prevent data loss');
  }
  expect(save_threw).toBe(true);

  // Original data should still be intact on disk. Reset mock and verify
  mock_read_file.mockImplementation(async (filename: string, options?: { baseDir?: BaseDirectory }) => {
    const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
    const content = mock_file_system.get(`${base_dir}/${filename}`);
    if (!content) throw new Error(`File not found: ${filename}`);
    return content;
  });
  const result = await adapter.load();
  expect(result.items?.length).toBe(3);
  expect(result.items).toEqual(existing);
});

test('Concurrent full-state saves are atomic: last write wins cleanly', async () => {
  const adapter = adapter<TestData>('test.json');
  await adapter.register(mock());

  // Concurrent saves, each saving a full independent dataset.
  // With atomic rename, the last one to complete wins without corruption.
  const ops: Promise<void>[] = [];
  for (let i = 1; i <= 5; i++) {
    const data: TestData[] = [
      { id: `${i}-a`, name: `item-a-${i}`, value: i },
      { id: `${i}-b`, name: `item-b-${i}`, value: i * 10 },
    ];
    ops.push(adapter.save(data, { added: data, modified: [], removed: [] }));
  }
  await Promise.all(ops);

  // Final state should be exactly one complete dataset (the last write that won),
  // not a corrupted mix of partial writes.
  const result = await adapter.load();
  expect(result.items).toBeDefined();
  expect(Array.isArray(result.items)).toBe(true);
  expect(result.items!.length).toBe(2); // exactly 2 items from one winner

  // All items should belong to the same save batch (same `i` prefix)
  const prefixes = new Set(result.items!.map((item: TestData) => item.id.split('-')[0]));
  expect(prefixes.size).toBe(1); // all from the same batch, no mixed corruption

  // Data should be valid JSON, not corrupted
  for (const item of result.items!) {
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('value');
  }
});
