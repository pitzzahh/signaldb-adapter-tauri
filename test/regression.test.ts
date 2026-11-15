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
}));

const { adapter: createAdapter } = await import('../src/index');

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
  const adapter = createAdapter<TestData>('test.json', {
    security: { createBackups: true, maxBackups: 2 }
  });
  await adapter.setup();

  for (let i = 0; i < 5; i++) {
    const data: TestData[] = [{ id: `${i}`, name: `save${i}`, value: i }];
    mock_file_system.set(
      `${BaseDirectory.AppLocalData}/test.json`,
      new TextEncoder().encode(JSON.stringify(data))
    );
    await adapter.insert(data);
  }

  const backup_count = Array.from(mock_file_system.keys())
    .filter(k => k.includes('.backup.')).length;

  expect(backup_count).toBeLessThanOrEqual(2);
});

test('Insert throws instead of silently destroying data when the read fails', async () => {
  const adapter = createAdapter<TestData>('test.json');
  await adapter.setup();

  // Pre-populate with valuable data
  const existing: TestData[] = [
    { id: 'a', name: 'keep1', value: 1 },
    { id: 'b', name: 'keep2', value: 2 },
    { id: 'c', name: 'keep3', value: 3 },
  ];
  await adapter.insert(existing);

  // Simulate a transient read failure when reading the main data file during insert
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

  // Insert should throw rather than silently destroy data
  const new_item: TestData[] = [{ id: 'd', name: 'new', value: 4 }];

  let insert_threw = false;
  try {
    await adapter.insert(new_item);
  } catch (err: any) {
    insert_threw = true;
    expect(err.message).toContain('refusing to write to prevent data loss');
  }
  expect(insert_threw).toBe(true);

  // Original data should still be intact on disk. Reset mock and verify
  mock_read_file.mockImplementation(async (filename: string, options?: { baseDir?: BaseDirectory }) => {
    const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
    const content = mock_file_system.get(`${base_dir}/${filename}`);
    if (!content) throw new Error(`File not found: ${filename}`);
    return content;
  });
  const result = await adapter.readAll();
  expect(result.length).toBe(3);
  expect(result).toEqual(existing);
});

test('Concurrent inserts are atomic: nothing lost, nothing mixed', async () => {
  const adapter = createAdapter<TestData>('test.json');
  await adapter.setup();

  // Concurrent inserts, each with an independent batch.
  // Serialization means every batch lands whole: no lost items,
  // no torn files, no interleaved read-modify-write.
  const ops: Promise<void>[] = [];
  for (let i = 1; i <= 5; i++) {
    const data: TestData[] = [
      { id: `${i}-a`, name: `item-a-${i}`, value: i },
      { id: `${i}-b`, name: `item-b-${i}`, value: i * 10 },
    ];
    ops.push(adapter.insert(data));
  }
  await Promise.all(ops);

  // Final state holds all five batches complete.
  const result = await adapter.readAll();
  expect(result).toBeDefined();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(10);

  // Every batch arrived whole: both items of each `i` pair present.
  for (let i = 1; i <= 5; i++) {
    expect(result).toContainEqual({ id: `${i}-a`, name: `item-a-${i}`, value: i });
    expect(result).toContainEqual({ id: `${i}-b`, name: `item-b-${i}`, value: i * 10 });
  }

  // Data should be valid, not corrupted
  for (const item of result) {
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('value');
  }
});
