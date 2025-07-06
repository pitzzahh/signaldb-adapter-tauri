import { Collection, type PersistenceAdapter } from '@signaldb/core';
import { test, expect, beforeEach, afterEach, describe, mock } from 'bun:test';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

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

// Mock the Tauri filesystem module
mock.module('@tauri-apps/plugin-fs', () => ({
  BaseDirectory,
  exists: mock_exists,
  readFile: mock_read_file,
  writeFile: mock_write_file,
  remove: mock_remove
}));

// Now import our adapter after mocking
import { createTauriFileSystemAdapter } from '../src/index';

// Utility function for formatted table output
function formatPerformanceTable(title: string, data: Array<{ label: string; value: string | number; unit?: string }>) {
  console.log(`\n┌─ ${title} ─${'─'.repeat(Math.max(50 - title.length, 0))}┐`);

  data.forEach(({ label, value, unit = '' }) => {
    const labelPadded = label.padEnd(25);
    const valueStr = typeof value === 'number' ? value.toFixed(2) : value.toString();
    const valueWithUnit = unit ? `${valueStr} ${unit}` : valueStr;
    console.log(`│ ${labelPadded} │ ${valueWithUnit.padStart(20)} │`);
  });

  console.log(`└${'─'.repeat(53)}┘`);
}

function formatScalingTable(title: string, results: Array<{ size: number; time: number; avgTime: number; throughput?: number }>) {
  console.log(`\n┌─ ${title} ─${'─'.repeat(Math.max(70 - title.length, 0))}┐`);
  console.log('│ Size │    Total (ms) │   Avg (ms)   │ Throughput (items/sec) │');
  console.log('├──────┼───────────────┼──────────────┼────────────────────────┤');

  results.forEach(result => {
    const size = result.size.toString().padStart(4);
    const total = result.time.toFixed(0).padStart(11);
    const avg = result.avgTime.toFixed(3).padStart(10);
    const throughput = result.throughput ? result.throughput.toFixed(1).padStart(18) : 'N/A'.padStart(18);
    console.log(`│ ${size} │ ${total} │ ${avg} │ ${throughput} │`);
  });

  console.log(`└${'─'.repeat(73)}┘`);
}

interface TestData {
  id: string;
  name: string;
  data: string;
  timestamp?: number;
}

interface NestedTestData {
  id: string;
  user: {
    name: string;
    email: string;
    profile: {
      age: number;
      preferences: {
        theme: string;
        notifications: boolean;
        settings: Record<string, any>;
      };
    };
  };
  metadata: {
    created: number;
    updated: number;
    tags: string[];
    stats: {
      views: number;
      likes: number;
      shares: number;
    };
  };
  content: {
    title: string;
    body: string;
    attachments: Array<{
      type: string;
      url: string;
      size: number;
    }>;
  };
}

class PerformanceTester {
  private adapter: PersistenceAdapter<TestData, unknown>;
  private collection: Collection<TestData>;
  private testFileName: string;

  constructor(testFileName: string, encrypted = false) {
    this.testFileName = testFileName;
    this.adapter = createTauriFileSystemAdapter<TestData>(testFileName, {
      encrypt: encrypted ? this.encrypt : undefined,
      decrypt: encrypted ? this.decrypt : undefined
    });

    this.collection = new Collection<TestData>({ persistence: this.adapter });
  }

  async initialize(): Promise<void> {
    await this.adapter.register(() => { });
  }

  async cleanup(): Promise<void> {
    try {
      const fileExists = await mock_exists(this.testFileName, { baseDir: BaseDirectory.AppLocalData });
      if (fileExists) {
        await mock_remove(this.testFileName, { baseDir: BaseDirectory.AppLocalData });
      }
    } catch (error) {
      console.warn('Cleanup error:', error);
    }
  }

  async testInsertPerformance(itemCount: number): Promise<number> {
    const items = this.generateTestData(itemCount);

    const startTime = performance.now();

    for (const item of items) {
      await this.collection.insert(item);
    }

    const endTime = performance.now();
    return endTime - startTime;
  }

  async testBulkInsertPerformance(itemCount: number): Promise<number> {
    const items = this.generateTestData(itemCount);

    const startTime = performance.now();

    // Insert all items in sequence
    for (const item of items) {
      await this.collection.insert(item);
    }

    const endTime = performance.now();
    return endTime - startTime;
  }

