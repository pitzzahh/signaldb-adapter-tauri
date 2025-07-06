import { test, expect, beforeEach, mock } from 'bun:test';
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

const mock_open = mock(async (filename: string, options: { write?: boolean; create?: boolean; baseDir?: BaseDirectory }) => {
  const base_dir = options.baseDir || BaseDirectory.AppLocalData;
  const full_path = `${base_dir}/${filename}`;

  return {
    write: mock(async (data: Uint8Array) => {
      mock_file_system.set(full_path, data);
    }),
    truncate: mock(async () => {
      // Mock truncate - clear the file
      mock_file_system.set(full_path, new Uint8Array(0));
    }),
    close: mock(async () => {
      // Mock close - no-op
    }),
  };
});

const mock_remove = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<void> => {
  const base_dir = options?.baseDir || BaseDirectory.AppLocalData;
  const full_path = `${base_dir}/${filename}`;
  console.log({ full_path })
  mock_file_system.delete(full_path);
});

// Mock the entire @tauri-apps/plugin-fs module
mock.module('@tauri-apps/plugin-fs', () => ({
  exists: mock_exists,
  readFile: mock_read_file,
  writeFile: mock_write_file,
  open: mock_open,
  remove: mock_remove,
  BaseDirectory: {
    AppLocalData: 'AppLocalData',
    AppConfig: 'AppConfig',
    AppData: 'AppData',
    Desktop: 'Desktop',
    Document: 'Document',
    Download: 'Download',
    Executable: 'Executable',
    Font: 'Font',
    Home: 'Home',
    Picture: 'Picture',
    Public: 'Public',
    Runtime: 'Runtime',
    Template: 'Template',
    Video: 'Video',
  } as const,
}));

// Import after mocking
const { createTauriFilesystemAdapter } = await import('../src/index');

beforeEach(() => {
  // Clear the mock filesystem and reset mock calls before each test
  mock_file_system.clear();
  mock_exists.mockClear();
  mock_read_file.mockClear();
  mock_write_file.mockClear();
  mock_open.mockClear();
  mock_remove.mockClear();
});

test('Basic adapter functionality', () => {
  const adapter = createTauriFilesystemAdapter<TestData>('test.json');

  // Test that adapter is created with correct interface
  expect(adapter).toBeDefined();
  if (!adapter) return;

  expect(adapter).toHaveProperty('register');
  expect(adapter).toHaveProperty('load');
  expect(adapter).toHaveProperty('save');
  expect(typeof adapter.register).toBe('function');
  expect(typeof adapter.load).toBe('function');
  expect(typeof adapter.save).toBe('function');
});

test('Register creates initial empty file in AppLocalData', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('test.json');
  if (!adapter) return;

  // Before register, file should not exist
  expect(mock_file_system.has('AppLocalData/test.json')).toBe(false);

  await adapter.register(() => { });

  // After register, file should exist with empty array
  expect(mock_file_system.has('AppLocalData/test.json')).toBe(true);

  const file_content = mock_file_system.get('AppLocalData/test.json')!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe('[]');

  // Verify the correct Tauri functions were called
  expect(mock_exists).toHaveBeenCalledWith('test.json', { baseDir: 'AppLocalData' });
  expect(mock_write_file).toHaveBeenCalled();
});

test('Register does not overwrite existing file', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('test.json');
  if (!adapter) return;

  // Pre-populate the mock filesystem with existing data
  const existing_data = '[{"id": "1", "name": "existing"}]';
  mock_file_system.set('AppLocalData/test.json', new TextEncoder().encode(existing_data));

  await adapter.register(() => { });

  // File should remain unchanged
  const file_content = mock_file_system.get('AppLocalData/test.json')!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe(existing_data);

  // Verify exists was called but writeFile was not called
  expect(mock_exists).toHaveBeenCalledWith('test.json', { baseDir: 'AppLocalData' });
  expect(mock_write_file).not.toHaveBeenCalled();
});

