import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

// Test data interface
interface TestData {
  id: string;
  name: string;
  value: number;
}

// Mock filesystem state - this simulates the actual file system
const mock_file_system = new Map<string, Uint8Array>();

// Mock functions for the Tauri filesystem plugin
const mock_exists = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<boolean> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  const full_path = `${base_dir}/${filename}`;
  return mock_file_system.has(full_path);
});

const mock_read_file = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<Uint8Array> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  const full_path = `${base_dir}/${filename}`;
  const content = mock_file_system.get(full_path);
  if (!content) {
    throw new Error(`File not found: ${filename}`);
  }
  return content;
});

const mock_write_file = mock(async (filename: string, data: Uint8Array, options?: { baseDir?: BaseDirectory }): Promise<void> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  const full_path = `${base_dir}/${filename}`;
  mock_file_system.set(full_path, data);
});

const mock_remove = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<void> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  const full_path = `${base_dir}/${filename}`;
  mock_file_system.delete(full_path);
});

// Mock only the filesystem functions, keep BaseDirectory as-is
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

// Import after mocking
const { adapter: createAdapter } = await import('../src/index');

// Global warning suppression for cleaner test output
let originalConsoleWarn: typeof console.warn;

beforeEach(() => {
  // Clear the mock filesystem and reset mock calls before each test
  mock_file_system.clear();
  mock_exists.mockClear();
  mock_read_file.mockClear();
  mock_write_file.mockClear();
  mock_remove.mockClear();
  mock_read_dir.mockClear();
  mock_rename_fn.mockClear();

  // Suppress non-critical warnings for cleaner test output
  originalConsoleWarn = console.warn;
  console.warn = (...args: any[]) => {
    const message = args.join(' ');
    // Only suppress specific expected warnings
    if (message.includes('[SECURITY]') ||
      message.includes('Failed to create backup')) {
      return; // Suppress these expected warnings
    }
    originalConsoleWarn(...args); // Show other warnings
  };
});

// Add afterEach to restore console.warn
afterEach(() => {
  if (originalConsoleWarn) {
    console.warn = originalConsoleWarn;
  }
});

test('Basic adapter functionality', () => {
  const adapter = createAdapter<TestData>('test.json');

  // Test that adapter is created with the StorageAdapter interface
  expect(adapter).toBeDefined();

  for (const method of ['setup', 'teardown', 'readAll', 'readIds', 'createIndex', 'dropIndex', 'readIndex', 'insert', 'replace', 'remove', 'removeAll']) {
    expect(adapter).toHaveProperty(method);
    expect(typeof (adapter as any)[method]).toBe('function');
  }
  expect(adapter.query).toBeUndefined(); // whole-file store, no pushdown
});

test('Setup creates initial empty file in AppLocalData', async () => {
  const adapter = createAdapter<TestData>('test.json');

  // Before setup, file should not exist
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/test.json`)).toBe(false);

  await adapter.setup();

  // After setup, file should exist with empty array
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/test.json`)).toBe(true);

  const file_content = mock_file_system.get(`${BaseDirectory.AppLocalData}/test.json`)!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe('[]');

  // Verify the correct Tauri functions were called
  expect(mock_exists).toHaveBeenCalledWith('test.json', { baseDir: BaseDirectory.AppLocalData });
  expect(mock_write_file).toHaveBeenCalled();
});

test('Setup does not overwrite existing file', async () => {
  const adapter = createAdapter<TestData>('test.json');

  // Pre-populate the mock filesystem with existing data
  const existing_data = '[{"id": "1", "name": "existing"}]';
  mock_file_system.set(`${BaseDirectory.AppLocalData}/test.json`, new TextEncoder().encode(existing_data));

  await adapter.setup();

  // File should remain unchanged
  const file_content = mock_file_system.get(`${BaseDirectory.AppLocalData}/test.json`)!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe(existing_data);

  // Verify exists was called but writeFile was not called
  expect(mock_exists).toHaveBeenCalledWith('test.json', { baseDir: BaseDirectory.AppLocalData });
  expect(mock_write_file).not.toHaveBeenCalled();
});