  async testUpdatePerformance(itemCount: number): Promise<number> {
    // First insert some data
    const items = this.generateTestData(itemCount);
    for (const item of items) {
      await this.collection.insert(item);
    }

    const startTime = performance.now();

    // Update all items
    for (let i = 0; i < itemCount; i++) {
      this.collection.updateOne(
        { id: `item-${i}` },
        { $set: { name: `Updated Item ${i}`, timestamp: Date.now() } }
      );
    }

    const endTime = performance.now();
    return endTime - startTime;
  }

  async testDeletePerformance(itemCount: number): Promise<number> {
    // First insert some data
    const items = this.generateTestData(itemCount);
    for (const item of items) {
      await this.collection.insert(item);
    }

    const startTime = performance.now();

    // Delete all items
    for (let i = 0; i < itemCount; i++) {
      this.collection.removeOne({ id: `item-${i}` });
    }

    const endTime = performance.now();
    return endTime - startTime;
  }

  async testLoadPerformance(): Promise<{ loadTime: number; itemCount: number }> {
    const startTime = performance.now();

    const items = this.collection.find({}).fetch();

    const endTime = performance.now();
    return { loadTime: endTime - startTime, itemCount: items.length };
  }

  async testQueryPerformance(itemCount: number): Promise<number> {
    // First insert some data
    const items = this.generateTestData(itemCount);
    for (const item of items) {
      await this.collection.insert(item);
    }

    const startTime = performance.now();

    // Perform various queries
    this.collection.find({ name: { $regex: /Item 5/ } }).fetch();
    this.collection.find({ id: { $in: ['item-1', 'item-5', 'item-10'] } }).fetch();
    this.collection.find({}).fetch().slice(0, 10);

    const endTime = performance.now();
    return endTime - startTime;
  }

  async testMemoryUsage(itemCount: number): Promise<{ beforeMB: number; afterMB: number; deltaMB: number }> {
    const getMemoryUsage = () => {
      if (typeof process !== 'undefined' && process.memoryUsage) {
        return process.memoryUsage().heapUsed / 1024 / 1024;
      }
      return 0; // Fallback for environments without process.memoryUsage
    };

    const beforeMB = getMemoryUsage();

    const items = this.generateTestData(itemCount);
    for (const item of items) {
      await this.collection.insert(item);
    }

    const afterMB = getMemoryUsage();
    const deltaMB = afterMB - beforeMB;

    return { beforeMB, afterMB, deltaMB };
  }

