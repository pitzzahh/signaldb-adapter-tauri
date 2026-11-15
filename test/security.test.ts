import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import { adapter as createAdapter } from '../src/index';

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

// Mock the Tauri fs plugin (mock only the filesystem functions, keep BaseDirectory as-is)
mock.module('@tauri-apps/plugin-fs', () => ({
  BaseDirectory,
  exists: mock_exists,
  readFile: mock_read_file,
  readDir: mock_read_dir,
  writeFile: mock_write_file,
  remove: mock_remove,
  rename: mock_rename_fn,
}));

// Global warning suppression for cleaner test output
let originalConsoleWarn: typeof console.warn;

beforeEach(() => {
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
      createAdapter<TestData>(filename);
    }).toThrow();
  }
});

test('Security: Empty or invalid filename throws error', () => {
  const invalid_filenames = ['', null as any, undefined as any, 123 as any];

  for (const filename of invalid_filenames) {
    expect(() => {
      createAdapter<TestData>(filename);
    }).toThrow('Filename must be a non-empty string');
  }
});

test('Security: Warning when no encryption provided', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);

  createAdapter<TestData>('test.json');

  expect(warnings.some(w => w.includes('[SECURITY] No encryption for'))).toBe(true);

  console.warn = originalWarn;
});

test('Security: Enforce encryption throws when encrypt/decrypt missing', () => {
  expect(() => {
    createAdapter<TestData>('test.json', {
      security: { enforceEncryption: true }
    });
  }).toThrow('Encryption enforced but encrypt/decrypt not provided.');
});

test('Security: Enforce encryption passes with both encrypt/decrypt', () => {
  const encrypt = mock(async (data: any) => JSON.stringify(data));
  const decrypt = mock(async (data: string) => JSON.parse(data));

  expect(() => {
    createAdapter<TestData>('test.json', {
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
  mock_file_system.set(`${BaseDirectory.AppLocalData}/test.json`, tampered_data);

  const adapter = createAdapter<TestData>('test.json', {
    encrypt,
    decrypt,
    security: { allowPlaintextFallback: false }
  });

  await expect(adapter.readAll()).rejects.toThrow('Decryption failed, plaintext fallback disabled');
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
  mock_file_system.set(`${BaseDirectory.AppLocalData}/test.json`, corrupted_data);

  const adapter = createAdapter<TestData>('test.json', {
    security: {
      validateDecryptedData: true,
      dataValidator
    }
  });

  await expect(adapter.readAll()).rejects.toThrow('Data failed validation');
});

test('Security: Backup files are created on write when enabled', async () => {
  // Set up existing data
  const existing_data = new TextEncoder().encode(JSON.stringify([
    { id: '1', name: 'existing', value: 1 }
  ]));
  mock_file_system.set(`${BaseDirectory.AppLocalData}/test.json`, existing_data);

  const adapter = createAdapter<TestData>('test.json', {
    security: { createBackups: true }
  });
  await adapter.setup();

  await adapter.insert([{ id: '2', name: 'new', value: 2 }]);

  // Check that a backup file was created
  const backup_files = Array.from(mock_file_system.keys()).filter(key =>
    key.includes('test.json.backup.')
  );

  expect(backup_files.length).toBe(1);
});

test('Security: Backup files are NOT created by default (for sync scenarios)', async () => {
  // Set up existing data
  const existing_data = new TextEncoder().encode(JSON.stringify([
    { id: '1', name: 'existing', value: 1 }
  ]));
  mock_file_system.set(`${BaseDirectory.AppLocalData}/test.json`, existing_data);

  const adapter = createAdapter<TestData>('test.json');
  await adapter.setup();

  await adapter.insert([{ id: '2', name: 'new', value: 2 }]);

  // Check that NO backup files were created
  const backup_files = Array.from(mock_file_system.keys()).filter(key =>
    key.includes('test.json.backup.')
  );

  expect(backup_files.length).toBe(0);
});

test('Security: Temporary files are cleaned up on successful write', async () => {
  const adapter = createAdapter<TestData>('test.json');
  await adapter.setup();

  await adapter.insert([{ id: '1', name: 'test', value: 42 }]);

  // Check that no temporary files remain
  const temp_files = Array.from(mock_file_system.keys()).filter(key =>
    key.includes('.tmp.')
  );

  expect(temp_files.length).toBe(0);
});

test('Security: Mutating read results does not corrupt the store', async () => {
  const adapter = createAdapter<TestData>('test.json');
  await adapter.setup();

  const original_data: TestData[] = [{ id: '1', name: 'test', value: 42 }];
  await adapter.insert(original_data);

  // Mutate what readAll handed back
  const read = await adapter.readAll();
  read.push({ id: 'malicious', name: 'hacked', value: -1 });
  read[0].name = 'mutated';

  // The store is unaffected: every read parses fresh bytes.
  expect(await adapter.readAll()).toEqual(original_data);
});

test('Security: Concurrent writes do not corrupt the file', async () => {
  const adapter = createAdapter<TestData>('test.json');
  await adapter.setup();

  // Simulate multiple concurrent write operations
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    adapter.insert([{ id: `${i}`, name: `test${i}`, value: i }])
  ));

  // All operations should complete with every item present exactly once.
  const final_data = await adapter.readAll();
  expect(final_data.length).toBe(5);
  expect(new Set(final_data.map((item) => item.id)).size).toBe(5);
});