test('Insert and readAll round-trip correctly', async () => {
  const adapter = createAdapter<TestData>('users.json');

  const test_data: TestData[] = [
    { id: '1', name: 'John Doe', value: 100 },
    { id: '2', name: 'Jane Smith', value: 200 },
  ];

  await adapter.setup();
  await adapter.insert(test_data);

  // Check that data was actually written to the mock filesystem
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/users.json`)).toBe(true);

  const file_content = mock_file_system.get(`${BaseDirectory.AppLocalData}/users.json`)!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe(JSON.stringify(test_data));

  // Load and verify the data comes back correctly
  const items = await adapter.readAll();
  expect(items).toEqual(test_data);

  // Verify the correct Tauri functions were called
  expect(mock_write_file).toHaveBeenCalled();
  expect(mock_read_file).toHaveBeenCalledWith('users.json', { baseDir: BaseDirectory.AppLocalData });
});

test('Uses custom base directory', async () => {
  const adapter = createAdapter<TestData>('config.json', {
    base_dir: BaseDirectory.AppConfig
  });

  await adapter.setup();

  // Check that file was created in AppConfig directory
  expect(mock_file_system.has(`${BaseDirectory.AppConfig}/config.json`)).toBe(true);
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/config.json`)).toBe(false);

  const file_content = mock_file_system.get(`${BaseDirectory.AppConfig}/config.json`)!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe('[]');

  // Verify the correct base directory was used
  expect(mock_exists).toHaveBeenCalledWith('config.json', { baseDir: BaseDirectory.AppConfig });
});