  private generateTestData(count: number): TestData[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`,
      name: `Test Item ${i}`,
      data: 'x'.repeat(100), // 100 character string
      timestamp: Date.now() + i
    }));
  }

  private async encrypt<T>(data: T): Promise<string> {
    // Simple encryption for testing
    return btoa(JSON.stringify(data));
  }

  private async decrypt<T>(encrypted: string): Promise<T> {
    return JSON.parse(atob(encrypted));
  }
}

class NestedPerformanceTester {
  private adapter: PersistenceAdapter<NestedTestData, unknown>;
  private collection: Collection<NestedTestData>;
  private testFileName: string;

  constructor(testFileName: string, encrypted = false) {
    this.testFileName = testFileName;
    this.adapter = createTauriFileSystemAdapter<NestedTestData>(testFileName, {
      encrypt: encrypted ? this.encrypt : undefined,
      decrypt: encrypted ? this.decrypt : undefined
    });

    this.collection = new Collection<NestedTestData>({ persistence: this.adapter });
  }

  async initialize(): Promise<void> {
    await this.adapter.register(() => { });
  }

  async cleanup(): Promise<void> {
    try {
      const fileExists = await mock_exists(this.testFileName, { baseDir: BaseDirectory.AppLocalData });
      if (fileExists) {
        await mock_remove(this.testFileName, { baseDir: BaseDirectory.AppLocalData });
      }
    } catch (error) {
      console.warn('Cleanup error:', error);
    }
  }

  async testNestedInsertPerformance(itemCount: number): Promise<number> {
    const items = this.generateNestedTestData(itemCount);

    const startTime = performance.now();

    for (const item of items) {
      await this.collection.insert(item);
    }

    const endTime = performance.now();
    return endTime - startTime;
  }

  async testNestedQueryPerformance(itemCount: number): Promise<number> {
    // First insert some data
    const items = this.generateNestedTestData(itemCount);
    for (const item of items) {
      await this.collection.insert(item);
    }

    const startTime = performance.now();

    // Perform various nested queries
    this.collection.find({ 'user.name': { $regex: /User 5/ } }).fetch();
    this.collection.find({ 'user.profile.age': { $gte: 25, $lte: 35 } }).fetch();
    this.collection.find({ 'metadata.tags': { $in: ['important', 'urgent'] } }).fetch();
    this.collection.find({ 'metadata.stats.views': { $gt: 100 } }).fetch();
    this.collection.find({ 'user.profile.preferences.theme': 'dark' }).fetch();

    const endTime = performance.now();
    return endTime - startTime;
  }

  async testNestedUpdatePerformance(itemCount: number): Promise<number> {
    // First insert some data
    const items = this.generateNestedTestData(itemCount);
    for (const item of items) {
      await this.collection.insert(item);
    }

    const startTime = performance.now();

    // Update nested fields
    for (let i = 0; i < Math.min(itemCount, 100); i++) {
      this.collection.updateOne(
        { id: `nested-item-${i}` },
        {
          $set: {
            'user.profile.age': 30 + i,
            'metadata.updated': Date.now(),
            'metadata.stats.views': (i + 1) * 10
          }
        }
      );
    }

    const endTime = performance.now();
    return endTime - startTime;
  }

  private generateNestedTestData(count: number): NestedTestData[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `nested-item-${i}`,
      user: {
        name: `User ${i}`,
        email: `user${i}@example.com`,
        profile: {
          age: 20 + (i % 50),
          preferences: {
            theme: i % 2 === 0 ? 'dark' : 'light',
            notifications: i % 3 === 0,
            settings: {
              language: 'en',
              timezone: 'UTC',
              autoSave: true,
              customField: `custom-${i}`,
              nestedSettings: {
                level1: {
                  level2: {
                    value: `deep-value-${i}`
                  }
                }
              }
            }
          }
        }
      },
      metadata: {
        created: Date.now() - (i * 1000),
        updated: Date.now(),
        tags: i % 5 === 0 ? ['important', 'urgent'] : ['normal', `tag-${i % 3}`],
        stats: {
          views: Math.floor(Math.random() * 1000),
          likes: Math.floor(Math.random() * 100),
          shares: Math.floor(Math.random() * 50)
        }
      },
      content: {
        title: `Content Title ${i}`,
        body: `This is the body content for item ${i}. `.repeat(10), // Longer content
        attachments: Array.from({ length: i % 3 + 1 }, (_, j) => ({
          type: j % 2 === 0 ? 'image' : 'document',
          url: `https://example.com/file-${i}-${j}`,
          size: Math.floor(Math.random() * 1000000)
        }))
      }
    }));
  }

  private async encrypt<T>(data: T): Promise<string> {
    // Simple encryption for testing
    return btoa(JSON.stringify(data));
  }

  private async decrypt<T>(encrypted: string): Promise<T> {
    return JSON.parse(atob(encrypted));
  }
}

