import { test, expect, beforeEach, mock } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

// Test data interface
interface TestData {
  id: string;
  name: string;
  value: number;
}

// Mock filesystem state - this simulates the actual file system
const mockFileSystem = new Map<string, Uint8Array>();

// Mock functions for the Tauri filesystem plugin
const mockExists = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<boolean> => {
  const baseDir = options?.baseDir || BaseDirectory.AppLocalData;
  const fullPath = `${baseDir}/${filename}`;
  return mockFileSystem.has(fullPath);
});

const mockReadFile = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<Uint8Array> => {
  const baseDir = options?.baseDir || BaseDirectory.AppLocalData;
  const fullPath = `${baseDir}/${filename}`;
  const content = mockFileSystem.get(fullPath);
  if (!content) {
    throw new Error(`File not found: ${filename}`);
  }
  return content;
});

const mockWriteFile = mock(async (filename: string, data: Uint8Array, options?: { baseDir?: BaseDirectory }): Promise<void> => {
  const baseDir = options?.baseDir || BaseDirectory.AppLocalData;
  const fullPath = `${baseDir}/${filename}`;
  mockFileSystem.set(fullPath, data);
});

const mockOpen = mock(async (filename: string, options: { write?: boolean; create?: boolean; baseDir?: BaseDirectory }) => {
  const baseDir = options.baseDir || BaseDirectory.AppLocalData;
  const fullPath = `${baseDir}/${filename}`;

  return {
    write: mock(async (data: Uint8Array) => {
      mockFileSystem.set(fullPath, data);
    }),
    truncate: mock(async () => {
      // Mock truncate - clear the file
      mockFileSystem.set(fullPath, new Uint8Array(0));
    }),
    close: mock(async () => {
      // Mock close - no-op
    }),
  };
});

const mockRemove = mock(async (filename: string, options?: { baseDir?: BaseDirectory }): Promise<void> => {
  const baseDir = options?.baseDir || BaseDirectory.AppLocalData;
  const fullPath = `${baseDir}/${filename}`;
  console.log({ fullPath })
  mockFileSystem.delete(fullPath);
});

// Mock the entire @tauri-apps/plugin-fs module
mock.module('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  open: mockOpen,
  remove: mockRemove,
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
  mockFileSystem.clear();
  mockExists.mockClear();
  mockReadFile.mockClear();
  mockWriteFile.mockClear();
  mockOpen.mockClear();
  mockRemove.mockClear();
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
  expect(mockFileSystem.has('AppLocalData/test.json')).toBe(false);

  await adapter.register(() => { });

  // After register, file should exist with empty array
  expect(mockFileSystem.has('AppLocalData/test.json')).toBe(true);

  const fileContent = mockFileSystem.get('AppLocalData/test.json')!;
  const contentString = new TextDecoder().decode(fileContent);
  expect(contentString).toBe('[]');

  // Verify the correct Tauri functions were called
  expect(mockExists).toHaveBeenCalledWith('test.json', { baseDir: 'AppLocalData' });
  expect(mockWriteFile).toHaveBeenCalled();
});

test('Register does not overwrite existing file', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('test.json');
  if (!adapter) return;

  // Pre-populate the mock filesystem with existing data
  const existingData = '[{"id": "1", "name": "existing"}]';
  mockFileSystem.set('AppLocalData/test.json', new TextEncoder().encode(existingData));

  await adapter.register(() => { });

  // File should remain unchanged
  const fileContent = mockFileSystem.get('AppLocalData/test.json')!;
  const contentString = new TextDecoder().decode(fileContent);
  expect(contentString).toBe(existingData);

  // Verify exists was called but writeFile was not called
  expect(mockExists).toHaveBeenCalledWith('test.json', { baseDir: 'AppLocalData' });
  expect(mockWriteFile).not.toHaveBeenCalled();
});