test('readAll handles non-existent file', async () => {
  const adapter = createAdapter<TestData>('nonexistent.json');

  // File should not exist in filesystem
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/nonexistent.json`)).toBe(false);

  const result = await adapter.readAll();
  expect(result).toEqual([]);

  // Verify readFile was called and handled the file not found error
  expect(mock_read_file).toHaveBeenCalledWith('nonexistent.json', { baseDir: BaseDirectory.AppLocalData });
  // Known "not found" wording needs no extra exists() round trip.
  expect(mock_exists).not.toHaveBeenCalled();
});

test('readAll treats unknown read errors as missing when exists() says so', async () => {
  const adapter = createAdapter<TestData>('odd-backend.json');

  // A backend whose "not found" wording matches nothing known.
  mock_read_file.mockImplementationOnce(async () => {
    throw new Error('E_UNKNOWN_SOMETHING');
  });

  // File is absent, so exists() reports false and the read resolves empty.
  expect(await adapter.readAll()).toEqual([]);
  expect(mock_exists).toHaveBeenCalledWith('odd-backend.json', { baseDir: BaseDirectory.AppLocalData });
});

test('readAll rethrows unknown read errors when the file exists', async () => {
  mock_file_system.set(
    `${BaseDirectory.AppLocalData}/unreadable.json`,
    new TextEncoder().encode(JSON.stringify([{ id: '1', name: 'x', value: 1 }]))
  );
  const adapter = createAdapter<TestData>('unreadable.json');

  mock_read_file.mockImplementationOnce(async () => {
    throw new Error('E_UNKNOWN_SOMETHING');
  });

  // File is present, so this is a real I/O failure, not a missing file.
  await expect(adapter.readAll()).rejects.toThrow('Failed to load unreadable.json');
});

test('readAll handles empty file', async () => {
  const adapter = createAdapter<TestData>('empty.json');

  // Create empty file in mock filesystem
  mock_file_system.set(`${BaseDirectory.AppLocalData}/empty.json`, new TextEncoder().encode(''));

  const result = await adapter.readAll();
  expect(result).toEqual([]);
});

test('readIds returns only requested items', async () => {
  const adapter = createAdapter<TestData>('ids.json');
  await adapter.setup();

  const test_data: TestData[] = [
    { id: '1', name: 'one', value: 1 },
    { id: '2', name: 'two', value: 2 },
    { id: '3', name: 'three', value: 3 },
  ];
  await adapter.insert(test_data);

  expect(await adapter.readIds(['1', '3'])).toEqual([test_data[0], test_data[2]]);
  // Missing ids are left out, not errors
  expect(await adapter.readIds(['2', 'phantom'])).toEqual([test_data[1]]);
  expect(await adapter.readIds([])).toEqual([]);
});

test('replace overwrites same-id entries', async () => {
  const adapter = createAdapter<TestData>('replace.json');
  await adapter.setup();

  await adapter.insert([
    { id: '1', name: 'orig', value: 1 },
    { id: '2', name: 'other', value: 2 },
  ]);
  await adapter.replace([{ id: '1', name: 'updated', value: 10 }]);

  expect(await adapter.readAll()).toEqual([
    { id: '1', name: 'updated', value: 10 },
    { id: '2', name: 'other', value: 2 },
  ]);
});

test('remove deletes by id and ignores missing ids', async () => {
  const adapter = createAdapter<TestData>('remove.json');
  await adapter.setup();

  const test_data: TestData[] = [
    { id: '1', name: 'keep', value: 1 },
    { id: '2', name: 'drop', value: 2 },
  ];
  await adapter.insert(test_data);

  await adapter.remove([
    { id: '2', name: 'drop', value: 2 },
    { id: 'phantom', name: 'ghost', value: -1 },
  ]);

  expect(await adapter.readAll()).toEqual([test_data[0]]);
});

test('removeAll empties the file', async () => {
  const adapter = createAdapter<TestData>('remove-all.json');
  await adapter.setup();

  await adapter.insert([{ id: '1', name: 'x', value: 1 }]);
  expect(await adapter.readAll()).toEqual([{ id: '1', name: 'x', value: 1 }]);

  await adapter.removeAll();

  expect(await adapter.readAll()).toEqual([]);
  const raw = new TextDecoder().decode(
    mock_file_system.get(`${BaseDirectory.AppLocalData}/remove-all.json`)!
  );
  expect(raw).toBe('[]');
});

test('Empty writes skip the file rewrite', async () => {
  const adapter = createAdapter<TestData>('noop.json');
  await adapter.setup();
  await adapter.insert([{ id: '1', name: 'x', value: 1 }]);

  mock_write_file.mockClear();
  mock_rename_fn.mockClear();

  await adapter.insert([]);
  await adapter.replace([]);
  await adapter.remove([]);
  await adapter.remove([{ id: 'phantom', name: 'ghost', value: -1 }]);

  expect(mock_write_file).not.toHaveBeenCalled();
  expect(mock_rename_fn).not.toHaveBeenCalled();
  expect(await adapter.readAll()).toEqual([{ id: '1', name: 'x', value: 1 }]);
});

test('removeAll on an empty store skips the rewrite', async () => {
  const adapter = createAdapter<TestData>('noop-all.json');
  await adapter.setup();

  mock_write_file.mockClear();
  await adapter.removeAll();

  expect(mock_write_file).not.toHaveBeenCalled();
});

test('Date values are stored as ISO strings', async () => {
  interface DatedItem {
    id: string;
    at: Date;
  }
  const adapter = createAdapter<DatedItem>('dates.json');
  await adapter.setup();

  const stamped = new Date('2026-03-15T12:00:00.000Z');
  await adapter.insert([{ id: '1', at: stamped }]);

  const raw = new TextDecoder().decode(
    mock_file_system.get(`${BaseDirectory.AppLocalData}/dates.json`)!
  );
  expect(raw).toContain('2026-03-15T12:00:00.000Z');
});

test('Index lifecycle: create, read, drop', async () => {
  const adapter = createAdapter<TestData>('indexed.json');
  await adapter.setup();
  await adapter.insert([
    { id: '1', name: 'a', value: 1 },
    { id: '2', name: 'b', value: 1 },
    { id: '3', name: 'c', value: 2 },
  ]);

  // Unknown index reads throw so callers fall back to a full scan.
  await expect(adapter.readIndex('value')).rejects.toThrow('Index on field "value" does not exist');
  await expect(adapter.dropIndex('value')).rejects.toThrow('Index on field "value" does not exist');

  await adapter.createIndex('value');
  const index = await adapter.readIndex('value');
  expect(index.get('1')).toEqual(new Set(['1', '2']));
  expect(index.get('2')).toEqual(new Set(['3']));

  // The index is built on demand, so later writes show up without a rebuild.
  await adapter.insert([{ id: '4', name: 'd', value: 2 }]);
  expect((await adapter.readIndex('value')).get('2')).toEqual(new Set(['3', '4']));

  await adapter.dropIndex('value');
  await expect(adapter.readIndex('value')).rejects.toThrow('Index on field "value" does not exist');
});

test('readIndex supports dot-notation fields and skips nulls', async () => {
  interface NestedData {
    id: string;
    author?: { id: string };
  }
  const adapter = createAdapter<NestedData>('nested-index.json');
  await adapter.setup();
  await adapter.insert([
    { id: '1', author: { id: 'a1' } },
    { id: '2', author: { id: 'a1' } },
    { id: '3' },
  ]);

  await adapter.createIndex('author.id');
  const index = await adapter.readIndex('author.id');
  expect(index.get('a1')).toEqual(new Set(['1', '2']));
  expect(index.has(null)).toBe(false);
  expect(index.size).toBe(1);
});

test('Encryption creates encrypted files', async () => {
  const adapter = createAdapter<TestData>('encrypted.json', {
    encrypt: async (data) => btoa(JSON.stringify(data)),
    decrypt: async (encrypted) => JSON.parse(atob(encrypted)),
  });

  const test_data: TestData[] = [
    { id: '1', name: 'Secret Data', value: 123 }
  ];

  await adapter.setup();

  // Check that initial file is encrypted (base64 encoded empty array)
  const initial_content = mock_file_system.get(`${BaseDirectory.AppLocalData}/encrypted.json`)!;
  const initial_string = new TextDecoder().decode(initial_content);
  expect(initial_string).toBe(btoa(JSON.stringify([])));
  expect(initial_string).not.toBe('[]'); // Should be encrypted, not plain JSON

  await adapter.insert(test_data);

  // Check that saved data is encrypted
  const saved_content = mock_file_system.get(`${BaseDirectory.AppLocalData}/encrypted.json`)!;
  const saved_string = new TextDecoder().decode(saved_content);
  expect(saved_string).toBe(btoa(JSON.stringify(test_data)));
  expect(saved_string).not.toBe(JSON.stringify(test_data)); // Should be encrypted

  // Verify we can still read and decrypt correctly
  const result = await adapter.readAll();
  expect(result).toEqual(test_data);
});

test('Multiple adapters with different files', async () => {
  const users_adapter = createAdapter<TestData>('users.json');
  const settings_adapter = createAdapter<TestData>('settings.json');

  const user_data: TestData[] = [{ id: '1', name: 'User', value: 1 }];
  const settings_data: TestData[] = [{ id: '1', name: 'Theme', value: 2 }];

  await users_adapter.setup();
  await settings_adapter.setup();

  await users_adapter.insert(user_data);
  await settings_adapter.insert(settings_data);

  // Check both files exist with correct content
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/users.json`)).toBe(true);
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/settings.json`)).toBe(true);

  const users_content = new TextDecoder().decode(mock_file_system.get(`${BaseDirectory.AppLocalData}/users.json`)!);
  const settings_content = new TextDecoder().decode(mock_file_system.get(`${BaseDirectory.AppLocalData}/settings.json`)!);

  expect(users_content).toBe(JSON.stringify(user_data));
  expect(settings_content).toBe(JSON.stringify(settings_data));

  // Verify reading works independently
  expect(await users_adapter.readAll()).toEqual(user_data);
  expect(await settings_adapter.readAll()).toEqual(settings_data);
});

test('Handles write errors gracefully', async () => {
  let should_fail_encryption = false;

  const adapter = createAdapter<TestData>('test.json', {
    encrypt: async (data) => {
      if (should_fail_encryption) {
        throw new Error('Encryption failed');
      }
      return JSON.stringify(data); // Normal encryption for setup
    },
    decrypt: async (encrypted) => JSON.parse(encrypted),
  });

  const test_data: TestData[] = [{ id: '1', name: 'Test', value: 100 }];

  // Setup should succeed (encryption not failing yet)
  await adapter.setup();

  // File should be created during setup
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/test.json`)).toBe(true);

  // Now enable encryption failure for the write operation
  should_fail_encryption = true;

  // Should throw error on insert due to encryption failure
  await expect(adapter.insert(test_data)).rejects.toThrow('Failed to encrypt data for test.json');
});

