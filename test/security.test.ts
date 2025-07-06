import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import { createTauriFileSystemAdapter } from '../src/index';

// Test data interface
interface TestData {
  id: string;
  name: string;
  value: number;
}

// Mock filesystem state
const mock_file_system = new Map<string, Uint8Array>();

// Mock functions for security tests
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

// Mock the Tauri fs plugin
mock.module('@tauri-apps/plugin-fs', () => ({
  exists: mock_exists,
  readFile: mock_read_file,
  writeFile: mock_write_file,
  remove: mock_remove,
  open: mock(async () => ({ write: mock(), close: mock(), truncate: mock() })),
  BaseDirectory: {
    AppLocalData: 'AppLocalData',
    Document: 'Document'
  }
}));

// Global warning suppression for cleaner test output
let originalConsoleWarn: typeof console.warn;

beforeEach(() => {
  mock_file_system.clear();
  mock_exists.mockClear();
  mock_read_file.mockClear();
  mock_write_file.mockClear();
  mock_remove.mockClear();

  // Suppress non-critical warnings for cleaner test output
  originalConsoleWarn = console.warn;
  console.warn = (...args: any[]) => {
    const message = args.join(' ');
    // Only suppress specific expected warnings
    if (message.includes('[SECURITY WARNING]') ||
      message.includes('Failed to create backup') ||
      message.includes('Incremental update mismatch')) {
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

test('Security: Filename validation prevents path traversal', () => {
  const malicious_filenames = [
    '../../../etc/passwd',
    '..\\..\\windows\\system32\\config',
    'file/../../../secret.txt',
    'normal\\..\\..\\bad.txt',
    'file\0null.txt',
    'file\nnewline.txt',
    'file\rcarriage.txt',
    'a'.repeat(300) // Too long
  ];

  for (const filename of malicious_filenames) {
    expect(() => {
      createTauriFileSystemAdapter<TestData>(filename);
    }).toThrow();
  }
});

test('Security: Empty or invalid filename throws error', () => {
  const invalid_filenames = ['', null as any, undefined as any, 123 as any];

  for (const filename of invalid_filenames) {
    expect(() => {
      createTauriFileSystemAdapter<TestData>(filename);
    }).toThrow('Filename must be a non-empty string');
  }
});

test('Security: Warning when no encryption provided', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);

  createTauriFileSystemAdapter<TestData>('test.json');

  expect(warnings.some(w => w.includes('[SECURITY WARNING] No encryption function provided'))).toBe(true);

  console.warn = originalWarn;
});

test('Security: Enforce encryption throws when encrypt/decrypt missing', () => {
  expect(() => {
    createTauriFileSystemAdapter<TestData>('test.json', {
      security: { enforceEncryption: true }
    });
  }).toThrow('Encryption is enforced but encrypt/decrypt functions are not provided');
});

test('Security: Enforce encryption passes with both encrypt/decrypt', () => {
  const encrypt = mock(async (data: any) => JSON.stringify(data));
  const decrypt = mock(async (data: string) => JSON.parse(data));

  expect(() => {
    createTauriFileSystemAdapter<TestData>('test.json', {
      encrypt,
      decrypt,
      security: { enforceEncryption: true }
    });
  }).not.toThrow();
});

test('Security: Decryption failure with no fallback throws error', async () => {
  const encrypt = mock(async (data: any) => 'encrypted:' + JSON.stringify(data));
  const decrypt = mock(async (data: string) => {
    if (!data.startsWith('encrypted:')) {
      throw new Error('Invalid encrypted data');
    }
    return JSON.parse(data.substring(10));
  });

  // Store tampered data
  const tampered_data = new TextEncoder().encode('tampered_data_not_encrypted');
  mock_file_system.set('AppLocalData/test.json', tampered_data);

  const adapter = createTauriFileSystemAdapter<TestData>('test.json', {
    encrypt,
    decrypt,
    security: { allowPlaintextFallback: false }
  });

  await expect(adapter.load()).rejects.toThrow('Decryption failed and plaintext fallback is disabled');
});

test('Security: Data validation fails on corrupted data', async () => {
  // Custom validator that expects objects with id, name, value
  const dataValidator = <T>(data: unknown): data is T[] => {
    if (!Array.isArray(data)) return false;
    return data.every(item =>
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      'name' in item &&
      'value' in item
    );
  };

  const corrupted_data = new TextEncoder().encode(JSON.stringify([
    { id: '1', corrupted: true }, // Missing required fields
    { name: 'test' } // Missing id and value
  ]));
  mock_file_system.set('AppLocalData/test.json', corrupted_data);

  const adapter = createTauriFileSystemAdapter<TestData>('test.json', {
    security: {
      validateDecryptedData: true,
      dataValidator
    }
  });

  await expect(adapter.load()).rejects.toThrow('Data failed validation');
});

test('Security: Callback errors propagate when enabled', async () => {
  const failing_callback = mock(async () => {
    throw new Error('Callback failed');
  });

  const adapter = createTauriFileSystemAdapter<TestData>('test.json', {
    security: { propagateCallbackErrors: true }
  });

  await adapter.register(failing_callback);

  const test_data: TestData[] = [{ id: '1', name: 'test', value: 42 }];

  await expect(adapter.save(test_data, { added: test_data, modified: [], removed: [] }))
    .rejects.toThrow('Change callback failed');
});

test('Security: Callback errors are silenced when disabled', async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);

  const failing_callback = mock(async () => {
    throw new Error('Callback failed');
  });

  const adapter = createTauriFileSystemAdapter<TestData>('test.json', {
    security: { propagateCallbackErrors: false }
  });

  await adapter.register(failing_callback);

  const test_data: TestData[] = [{ id: '1', name: 'test', value: 42 }];

  // Should not throw
  await adapter.save(test_data, { added: test_data, modified: [], removed: [] });

  expect(warnings.some(w => w.includes('Change callback error'))).toBe(true);

  console.warn = originalWarn;
});