test('Save and load data correctly', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('users.json');
  if (!adapter) return;

  const testData: TestData[] = [
    { id: '1', name: 'John Doe', value: 100 },
    { id: '2', name: 'Jane Smith', value: 200 },
  ];

  await adapter.register(() => { });
  await adapter.save(testData, { added: testData, modified: [], removed: [] });

  // Check that data was actually written to the mock filesystem
  expect(mockFileSystem.has('AppLocalData/users.json')).toBe(true);

  const fileContent = mockFileSystem.get('AppLocalData/users.json')!;
  const contentString = new TextDecoder().decode(fileContent);
  expect(contentString).toBe(JSON.stringify(testData));

  // Load and verify the data comes back correctly
  const loadResult = await adapter.load();
  expect(loadResult.items).toEqual(testData);

  // Verify the correct Tauri functions were called
  expect(mockOpen).toHaveBeenCalled();
  expect(mockReadFile).toHaveBeenCalledWith('users.json', { baseDir: 'AppLocalData' });
});

test('Uses custom base directory', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('config.json', {
    base_dir: BaseDirectory.AppConfig
  });
  if (!adapter) return;

  await adapter.register(() => { });

  // Check that file was created in AppConfig directory
  expect(mockFileSystem.has('AppConfig/config.json')).toBe(true);
  expect(mockFileSystem.has('AppLocalData/config.json')).toBe(false);

  const fileContent = mockFileSystem.get('AppConfig/config.json')!;
  const contentString = new TextDecoder().decode(fileContent);
  expect(contentString).toBe('[]');

  // Verify the correct base directory was used
  expect(mockExists).toHaveBeenCalledWith('config.json', { baseDir: 'AppConfig' });
});

test('Load handles non-existent file', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('nonexistent.json');
  if (!adapter) return;

  // File should not exist in filesystem
  expect(mockFileSystem.has('AppLocalData/nonexistent.json')).toBe(false);

  const result = await adapter.load();
  expect(result.items).toEqual([]);

  // Verify exists was called
  expect(mockExists).toHaveBeenCalledWith('nonexistent.json', { baseDir: 'AppLocalData' });
});

test('Load handles empty file', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('empty.json');
  if (!adapter) return;

  // Create empty file in mock filesystem
  mockFileSystem.set('AppLocalData/empty.json', new TextEncoder().encode(''));

  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

test('Load handles corrupted JSON gracefully', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('corrupted.json');
  if (!adapter) return;

  // Create file with invalid JSON in mock filesystem
  mockFileSystem.set('AppLocalData/corrupted.json', new TextEncoder().encode('invalid json'));

  const result = await adapter.load();
  expect(result.items).toEqual([]);
});

test('Encryption creates encrypted files', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('encrypted.json', {
    encrypt: async (data) => btoa(JSON.stringify(data)),
    decrypt: async (encrypted) => JSON.parse(atob(encrypted)),
  });
  if (!adapter) return;

  const testData: TestData[] = [
    { id: '1', name: 'Secret Data', value: 123 }
  ];

  await adapter.register(() => { });

  // Check that initial file is encrypted (base64 encoded empty array)
  const initialContent = mockFileSystem.get('AppLocalData/encrypted.json')!;
  const initialString = new TextDecoder().decode(initialContent);
  expect(initialString).toBe(btoa(JSON.stringify([])));
  expect(initialString).not.toBe('[]'); // Should be encrypted, not plain JSON

  await adapter.save(testData, { added: testData, modified: [], removed: [] });

  // Check that saved data is encrypted
  const savedContent = mockFileSystem.get('AppLocalData/encrypted.json')!;
  const savedString = new TextDecoder().decode(savedContent);
  expect(savedString).toBe(btoa(JSON.stringify(testData)));
  expect(savedString).not.toBe(JSON.stringify(testData)); // Should be encrypted

  // Verify we can still load and decrypt correctly
  const result = await adapter.load();
  expect(result.items).toEqual(testData);
});