test('Handles setup encryption errors gracefully', async () => {
  const adapter = createAdapter<TestData>('setup-error-test.json', {
    encrypt: async () => {
      throw new Error('Encryption failed during setup');
    },
    decrypt: async (encrypted) => JSON.parse(encrypted),
  });

  // Setup should fail due to encryption error
  await expect(adapter.setup()).rejects.toThrow('Failed to initialize file setup-error-test.json');

  // File should not exist since setup failed
  expect(mock_file_system.has(`${BaseDirectory.AppLocalData}/setup-error-test.json`)).toBe(false);
});

test('Insert, replace and remove apply incrementally', async () => {
  const adapter = createAdapter<TestData>('incremental-test.json');

  // Initial data
  const initial_data: TestData[] = [
    { id: '1', name: 'Original Item 1', value: 100 },
    { id: '2', name: 'Original Item 2', value: 200 },
    { id: '3', name: 'Original Item 3', value: 300 }
  ];

  await adapter.setup();
  await adapter.insert(initial_data);

  // Verify initial insert
  expect(await adapter.readAll()).toEqual(initial_data);

  // Now perform incremental updates
  await adapter.insert([{ id: '4', name: 'New Item', value: 400 }]);
  await adapter.replace([{ id: '2', name: 'Updated Item 2', value: 250 }]);
  await adapter.remove([{ id: '3', name: 'Original Item 3', value: 300 }]);

  const expected_final_data: TestData[] = [
    { id: '1', name: 'Original Item 1', value: 100 },
    { id: '2', name: 'Updated Item 2', value: 250 },
    { id: '4', name: 'New Item', value: 400 }
  ];

  // Verify incremental changes were applied correctly
  expect(await adapter.readAll()).toEqual(expected_final_data);
});