test('Security: Backup files are created on save', async () => {
  // Set up existing data
  const existing_data = new TextEncoder().encode(JSON.stringify([
    { id: '1', name: 'existing', value: 1 }
  ]));
  mock_file_system.set('AppLocalData/test.json', existing_data);

  const adapter = createTauriFileSystemAdapter<TestData>('test.json');
  await adapter.register(mock());

  const new_data: TestData[] = [{ id: '2', name: 'new', value: 2 }];
  await adapter.save(new_data, { added: new_data, modified: [], removed: [] });

  // Check that a backup file was created
  const backup_files = Array.from(mock_file_system.keys()).filter(key =>
    key.includes('test.json.backup.')
  );

  expect(backup_files.length).toBe(1);
});

test('Security: Temporary files are cleaned up on successful write', async () => {
  const adapter = createTauriFileSystemAdapter<TestData>('test.json');
  await adapter.register(mock());

  const test_data: TestData[] = [{ id: '1', name: 'test', value: 42 }];
  await adapter.save(test_data, { added: test_data, modified: [], removed: [] });

  // Check that no temporary files remain
  const temp_files = Array.from(mock_file_system.keys()).filter(key =>
    key.includes('.tmp.')
  );

  expect(temp_files.length).toBe(0);
});

test('Security: Data cloning prevents callback mutation', async () => {
  let callback_data: any = null;
  const callback = mock(async (data: any) => {
    callback_data = data;
    // Try to mutate the data
    if (callback_data?.items) {
      callback_data.items.push({ id: 'malicious', name: 'hacked', value: -1 });
    }
  });

  const adapter = createTauriFileSystemAdapter<TestData>('test.json');
  await adapter.register(callback);

  const original_data: TestData[] = [{ id: '1', name: 'test', value: 42 }];
  await adapter.save(original_data, { added: original_data, modified: [], removed: [] });

  // Load data again to verify it wasn't mutated
  const loaded_data = await adapter.load();
  expect(loaded_data.items).toEqual(original_data);
  expect(loaded_data.items).not.toContain({ id: 'malicious', name: 'hacked', value: -1 });
});

test('Security: Race condition prevention in file operations', async () => {
  // This test simulates rapid concurrent access
  const adapter = createTauriFileSystemAdapter<TestData>('test.json');
  await adapter.register(mock());

  const operations: Promise<void>[] = [];

  // Simulate multiple concurrent save operations
  for (let i = 0; i < 5; i++) {
    const data: TestData[] = [{ id: `${i}`, name: `test${i}`, value: i }];
    operations.push(
      adapter.save(data, { added: data, modified: [], removed: [] })
    );
  }

  // All operations should complete without corruption
  await Promise.all(operations);

  // The file should contain valid data (the last successful write)
  const final_data = await adapter.load();
  expect(Array.isArray(final_data.items)).toBe(true);
  expect(final_data.items?.length).toBe(1);
});