test('Save and load data correctly', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('users.json');
  if (!adapter) return;

  const test_data: TestData[] = [
    { id: '1', name: 'John Doe', value: 100 },
    { id: '2', name: 'Jane Smith', value: 200 },
  ];

  await adapter.register(() => { });
  await adapter.save(test_data, { added: test_data, modified: [], removed: [] });

  // Check that data was actually written to the mock filesystem
  expect(mock_file_system.has('AppLocalData/users.json')).toBe(true);

  const file_content = mock_file_system.get('AppLocalData/users.json')!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe(JSON.stringify(test_data));

  // Load and verify the data comes back correctly
  const load_result = await adapter.load();
  expect(load_result.items).toEqual(test_data);

  // Verify the correct Tauri functions were called
  expect(mock_open).toHaveBeenCalled();
  expect(mock_read_file).toHaveBeenCalledWith('users.json', { baseDir: 'AppLocalData' });
});

test('Uses custom base directory', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('config.json', {
    base_dir: BaseDirectory.AppConfig
  });
  if (!adapter) return;

  await adapter.register(() => { });

  // Check that file was created in AppConfig directory
  expect(mock_file_system.has('AppConfig/config.json')).toBe(true);
  expect(mock_file_system.has('AppLocalData/config.json')).toBe(false);

  const file_content = mock_file_system.get('AppConfig/config.json')!;
  const content_string = new TextDecoder().decode(file_content);
  expect(content_string).toBe('[]');

  // Verify the correct base directory was used
  expect(mock_exists).toHaveBeenCalledWith('config.json', { baseDir: 'AppConfig' });
});

test('Load handles non-existent file', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('nonexistent.json');
  if (!adapter) return;

  // File should not exist in filesystem
  expect(mock_file_system.has('AppLocalData/nonexistent.json')).toBe(false);

  const result = await adapter.load();
  expect(result.items).toEqual([]);

  // Verify exists was called
  expect(mock_exists).toHaveBeenCalledWith('nonexistent.json', { baseDir: 'AppLocalData' });
});

test('Load handles empty file', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('empty.json');
  if (!adapter) return;

  // Create empty file in mock filesystem
  mock_file_system.set('AppLocalData/empty.json', new TextEncoder().encode(''));

  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

test('Load handles corrupted JSON gracefully', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('corrupted.json');
  if (!adapter) return;

  // Create file with invalid JSON in mock filesystem
  mock_file_system.set('AppLocalData/corrupted.json', new TextEncoder().encode('invalid json'));

  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

test('Encryption creates encrypted files', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('encrypted.json', {
    encrypt: async (data) => btoa(JSON.stringify(data)),
    decrypt: async (encrypted) => JSON.parse(atob(encrypted)),
  });
  if (!adapter) return;

  const test_data: TestData[] = [
    { id: '1', name: 'Secret Data', value: 123 }
  ];

  await adapter.register(() => { });

  // Check that initial file is encrypted (base64 encoded empty array)
  const initial_content = mock_file_system.get('AppLocalData/encrypted.json')!;
  const initial_string = new TextDecoder().decode(initial_content);
  expect(initial_string).toBe(btoa(JSON.stringify([])));
  expect(initial_string).not.toBe('[]'); // Should be encrypted, not plain JSON

  await adapter.save(test_data, { added: test_data, modified: [], removed: [] });

  // Check that saved data is encrypted
  const saved_content = mock_file_system.get('AppLocalData/encrypted.json')!;
  const saved_string = new TextDecoder().decode(saved_content);
  expect(saved_string).toBe(btoa(JSON.stringify(test_data)));
  expect(saved_string).not.toBe(JSON.stringify(test_data)); // Should be encrypted

  // Verify we can still load and decrypt correctly
  const result = await adapter.load();
  expect(result.items).toEqual(test_data);
});

test('Multiple adapters with different files', async () => {
  const users_adapter = createTauriFilesystemAdapter<TestData>('users.json');
  const settings_adapter = createTauriFilesystemAdapter<TestData>('settings.json');
  if (!users_adapter || !settings_adapter) return;

  const user_data: TestData[] = [{ id: '1', name: 'User', value: 1 }];
  const settings_data: TestData[] = [{ id: '1', name: 'Theme', value: 2 }];

  await users_adapter.register(() => { });
  await settings_adapter.register(() => { });

  await users_adapter.save(user_data, { added: user_data, modified: [], removed: [] });
  await settings_adapter.save(settings_data, { added: settings_data, modified: [], removed: [] });

  // Check both files exist with correct content
  expect(mock_file_system.has('AppLocalData/users.json')).toBe(true);
  expect(mock_file_system.has('AppLocalData/settings.json')).toBe(true);

  const users_content = new TextDecoder().decode(mock_file_system.get('AppLocalData/users.json')!);
  const settings_content = new TextDecoder().decode(mock_file_system.get('AppLocalData/settings.json')!);

  expect(users_content).toBe(JSON.stringify(user_data));
  expect(settings_content).toBe(JSON.stringify(settings_data));

  // Verify loading works independently
  const users_result = await users_adapter.load();
  const settings_result = await settings_adapter.load();

  expect(users_result.items).toEqual(user_data);
  expect(settings_result.items).toEqual(settings_data);
});

test('Handles save errors gracefully', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('test.json', {
    encrypt: async () => {
      throw new Error('Encryption failed');
    },
  });
  if (!adapter) return;

  const test_data: TestData[] = [{ id: '1', name: 'Test', value: 100 }];

  // Register will fail due to encryption error, so the file won't be created
  try {
    await adapter.register(() => { });
  } catch (error) {
    // Expected to fail
  }

  // Should throw error on save due to encryption failure
  await expect(adapter.save(test_data, { added: test_data, modified: [], removed: [] })).rejects.toThrow('Failed to save data to test.json');

  // File should not exist since register failed
  expect(mock_file_system.has('AppLocalData/test.json')).toBe(false);
});