test('Multiple adapters with different files', async () => {
  const usersAdapter = createTauriFilesystemAdapter<TestData>('users.json');
  const settingsAdapter = createTauriFilesystemAdapter<TestData>('settings.json');
  if (!usersAdapter || !settingsAdapter) return;

  const userData: TestData[] = [{ id: '1', name: 'User', value: 1 }];
  const settingsData: TestData[] = [{ id: '1', name: 'Theme', value: 2 }];

  await usersAdapter.register(() => { });
  await settingsAdapter.register(() => { });

  await usersAdapter.save(userData, { added: userData, modified: [], removed: [] });
  await settingsAdapter.save(settingsData, { added: settingsData, modified: [], removed: [] });

  // Check both files exist with correct content
  expect(mockFileSystem.has('AppLocalData/users.json')).toBe(true);
  expect(mockFileSystem.has('AppLocalData/settings.json')).toBe(true);

  const usersContent = new TextDecoder().decode(mockFileSystem.get('AppLocalData/users.json')!);
  const settingsContent = new TextDecoder().decode(mockFileSystem.get('AppLocalData/settings.json')!);

  expect(usersContent).toBe(JSON.stringify(userData));
  expect(settingsContent).toBe(JSON.stringify(settingsData));

  // Verify loading works independently
  const usersResult = await usersAdapter.load();
  const settingsResult = await settingsAdapter.load();

  expect(usersResult.items).toEqual(userData);
  expect(settingsResult.items).toEqual(settingsData);
});

test('Handles save errors gracefully', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('test.json', {
    encrypt: async () => {
      throw new Error('Encryption failed');
    },
  });
  if (!adapter) return;

  const testData: TestData[] = [{ id: '1', name: 'Test', value: 100 }];

  // Register will fail due to encryption error, so the file won't be created
  try {
    await adapter.register(() => { });
  } catch (error) {
    // Expected to fail
  }

  // Should throw error on save due to encryption failure
  await expect(adapter.save(testData, { added: testData, modified: [], removed: [] })).rejects.toThrow('Failed to save data to test.json');

  // File should not exist since register failed
  expect(mockFileSystem.has('AppLocalData/test.json')).toBe(false);
});

// Helper function to inspect the mock filesystem state
function getMockFileSystemState() {
  const state: Record<string, string> = {};
  for (const [path, content] of mockFileSystem.entries()) {
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

  const state = getMockFileSystemState();

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

  let callbackData: any = null;
  const onChange = mock((data?: any) => {
    callbackData = data;
  });

  await adapter.register(onChange);

  const testData: TestData[] = [
    { id: '1', name: 'Callback Test', value: 42 }
  ];

  await adapter.save(testData, { added: testData, modified: [], removed: [] });

  // Verify the callback was called with the saved data
  expect(onChange).toHaveBeenCalled();
  expect(callbackData).toEqual({ items: testData });
});

test('Unregister cleans up properly', async () => {
  const adapter = createTauriFilesystemAdapter<TestData>('unregister-test.json');
  if (!adapter) return;

  let callbackCalled = false;
  const onChange = mock(() => {
    callbackCalled = true;
  });

  await adapter.register(onChange);

  // Verify adapter has unregister method
  expect(adapter).toHaveProperty('unregister');
  expect(typeof adapter.unregister).toBe('function');

  await adapter.unregister?.();

  const testData: TestData[] = [
    { id: '1', name: 'After Unregister', value: 99 }
  ];

  // Save after unregister - callback should not be called
  await adapter.save(testData, { added: testData, modified: [], removed: [] });

  expect(callbackCalled).toBe(false);
});

test('Initial data callback on register', async () => {
  // Pre-populate the mock filesystem with existing data
  const existingData = '[{"id": "1", "name": "existing", "value": 123}]';
  mockFileSystem.set('AppLocalData/initial-callback-test.json', new TextEncoder().encode(existingData));

  const adapter = createTauriFilesystemAdapter<TestData>('initial-callback-test.json');
  if (!adapter) return;

  let callbackData: any = null;
  const onChange = mock((data?: any) => {
    callbackData = data;
  });

  await adapter.register(onChange);

  // Verify the callback was called with initial data
  expect(onChange).toHaveBeenCalled();
  expect(callbackData).toEqual({
    items: [{ id: "1", name: "existing", value: 123 }]
  });
});