test('Real SignalDB Collection round-trip persists mutations and reloads', async () => {
  const { Collection, DefaultDataAdapter } = await import('@signaldb/core');
  const adapter = createAdapter<TestData>('collection.json');
  const dataAdapter = new DefaultDataAdapter({ storage: () => adapter });
  const collection = new Collection<TestData>('collection', dataAdapter);
  await collection.ready();

  await collection.insert({ id: '1', name: 'one', value: 1 });
  await collection.insert({ id: '2', name: 'two', value: 2 });
  await collection.updateOne({ id: '1' }, { $set: { value: 10 } });
  await collection.removeOne({ id: '2' });

  // Writes are awaited through to storage, so no polling is needed.
  const expected: TestData[] = [{ id: '1', name: 'one', value: 10 }];
  expect(await adapter.readAll()).toEqual(expected);

  // A fresh collection over the same file reloads the persisted state.
  const adapter2 = createAdapter<TestData>('collection.json');
  const dataAdapter2 = new DefaultDataAdapter({ storage: () => adapter2 });
  const collection2 = new Collection<TestData>('collection', dataAdapter2);
  await collection2.ready();
  expect(collection2.find({}).fetch()).toEqual(expected);
});

test('Collection insertMany bursts batch into one file rewrite', async () => {
  const { Collection, DefaultDataAdapter } = await import('@signaldb/core');
  const adapter = createAdapter<TestData>('burst.json');
  const dataAdapter = new DefaultDataAdapter({ storage: () => adapter });
  const collection = new Collection<TestData>('burst', dataAdapter);
  await collection.ready();

  mock_write_file.mockClear();
  const batch: TestData[] = Array.from({ length: 100 }, (_, i) => ({
    id: `b${i}`, name: `burst-${i}`, value: i
  }));
  await collection.insertMany(batch);

  expect(collection.find({}).fetch().length).toBe(100);
  const temp_writes = mock_write_file.mock.calls.filter(([name]) =>
    (name as string).includes('.tmp.')
  );
  expect(temp_writes.length).toBe(1);
});

test('Legacy persistence option still works', async () => {
  const { Collection } = await import('@signaldb/core');
  const adapter = createAdapter<TestData>('legacy.json');
  const collection = new Collection<TestData>({ name: 'legacy', persistence: adapter });
  await collection.ready();

  const id = await collection.insert({ name: 'one', value: 1 });
  expect(typeof id).toBe('string');
  expect(collection.find({}).fetch()).toEqual([{ id, name: 'one', value: 1 }]);
  expect(await adapter.readAll()).toEqual([{ id, name: 'one', value: 1 }]);
});

test('Collection reports setup failures through onError and ready()', async () => {
  const { Collection, DefaultDataAdapter } = await import('@signaldb/core');
  const adapter = createAdapter<TestData>('broken.json', {
    encrypt: async () => { throw new Error('no key'); },
    decrypt: async (encrypted) => JSON.parse(encrypted),
  });
  const errors: Array<{ name: string; error: Error }> = [];
  const dataAdapter = new DefaultDataAdapter({
    storage: () => adapter,
    onError: (name, error) => { errors.push({ name, error }); },
  });
  const collection = new Collection<TestData>('broken', dataAdapter);

  await expect(collection.ready()).rejects.toThrow('Failed to initialize file broken.json');
  expect(errors.length).toBe(1);
  expect(errors[0].name).toBe('broken');
});