// Helper function to inspect the mock filesystem state
function get_mock_file_system_state() {
  const state: Record<string, string> = {};
  for (const [path, content] of mock_file_system.entries()) {
    state[path] = new TextDecoder().decode(content);
  }
  return state;
}

test('Mock filesystem state inspection', async () => {
  const adapter1 = createTauriFilesystemAdapter<TestData>('app1.json');
  const adapter2 = createTauriFilesystemAdapter<TestData>('app2.json', {
    base_dir: BaseDirectory.AppConfig
  });
  if (!adapter1 || !adapter2) return;

  await adapter1.register(() => { });
  await adapter2.register(() => { });

  await adapter1.save([{ id: '1', name: 'App1 Data', value: 1 }], { added: [{ id: '1', name: 'App1 Data', value: 1 }], modified: [], removed: [] });
  await adapter2.save([{ id: '2', name: 'App2 Data', value: 2 }], { added: [{ id: '2', name: 'App2 Data', value: 2 }], modified: [], removed: [] });

  const state = get_mock_file_system_state();

  console.log('Mock filesystem state:', state);
  console.log('Available keys:', Object.keys(state));

  // Should have files in both directories
  expect(Object.keys(state)).toContain('AppLocalData/app1.json');
  expect(Object.keys(state)).toContain('AppConfig/app2.json');

  expect(state['AppLocalData/app1.json']).toBe('[{"id":"1","name":"App1 Data","value":1}]');
  expect(state['AppConfig/app2.json']).toBe('[{"id":"2","name":"App2 Data","value":2}]');
});

test('Change callback is called on save', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('callback-test.json');
  if (!adapter) return;

  let callback_data: any = null;
  const on_change = mock((data?: any) => {
    callback_data = data;
  });

  await adapter.register(on_change);

  const test_data: TestData[] = [
    { id: '1', name: 'Callback Test', value: 42 }
  ];

  await adapter.save(test_data, { added: test_data, modified: [], removed: [] });

  // Verify the callback was called with the saved data
  expect(on_change).toHaveBeenCalled();
  expect(callback_data).toEqual({ items: test_data });
});