describe('Performance Tests', () => {
  let tester: PerformanceTester;
  let encryptedTester: PerformanceTester;
  let nestedTester: NestedPerformanceTester;

  beforeEach(async () => {
    // Clear the mock filesystem before each test
    mock_file_system.clear();

    tester = new PerformanceTester('perf-test.json');
    encryptedTester = new PerformanceTester('perf-test-encrypted.json', true);
    nestedTester = new NestedPerformanceTester('perf-nested.json');

    await tester.initialize();
    await encryptedTester.initialize();
    await nestedTester.initialize();
  });

  afterEach(async () => {
    await tester.cleanup();
    await encryptedTester.cleanup();
    await nestedTester.cleanup();

    // Clear the mock filesystem after each test
    mock_file_system.clear();
  });

  test('Insert performance - small dataset (100 items)', async () => {
    const itemCount = 100;
    const insertTime = await tester.testInsertPerformance(itemCount);

    formatPerformanceTable('Insert Performance - Small Dataset', [
      { label: 'Items processed', value: itemCount },
      { label: 'Total time', value: insertTime, unit: 'ms' },
      { label: 'Average per insert', value: insertTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (insertTime / 1000), unit: 'items/sec' }
    ]);

    // Performance assertion - should complete within reasonable time
    expect(insertTime).toBeLessThan(5000); // 5 seconds max for 100 items
  });

  test('Insert performance - medium dataset (100 items)', async () => {
    const itemCount = 100;
    const insertTime = await tester.testInsertPerformance(itemCount);

    formatPerformanceTable('Insert Performance - Medium Dataset', [
      { label: 'Items processed', value: itemCount },
      { label: 'Total time', value: insertTime, unit: 'ms' },
      { label: 'Average per insert', value: insertTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (insertTime / 1000), unit: 'items/sec' }
    ]);

    // Performance assertion
    expect(insertTime).toBeLessThan(10000); // 10 seconds max for 100 items
  });

  test('Load performance after inserting data', async () => {
    // First insert some data
    await tester.testInsertPerformance(50);

    const { loadTime, itemCount } = await tester.testLoadPerformance();

    formatPerformanceTable('Load Performance', [
      { label: 'Items loaded', value: itemCount },
      { label: 'Total time', value: loadTime, unit: 'ms' },
      { label: 'Average per item', value: loadTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (loadTime / 1000), unit: 'items/sec' }
    ]);

    expect(itemCount).toBe(50);
    expect(loadTime).toBeLessThan(2000); // 2 seconds max to load 50 items
  });

  test('Update performance', async () => {
    const itemCount = 50;
    const updateTime = await tester.testUpdatePerformance(itemCount);

    formatPerformanceTable('Update Performance', [
      { label: 'Items updated', value: itemCount },
      { label: 'Total time', value: updateTime, unit: 'ms' },
      { label: 'Average per update', value: updateTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (updateTime / 1000), unit: 'updates/sec' }
    ]);

    expect(updateTime).toBeLessThan(5000); // 5 seconds max for 50 updates
  });

  test('Delete performance', async () => {
    const itemCount = 50;
    const deleteTime = await tester.testDeletePerformance(itemCount);

    formatPerformanceTable('Delete Performance', [
      { label: 'Items deleted', value: itemCount },
      { label: 'Total time', value: deleteTime, unit: 'ms' },
      { label: 'Average per delete', value: deleteTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (deleteTime / 1000), unit: 'deletes/sec' }
    ]);

    expect(deleteTime).toBeLessThan(5000); // 5 seconds max for 50 deletes
  });

  test('Query performance with various operations', async () => {
    const itemCount = 100;
    const queryTime = await tester.testQueryPerformance(itemCount);

    formatPerformanceTable('Query Performance', [
      { label: 'Dataset size', value: itemCount, unit: 'items' },
      { label: 'Query operations', value: 3 },
      { label: 'Total time', value: queryTime, unit: 'ms' },
      { label: 'Average per query', value: queryTime / 3, unit: 'ms' }
    ]);

    expect(queryTime).toBeLessThan(3000); // 3 seconds max for query operations
  });

  test('Memory usage during bulk operations', async () => {
    const itemCount = 100;
    const memoryStats = await tester.testMemoryUsage(itemCount);

    formatPerformanceTable('Memory Usage Analysis', [
      { label: 'Items processed', value: itemCount },
      { label: 'Memory before', value: memoryStats.beforeMB, unit: 'MB' },
      { label: 'Memory after', value: memoryStats.afterMB, unit: 'MB' },
      { label: 'Memory delta', value: memoryStats.deltaMB, unit: 'MB' },
      { label: 'Memory per item', value: memoryStats.deltaMB / itemCount, unit: 'MB' }
    ]);

    // Memory should not grow excessively (allow for reasonable overhead)
    expect(memoryStats.deltaMB).toBeLessThan(50); // Less than 50MB increase
  });

  test('Encrypted vs unencrypted performance comparison', async () => {
    const itemCount = 50;

    const unencryptedTime = await tester.testInsertPerformance(itemCount);
    const encryptedTime = await encryptedTester.testInsertPerformance(itemCount);

    const overhead = ((encryptedTime / unencryptedTime - 1) * 100);

    formatPerformanceTable('Encryption Performance Comparison', [
      { label: 'Items processed', value: itemCount },
      { label: 'Unencrypted time', value: unencryptedTime, unit: 'ms' },
      { label: 'Encrypted time', value: encryptedTime, unit: 'ms' },
      { label: 'Encryption overhead', value: overhead, unit: '%' },
      { label: 'Performance ratio', value: `1:${(encryptedTime / unencryptedTime).toFixed(1)}` }
    ]);

    // Encrypted operations should be reasonably close to unencrypted
    expect(encryptedTime).toBeLessThan(unencryptedTime * 5); // Max 5x slower
  });

  test('Performance degradation with dataset size', async () => {
    const sizes = [25, 50, 100];
    const results: Array<{ size: number; time: number; avgTime: number; throughput: number }> = [];

    for (const size of sizes) {
      // Clear filesystem for each test
      mock_file_system.clear();

      const cleanTester = new PerformanceTester(`perf-scale-${size}.json`);
      await cleanTester.initialize();

      const time = await cleanTester.testInsertPerformance(size);
      const avgTime = time / size;
      const throughput = size / (time / 1000);
      results.push({ size, time, avgTime, throughput });

      await cleanTester.cleanup();
    }

    formatScalingTable('Performance Scaling Analysis', results);

    // Performance should not degrade exponentially
    const firstAvg = results[0].avgTime;
    const lastAvg = results[results.length - 1].avgTime;

    expect(lastAvg).toBeLessThan(firstAvg * 10); // Max 10x degradation
  });

  // Medium dataset tests
  test('Medium dataset performance - 75 items', async () => {
    const itemCount = 75;
    const insertTime = await tester.testInsertPerformance(itemCount);

    formatPerformanceTable('Medium Dataset Performance (75 items)', [
      { label: 'Items processed', value: itemCount },
      { label: 'Total time', value: insertTime, unit: 'ms' },
      { label: 'Average per insert', value: insertTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (insertTime / 1000), unit: 'items/sec' }
    ]);

    // Performance assertion - should complete within reasonable time
    expect(insertTime).toBeLessThan(8000); // 8 seconds max for 75 items
  });

  test('Large dataset performance - 100 items', async () => {
    const itemCount = 100;
    const insertTime = await tester.testInsertPerformance(itemCount);

    formatPerformanceTable('Large Dataset Performance (100 items)', [
      { label: 'Items processed', value: itemCount },
      { label: 'Total time', value: insertTime, unit: 'ms' },
      { label: 'Average per insert', value: insertTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (insertTime / 1000), unit: 'items/sec' }
    ]);

    // Performance assertion - should complete within reasonable time
    expect(insertTime).toBeLessThan(10000); // 10 seconds max for 100 items
  });

  test('Large dataset load performance - 100 items', async () => {
    // First insert the data
    await tester.testInsertPerformance(100);

    const { loadTime, itemCount } = await tester.testLoadPerformance();

    formatPerformanceTable('Large Dataset Load Performance', [
      { label: 'Items loaded', value: itemCount },
      { label: 'Total time', value: loadTime, unit: 'ms' },
      { label: 'Average per item', value: loadTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (loadTime / 1000), unit: 'items/sec' }
    ]);

    expect(itemCount).toBe(100);
    expect(loadTime).toBeLessThan(3000); // 3 seconds max to load 100 items
  });

  // Nested data structure tests
  test('Nested data structure performance - 50 items', async () => {
    const itemCount = 50;
    const insertTime = await nestedTester.testNestedInsertPerformance(itemCount);

    formatPerformanceTable('Nested Data Performance (50 items)', [
      { label: 'Items processed', value: itemCount },
      { label: 'Total time', value: insertTime, unit: 'ms' },
      { label: 'Average per insert', value: insertTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (insertTime / 1000), unit: 'items/sec' }
    ]);

    expect(insertTime).toBeLessThan(15000); // 15 seconds max for 50 nested items
  });

  test('Nested data structure performance - 100 items', async () => {
    const itemCount = 100;
    const insertTime = await nestedTester.testNestedInsertPerformance(itemCount);

    formatPerformanceTable('Nested Data Performance (100 items)', [
      { label: 'Items processed', value: itemCount },
      { label: 'Total time', value: insertTime, unit: 'ms' },
      { label: 'Average per insert', value: insertTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (insertTime / 1000), unit: 'items/sec' }
    ]);

    expect(insertTime).toBeLessThan(30000); // 30 seconds max for 100 nested items
  });

  test('Nested data query performance', async () => {
    const itemCount = 50;
    const queryTime = await nestedTester.testNestedQueryPerformance(itemCount);

    formatPerformanceTable('Nested Data Query Performance', [
      { label: 'Dataset size', value: itemCount, unit: 'items' },
      { label: 'Query operations', value: 5 },
      { label: 'Total time', value: queryTime, unit: 'ms' },
      { label: 'Average per query', value: queryTime / 5, unit: 'ms' }
    ]);

    expect(queryTime).toBeLessThan(10000); // 10 seconds max for nested queries
  });

  test('Nested data update performance', async () => {
    const itemCount = 50;
    const updateTime = await nestedTester.testNestedUpdatePerformance(itemCount);

    formatPerformanceTable('Nested Data Update Performance', [
      { label: 'Items updated', value: itemCount },
      { label: 'Total time', value: updateTime, unit: 'ms' },
      { label: 'Average per update', value: updateTime / itemCount, unit: 'ms' },
      { label: 'Throughput', value: itemCount / (updateTime / 1000), unit: 'updates/sec' }
    ]);

    expect(updateTime).toBeLessThan(10000); // 10 seconds max for nested updates
  });

  test('Memory usage with nested dataset', async () => {
    const getMemoryUsage = () => {
      if (typeof process !== 'undefined' && process.memoryUsage) {
        return process.memoryUsage().heapUsed / 1024 / 1024;
      }
      return 0;
    };

    const beforeMB = getMemoryUsage();

    const itemCount = 75;
    await nestedTester.testNestedInsertPerformance(itemCount);

    const afterMB = getMemoryUsage();
    const deltaMB = afterMB - beforeMB;

    formatPerformanceTable('Nested Data Memory Usage', [
      { label: 'Items processed', value: itemCount },
      { label: 'Memory before', value: beforeMB, unit: 'MB' },
      { label: 'Memory after', value: afterMB, unit: 'MB' },
      { label: 'Memory delta', value: deltaMB, unit: 'MB' },
      { label: 'Memory per item', value: deltaMB / itemCount, unit: 'MB' }
    ]);

    // Memory should not grow excessively (allow for reasonable overhead with nested data)
    expect(deltaMB).toBeLessThan(100); // Less than 100MB increase for nested data
  });

  test('Scaling comparison: simple vs nested data', async () => {
    const itemCount = 50;

    // Test simple data
    mock_file_system.clear();
    const simpleTester = new PerformanceTester('simple-comparison.json');
    await simpleTester.initialize();
    const simpleTime = await simpleTester.testInsertPerformance(itemCount);
    await simpleTester.cleanup();

    // Test nested data
    mock_file_system.clear();
    const nestedComparisonTester = new NestedPerformanceTester('nested-comparison.json');
    await nestedComparisonTester.initialize();
    const nestedTime = await nestedComparisonTester.testNestedInsertPerformance(itemCount);
    await nestedComparisonTester.cleanup();

    const overhead = ((nestedTime / simpleTime - 1) * 100);

    formatPerformanceTable('Simple vs Nested Data Comparison', [
      { label: 'Items processed', value: itemCount },
      { label: 'Simple data time', value: simpleTime, unit: 'ms' },
      { label: 'Nested data time', value: nestedTime, unit: 'ms' },
      { label: 'Nested overhead', value: overhead, unit: '%' },
      { label: 'Performance ratio', value: `1:${(nestedTime / simpleTime).toFixed(1)}` }
    ]);

    // Nested data should be slower but not excessively
    expect(nestedTime).toBeLessThan(simpleTime * 10); // Max 10x slower for nested data
  });

  test('Scaling test with performance tracking', async () => {
    const sizes = [25, 50, 75, 100];
    const results: Array<{ size: number; time: number; avgTime: number; throughput: number }> = [];

    for (const size of sizes) {
      mock_file_system.clear();

      const scaleTester = new PerformanceTester(`scale-${size}.json`);
      await scaleTester.initialize();

      const time = await scaleTester.testInsertPerformance(size);
      const avgTime = time / size;
      const throughput = size / (time / 1000); // items per second

      results.push({ size, time, avgTime, throughput });

      await scaleTester.cleanup();
    }

    formatScalingTable('Comprehensive Scaling Analysis', results);

    // Check that throughput doesn't degrade too much
    const firstThroughput = results[0].throughput;
    const lastThroughput = results[results.length - 1].throughput;

    // Throughput should not degrade by more than 90%
    expect(lastThroughput).toBeGreaterThan(firstThroughput * 0.1);
  });
});