test('Unregister cleans up properly', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('unregister-test.json');
  if (!adapter) return;

  let callback_called = false;
  const on_change = mock(() => {
    callback_called = true;
  });

  await adapter.register(on_change);

  // Verify adapter has unregister method
  expect(adapter).toHaveProperty('unregister');
  expect(typeof adapter.unregister).toBe('function');

  await adapter.unregister?.();

  const test_data: TestData[] = [
    { id: '1', name: 'After Unregister', value: 99 }
  ];

  // Save after unregister - callback should not be called
  await adapter.save(test_data, { added: test_data, modified: [], removed: [] });

  expect(callback_called).toBe(false);
});

test('Initial data callback on register', async () => {
  // Pre-populate the mock filesystem with existing data
  const existing_data = '[{"id": "1", "name": "existing", "value": 123}]';
  mock_file_system.set('AppLocalData/initial-callback-test.json', new TextEncoder().encode(existing_data));

  const adapter = createTauriFilesystemAdapter<TestData>('initial-callback-test.json');
  if (!adapter) return;

  let callback_data: any = null;
  const on_change = mock((data?: any) => {
    callback_data = data;
  });

  await adapter.register(on_change);

  // Verify the callback was called with initial data
  expect(on_change).toHaveBeenCalled();
  expect(callback_data).toEqual({
    items: [{ id: "1", name: "existing", value: 123 }]
  });
});

test('Save uses incremental changes correctly', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('incremental-test.json');
  if (!adapter) return;

  // Initial data
  const initial_data: TestData[] = [
    { id: '1', name: 'Original Item 1', value: 100 },
    { id: '2', name: 'Original Item 2', value: 200 },
    { id: '3', name: 'Original Item 3', value: 300 }
  ];

  await adapter.register(() => { });
  await adapter.save(initial_data, { added: initial_data, modified: [], removed: [] });

  // Verify initial save
  let result = await adapter.load();
  expect(result.items).toEqual(initial_data);

  // Now perform incremental updates
  const changes = {
    added: [{ id: '4', name: 'New Item', value: 400 }],
    modified: [{ id: '2', name: 'Updated Item 2', value: 250 }],
    removed: [{ id: '3', name: 'Original Item 3', value: 300 }]
  };

  const expected_final_data: TestData[] = [
    { id: '1', name: 'Original Item 1', value: 100 },
    { id: '2', name: 'Updated Item 2', value: 250 },
    { id: '4', name: 'New Item', value: 400 }
  ];

  await adapter.save(expected_final_data, changes);

  // Verify incremental changes were applied correctly
  result = await adapter.load();
  expect(result.items).toEqual(expected_final_data);
});

test('Save handles empty changes gracefully', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('empty-changes-test.json');
  if (!adapter) return;

  const test_data: TestData[] = [
    { id: '1', name: 'Test Item', value: 100 }
  ];

  await adapter.register(() => { });

  // Save with empty changes
  await adapter.save(test_data, { added: [], modified: [], removed: [] });

  const result = await adapter.load();
  expect(result.items).toEqual(test_data);
});

test('Save falls back to full save on mismatch', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('fallback-test.json');
  if (!adapter) return;

  // Initial data
  const initial_data: TestData[] = [
    { id: '1', name: 'Item 1', value: 100 }
  ];

  await adapter.register(() => { });
  await adapter.save(initial_data, { added: initial_data, modified: [], removed: [] });

  // Create a mismatch scenario - changes don't match final items
  const final_items: TestData[] = [
    { id: '1', name: 'Item 1', value: 100 },
    { id: '2', name: 'Item 2', value: 200 },
    { id: '3', name: 'Item 3', value: 300 }
  ];

  const incorrect_changes = {
    added: [{ id: '2', name: 'Item 2', value: 200 }], // Missing item 3
    modified: [],
    removed: []
  };

  // Should fall back to saving the complete final_items array
  await adapter.save(final_items, incorrect_changes);

  const result = await adapter.load();
  expect(result.items).toEqual(final_items);
});
